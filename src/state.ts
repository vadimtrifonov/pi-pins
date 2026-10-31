import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export const LIMIT = 3;
export interface PinSource { id: string; text: string; entry: SessionMessageEntry }
/** Messages listed under one session: the current session in Session, or the session where pins were written in All. */
export interface PinGroup { id: string; name?: string; pins: PinSource[] }
/** The session where a pinned message was written, as recorded when it was pinned. */
export interface Origin { id: string; name?: string }
/** A pinned message, copied so that it outlives its sessions. */
export interface Pin { entry: SessionMessageEntry; origin: Origin }

/** Forks copy entries with their IDs and timestamps, so together they identify a message in every session that contains it. */
export const identity = (entry: { id: string; timestamp: string }) => `${entry.id}@${entry.timestamp}`;

/** Pinnable entries are user messages, assistant answers, and user-run shell commands. */
export function sourceFromEntry(entry: SessionEntry): PinSource | undefined {
  if (entry.type !== "message") return;
  const message = entry.message;
  let text: string;
  if (message.role === "bashExecution") text = `${message.command}\n${message.output}`;
  else if (message.role === "user" || message.role === "assistant") {
    text = typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join(message.role === "assistant" ? "\n\n" : "\n");
    if (!text.trim() && message.role === "assistant") text = message.errorMessage ?? "";
  } else return;
  if (text.trim()) return { id: entry.id, text, entry };
}

export function sourcesOnBranch(branch: readonly SessionEntry[]): PinSource[] {
  return branch.flatMap(entry => { const source = sourceFromEntry(entry); return source ? [source] : []; });
}

/**
 * The saved copy keeps text blocks only; images and thinking stay in the session.
 * Answers keep the fields Pi requires plus the error, without provider metadata such as diagnostics.
 */
export function pinnedCopy(entry: SessionMessageEntry): SessionMessageEntry {
  const message = entry.message;
  if (message.role === "assistant") {
    const { api, provider, model, usage, stopReason, errorMessage, timestamp } = message;
    const content = message.content.filter(block => block.type === "text");
    return { ...entry, message: { role: "assistant", content, api, provider, model, usage, stopReason, errorMessage, timestamp } };
  }
  if (message.role !== "user" || typeof message.content === "string") return entry;
  return { ...entry, message: { ...message, content: message.content.filter(block => block.type === "text") } };
}

const time = (source: PinSource) => Date.parse(source.entry.timestamp) || 0;

/**
 * Session rows: the current branch in order, with this session's pinned messages from other branches placed by time.
 * The shelf shows the pinned rows in the same order.
 */
export function sessionSources(entries: readonly SessionEntry[], branch: readonly SessionEntry[], pinned: ReadonlySet<string>): PinSource[] {
  const onBranch = new Set(branch.map(entry => entry.id));
  const elsewhere = sourcesOnBranch(entries.filter(entry => entry.type === "message" && !onBranch.has(entry.id) && pinned.has(identity(entry))))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Stable: branch order survives equal timestamps.
  return [...sourcesOnBranch(branch), ...elsewhere].sort((a, b) => time(a) - time(b));
}

/** All: every pin, grouped by the session where its message was written. */
export function originGroups(pins: readonly Pin[]): PinGroup[] {
  const groups = new Map<string, PinGroup>();
  for (const pin of pins) {
    const source = sourceFromEntry(pin.entry);
    if (!source) continue;
    let group = groups.get(pin.origin.id);
    if (!group) groups.set(pin.origin.id, group = { id: pin.origin.id, pins: [] });
    group.name = pin.origin.name ?? group.name;
    group.pins.push(source);
  }
  return [...groups.values()];
}

// A change that alters nothing returns its input, and the store then skips the write.

/** Adds a pin unless its message is already pinned, optionally unpinning the message it replaces. */
export function addPin(pins: Pin[], pin: Pin, replacing?: string): Pin[] {
  const key = identity(pin.entry);
  if (pins.some(existing => identity(existing.entry) === key)) return pins;
  return [...replacing ? pins.filter(existing => identity(existing.entry) !== replacing) : pins, pin];
}

export function removePin(pins: Pin[], key: string): Pin[] {
  const kept = pins.filter(pin => identity(pin.entry) !== key);
  return kept.length === pins.length ? pins : kept;
}

/** Records a session's new name on the pins written in it. */
export function renameOrigin(pins: Pin[], id: string, name: string | undefined): Pin[] {
  if (!pins.some(pin => pin.origin.id === id && pin.origin.name !== name)) return pins;
  return pins.map(pin => pin.origin.id === id ? { ...pin, origin: name === undefined ? { id } : { id, name } } : pin);
}
