import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import type { Origin } from "./state.ts";

/**
 * Finds the session where a message was written. Forks copy messages with their timestamps, so a message
 * older than its session was inherited: follow parent sessions until one is not newer than the message.
 * A fork created in the same millisecond as a message it copies is named instead of its parent;
 * only forks made by code are that fast. If a parent cannot be read, the earliest readable session is named.
 */
export async function findOrigin(header: SessionHeader, name: string | undefined, timestamp: string): Promise<Origin> {
  const time = Date.parse(timestamp), seen = new Set([header.id]);
  let file: string | undefined;
  while (header.parentSession && time < Date.parse(header.timestamp)) {
    const parent = await readHeader(header.parentSession);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    file = header.parentSession;
    header = parent;
  }
  if (file) name = await readName(file);
  return name === undefined ? { id: header.id } : { id: header.id, name };
}

async function readHeader(path: string): Promise<SessionHeader | undefined> {
  try {
    const file = await open(path);
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
      const header = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]);
      return header?.type === "session" && typeof header.id === "string" && typeof header.timestamp === "string" ? header : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

// Pi writes each entry as compact JSON on its own line, starting with its type.
// Message text cannot match: quotes inside JSON strings are escaped.
const MARKER = Buffer.from('\n{"type":"session_info"');

/** The name set by the session's last session_info entry. Sessions can be hundreds of MB, so only those lines are parsed. */
async function readName(path: string): Promise<string | undefined> {
  let name: string | undefined;
  const take = (line: Buffer) => {
    try {
      const entry = JSON.parse(line.toString("utf8"));
      if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
    } catch {}
  };
  try {
    let carry: Buffer = Buffer.from("\n"); // The file start counts as a line start.
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
      const data = Buffer.concat([carry, chunk]);
      let from = 0, pending: Buffer | undefined;
      for (let at = data.indexOf(MARKER); at !== -1; at = data.indexOf(MARKER, from)) {
        const end = data.indexOf(0x0a, at + 1);
        if (end === -1) { pending = data.subarray(at); break; } // Finish the line with the next chunk.
        take(data.subarray(at + 1, end));
        from = end;
      }
      carry = pending ?? data.subarray(Math.max(from, data.length - MARKER.length + 1));
    }
    if (carry.subarray(0, MARKER.length).equals(MARKER)) take(carry.subarray(1));
  } catch {
    return undefined;
  }
  return name;
}
