import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, migrateSessionEntries, parseSessionEntries, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { PIN_STATE, pinnedSources, type PinGroup } from "./state.ts";

// Parse and migrate in memory to keep discovery read-only.
// SessionManager.open() can rewrite files: it migrates old versions and appends a missing final newline.
// Match Pi's tolerance: skip malformed lines, let later duplicate IDs win,
// use the last entry as the tip, and stop at a missing ancestor.
export function savedPins(content: string): PinGroup {
  const entries = parseSessionEntries(content);
  const header = entries[0];
  if (header?.type !== "session" || typeof header.id !== "string") throw new Error("Unsupported session header");
  migrateSessionEntries(entries);
  const byId = new Map<string, SessionEntry>();
  let tip: SessionEntry | undefined;
  for (const entry of entries) {
    if (entry.type === "session") continue;
    byId.set(entry.id, entry);
    tip = entry;
  }
  const branch: SessionEntry[] = [], seen = new Set<string>();
  for (let entry = tip?.id ? tip : undefined; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    if (seen.has(entry.id)) throw new Error("Cyclic session tree");
    seen.add(entry.id);
    branch.push(entry);
  }
  const info = entries.findLast(entry => entry.type === "session_info");
  const name = info?.type === "session_info" && typeof info.name === "string" ? info.name.trim() || undefined : undefined;
  return { id: header.id, name, current: false, pins: pinnedSources(branch.reverse()) };
}

// Pi writes each entry as compact JSON. Message text that mentions the marker cannot
// match: inside a JSON string, its quotes are escaped.
const MARKER = Buffer.from(`"customType":${JSON.stringify(PIN_STATE)}`);

/** Streams session bytes for the pin-state customType marker without decoding JSON. */
export async function containsPinState(chunks: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<boolean> {
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    if (data.includes(MARKER)) return true;
    carry = data.subarray(Math.max(0, data.length - MARKER.length + 1));
  }
  return false;
}

async function directoryEntries(dir: string) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** Session files in Pi's default session root and the current session directory, most recently modified first. */
async function sessionFiles(ctx: ExtensionContext): Promise<string[]> {
  const root = join(getAgentDir(), "sessions");
  const dirs = [ctx.sessionManager.getSessionDir(), ...(await directoryEntries(root))
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(root, entry.name))];
  const paths = new Set<string>();
  for (const dir of dirs) {
    for (const entry of await directoryEntries(dir)) if (entry.name.endsWith(".jsonl")) paths.add(resolve(dir, entry.name));
  }
  const files = await Promise.all([...paths].map(async path => {
    try { const stats = await stat(path); return stats.isFile() ? { path, modified: stats.mtimeMs } : undefined; } catch { return undefined; }
  }));
  return files.filter(file => file !== undefined)
    .sort((a, b) => b.modified - a.modified || b.path.localeCompare(a.path)).map(file => file.path);
}

// Files containing the marker are read and parsed in full, with memory use proportional to file size.
export async function listSavedPins(ctx: ExtensionContext, signal: AbortSignal): Promise<PinGroup[]> {
  signal.throwIfAborted();
  const currentFile = ctx.sessionManager.getSessionFile();
  const excluded = currentFile ? resolve(currentFile) : undefined;
  const files = await sessionFiles(ctx);
  signal.throwIfAborted();
  const seen = new Set([ctx.sessionManager.getSessionId()]);
  const groups: PinGroup[] = [];
  let failed = 0;
  for (const path of files) {
    signal.throwIfAborted();
    if (path === excluded) continue;
    try {
      if (!await containsPinState(createReadStream(path, { highWaterMark: 1024 * 1024, signal }))) continue;
      const group = savedPins(await readFile(path, { encoding: "utf8", signal }));
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      if (group.pins.length) groups.push(group);
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed++;
    }
  }
  // A scan cancelled after its last read must not warn.
  signal.throwIfAborted();
  if (failed) ctx.ui.notify(`Could not read pins from ${failed} saved session${failed === 1 ? "" : "s"}.`, "warning");
  return groups;
}
