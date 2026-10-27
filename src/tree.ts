import { stripVTControlCharacters } from "node:util";
import { TreeSelectorComponent, type SessionMessageEntry, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { PinItem } from "./browser.ts";
import type { PinSource } from "./state.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

export type FilterMode = NonNullable<ConstructorParameters<typeof TreeSelectorComponent>[7]>;
export const filterModes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

// Match the native text-block concatenation and 200-code-unit search/display bound.
// Do not copy or sanitize thinking, images, tool arguments, or other unused payloads.
function contentText(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(block => block.type === "text").map(block => block.text).join("") : "";
  return sanitizeTerminalText(text).slice(0, 200);
}
function displayEntry(entry: SessionMessageEntry): SessionMessageEntry {
  const message = entry.message;
  if (message.role === "bashExecution") return { ...entry, message: { ...message, command: sanitizeTerminalText(message.command), output: "" } };
  if (message.role === "user" || message.role === "assistant") return { ...entry, message: { ...message, content: [{ type: "text", text: contentText(message.content) }],
    ...(message.role === "assistant" ? { errorMessage: message.errorMessage && sanitizeTerminalText(message.errorMessage) } : {}),
  } as typeof message };
  return { ...entry };
}
export function treeNodes(items: readonly PinItem[]): SessionTreeNode[] {
  const nodes = items.map((item, i): SessionTreeNode => {
    const entry = displayEntry(item.source.entry);
    entry.id = item.key; entry.parentId = items[i - 1]?.key ?? null;
    return { entry, children: [], label: item.pinned ? "pinned" : undefined };
  });
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].children.push(nodes[i]);
  return nodes;
}

// Private TreeList state, tested with Pi 1.3.0 and 1.4.0.
// Check behavior on Pi upgrades; this guard validates member shapes only.
interface TreeListState {
  selectedIndex: number;
  readonly filteredNodes: { readonly length: number };
  maxVisibleLines: number;
  searchQuery: string;
  applyFilter(): void;
  getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string;
}
function nativeState(list: ReturnType<TreeSelectorComponent["getTreeList"]>): TreeListState {
  const state = list as unknown as TreeListState;
  if (!state || !Number.isInteger(state.selectedIndex) || !Array.isArray(state.filteredNodes) ||
    !Number.isInteger(state.maxVisibleLines) || state.maxVisibleLines < 1 ||
    typeof state.searchQuery !== "string" || typeof state.applyFilter !== "function" || typeof state.getEntryDisplayText !== "function") {
    throw new Error("Pins: unsupported Pi TreeList internals; update Pins or use a compatible Pi version.");
  }
  return state;
}

export function pinLabel(source: PinSource, showRole = true): string {
  const node: SessionTreeNode = { entry: displayEntry(source.entry), children: [] };
  const list = new TreeSelectorComponent([node], null, 1, () => {}, () => {}, undefined, undefined, "all").getTreeList();
  const label = stripVTControlCharacters(nativeState(list).getEntryDisplayText(node, false));
  return showRole ? label : label.replace(/^(?:assistant|user): /, "");
}

export function createTree(items: readonly PinItem[], filter: FilterMode, query: string, initial?: string) {
  const nodes = treeNodes(items);
  // No empty selector: its constructor schedules an unwanted auto-cancel.
  const list = nodes.length ? new TreeSelectorComponent(nodes.slice(0, 1), null, 20,
    () => {}, () => {}, undefined, initial, filter).getTreeList() : undefined;
  const state = list ? nativeState(list) : undefined;
  if (list && state) {
    list.onLabelEdit = undefined;
    if (query) { state.searchQuery = query; state.applyFilter(); }
  }
  return {
    selected: () => list?.getSelectedNode()?.entry.id,
    handleInput: (data: string) => list?.handleInput(data),
    invalidate: () => list?.invalidate(),
    move(direction: -1 | 1, count = state?.maxVisibleLines ?? 10) {
      if (!state || !state.filteredNodes.length) return;
      state.selectedIndex = Math.max(0, Math.min(state.filteredNodes.length - 1, state.selectedIndex + direction * count));
    },
    render(width: number, capacity: number): string[] {
      if (!list || !state) return [];
      state.maxVisibleLines = capacity;
      return list.render(width);
    },
  };
}
