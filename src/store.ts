import { randomUUID } from "node:crypto";
import { mkdirSync, watch } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { Pin } from "./state.ts";

const VERSION = 1;
const FILE = "pins.json";
const directory = () => join(getAgentDir(), "pins");
export const pinsPath = () => join(directory(), FILE);

/** Reads every pin; a missing file has none. Throws on an unknown format, so that format is never overwritten. */
export async function readPins(): Promise<Pin[]> {
  const path = pinsPath();
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let data: { version?: unknown; pins?: unknown } | undefined;
  try { data = JSON.parse(text); } catch {}
  if (data?.version !== VERSION || !Array.isArray(data.pins)) throw new Error(`Unsupported pins file: ${path}`);
  return data.pins as Pin[];
}

/**
 * Applies change to the current pins while holding a lock shared by all Pi processes, and returns the result.
 * Return the given array unchanged to leave the file untouched.
 */
export async function updatePins(change: (pins: Pin[]) => Pin[]): Promise<Pin[]> {
  const path = pinsPath();
  await mkdir(directory(), { recursive: true });
  // Ignore a compromised lock: the default handler throws from a timer and would crash Pi,
  // and a lock held for milliseconds becomes stale only after 10 s.
  const release = await lockfile.lock(path, {
    realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 500 }, onCompromised() {},
  });
  try {
    const pins = await readPins(), next = change(pins);
    if (next !== pins) await replace(path, `${JSON.stringify({ version: VERSION, pins: next }, null, 2)}\n`);
    return next;
  } finally {
    await release().catch(() => {});
  }
}

// Windows refuses to replace a file while another process has it open, for example while another Pi reads it.
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Readers see the old or the new file, never a partial one. */
async function replace(path: string, text: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    for (let delay = 10; ; delay *= 2) {
      try { return await rename(temp, path); }
      catch (error) {
        if (!BUSY.has((error as NodeJS.ErrnoException).code ?? "") || delay > 320) throw error;
        await sleep(delay);
      }
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface PinStore {
  read(): Promise<Pin[]>;
  update(change: (pins: Pin[]) => Pin[]): Promise<Pin[]>;
  watch(onChange: () => void): () => void;
}
/** Pins shared by all Pi processes of this user. */
export const pinStore: PinStore = { read: readPins, update: updatePins, watch: watchPins };

/** Calls onChange shortly after any process replaces the pins file. Returns a function that stops watching. */
export function watchPins(onChange: () => void): () => void {
  // Replacing the file ends a watch on the file itself, so watch its directory.
  mkdirSync(directory(), { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(directory(), (_event, filename) => {
    if (filename && filename !== FILE) return; // Skip temporary files and the lock.
    clearTimeout(timer);
    timer = setTimeout(onChange, 100);
  });
  const stop = () => { clearTimeout(timer); watcher.close(); };
  watcher.on("error", stop);
  return stop;
}
