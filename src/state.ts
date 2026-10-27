import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

// Keep this identifier stable to read existing pin snapshots.
export const PIN_STATE = "pins-review-state";
export const LIMIT = 3;
// Original entries are read-only UI provenance, never included in persisted snapshots.
export interface PinSource { id: string; text: string; entry: SessionMessageEntry }
export interface PinGroup { id: string; name?: string; pins: PinSource[]; current: boolean }

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
 * Sources of the latest pin snapshot in branch order, skipping pins whose entries are not on the branch.
 * The order of ids within a snapshot carries no meaning.
 */
export function pinnedSources(branch: readonly SessionEntry[]): PinSource[] {
  const entry = branch.findLast(e => e.type === "custom" && e.customType === PIN_STATE);
  if (!entry || entry.type !== "custom") return [];
  const data = entry.data as { version?: number; ids?: unknown } | undefined;
  if (data?.version !== 1 || !Array.isArray(data.ids) ||
      !data.ids.every(id => typeof id === "string") || new Set(data.ids).size !== data.ids.length) {
    throw new Error(`Invalid pin snapshot ${entry.id}`);
  }
  const ids = new Set(data.ids);
  return sourcesOnBranch(branch.filter(e => ids.has(e.id)));
}

export const pinsOnBranch = (branch: readonly SessionEntry[]): string[] => pinnedSources(branch).map(source => source.id);

export function addPin(ids: readonly string[], id: string, replacement?: string): string[] {
  if (ids.includes(id)) return [...ids];
  if (ids.length < LIMIT) return [...ids, id];
  if (!replacement || !ids.includes(replacement)) throw new Error("Choose a pin to replace");
  return ids.map(existing => existing === replacement ? id : existing);
}

export const snapshot = (ids: readonly string[]) => ({ version: 1, ids: [...ids] });
