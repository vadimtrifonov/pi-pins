import { stripVTControlCharacters } from "node:util";
import { copyToClipboard, getMarkdownTheme, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type Keybinding, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { PinSource, PinGroup } from "./state.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { FOOTER_ROWS, hintRows, panelLine, panelOverlay, panelRule } from "./panel.ts";
import { scopeHeader, type PinScope } from "./scope.ts";
import { createTree, filterModes, pinLabel, type FilterMode } from "./tree.ts";
export type { PinScope } from "./scope.ts";
export function sourceCaption(theme: Theme, group: PinGroup, width: number): string[] {
  const name = sanitizeTerminalText(group.name ?? "").replace(/\s+/g, " ").trim();
  const lines = name ? [truncateToWidth(`Session name: ${name}`, width, "…")] : [];
  lines.push(...wrapTextWithAnsi(`Session ID: ${sanitizeTerminalText(group.id)}`, width), "");
  return lines.map(line => theme.fg("muted", line));
}
// Remove terminal controls from pinned text but keep the line breaks and tabs that
// Markdown needs. Markdown also treats \r\n and \r as line breaks.
const readerText = (text: string) =>
  text.split(/\r\n|\r|\n/).map(line => line.split("\t").map(sanitizeTerminalText).join("\t")).join("\n");
export interface ReadingMemory {
  selected: Map<PinScope, string>;
  query: string;
  localQuery: string;
}
export const readingMemory = (): ReadingMemory => ({ selected: new Map(), query: "", localQuery: "" });
export const pinKey = (groupId: string, answerId: string) => `${groupId}:${answerId}`;
export interface PinItem { key: string; source: PinSource; group: PinGroup; pinned: boolean }
export function pinItems(group: PinGroup, sources: readonly PinSource[]): PinItem[] {
  const pinned = new Set(group.pins.map(source => source.id));
  return sources.map(source => ({ key: pinKey(group.id, source.id), source, group, pinned: pinned.has(source.id) }));
}
export type BrowserAction = { kind: "insert"; text: string } | { kind: "replace"; id: string };
interface BrowserOptions {
  tui: Pick<TUI, "terminal" | "requestRender">; theme: Theme; keys: KeybindingsManager;
  groups: PinGroup[]; memory: ReadingMemory; signal: AbortSignal;
  scope: PinScope; initial?: string; messages?: PinSource[]; pinnedOnly?: boolean;
  replacementFor?: PinSource;
  done(action?: BrowserAction): void;
  copy?: (text: string) => Promise<void>;
  loadSaved?: (signal: AbortSignal) => Promise<PinGroup[]>;
  togglePin?: (item: PinItem) => Promise<PinGroup>;
}
const filters: Partial<Record<Keybinding, FilterMode>> = {
  "app.tree.filter.default": "default", "app.tree.filter.noTools": "no-tools", "app.tree.filter.userOnly": "user-only",
  "app.tree.filter.labeledOnly": "labeled-only", "app.tree.filter.all": "all",
};
const filterActions: Keybinding[] = [...Object.keys(filters) as Keybinding[], "app.tree.filter.cycleBackward", "app.tree.filter.cycleForward"];

export function createBrowser(options: BrowserOptions) {
  const { tui, theme, keys, memory, signal } = options;
  const replacing = options.replacementFor !== undefined;
  let groups = options.groups;
  const currentGroup = () => groups.find(group => group.current);
  // Retain the current session's sources for reading and repinning after unpinning.
  const messages = options.messages ?? currentGroup()?.pins ?? [];
  let scope = options.scope;
  let filter: FilterMode = options.pinnedOnly ? "labeled-only" : "default";
  let focused = false, editing = false, closed = false, cramped = false, busy = false;
  let readerKey: string | undefined;
  let readerOrder: string[] = [];
  let copiedKey: string | undefined, notice = "";
  // Saved pins load once, on the first All visit.
  let saved: { status: "idle" | "loading" | "ready" } | { status: "failed"; message: string } = { status: options.loadSaved ? "idle" : "ready" };
  const controller = new AbortController();
  const query = () => scope === "current" ? memory.localQuery : memory.query;
  const input = new Input({ placeholder: "Search", placeholderStyle: text => theme.fg("dim", text) });
  if (query()) input.handleInput(query());
  let catalog: PinItem[] = [], local: PinItem[] = [];
  function refreshItems() {
    catalog = groups.flatMap(group => pinItems(group, group.pins));
    // Session-qualified keys give forked copies with identical timestamps a stable order.
    catalog.sort((a, b) => (Date.parse(a.source.entry.timestamp) || 0) - (Date.parse(b.source.entry.timestamp) || 0) || a.key.localeCompare(b.key));
    const group = currentGroup();
    local = group ? pinItems(group, messages) : [];
  }
  refreshItems();
  const items = () => scope === "all" ? saved.status === "ready" ? catalog : [] : local;
  let tree: ReturnType<typeof createTree>;
  let page = 1, lineCount = 0, offset = 0, shownKey: string | undefined;
  let markdown: Markdown | undefined, markdownKey: string | undefined;
  const selected = () => items().find(item => item.key === tree?.selected());
  const current = () => readerKey ? local.find(item => item.key === readerKey) ?? catalog.find(item => item.key === readerKey) : selected();
  // Another entry opens at its top without the previous entry's notice.
  const remember = () => {
    if (shownKey !== current()?.key) { shownKey = current()?.key; offset = 0; notice = ""; }
    const key = tree?.selected();
    if (key) memory.selected.set(scope, key);
  };
  function rebuild(initial = tree?.selected() ?? memory.selected.get(scope), previous = items()) {
    const candidates = items();
    // Keep a removed source's former position when choosing the remaining row.
    if (initial && !candidates.some(item => item.key === initial)) {
      const positions = new Map(previous.map((item, index) => [item.key, index]));
      const position = positions.get(initial);
      initial = position === undefined ? candidates.at(-1)?.key
        : candidates.findLast(item => (positions.get(item.key) ?? Infinity) <= position)?.key ?? candidates[0]?.key;
    }
    tree = createTree(candidates, scope === "all" ? "default" : filter, query(), initial);
    remember();
  }
  function finish(action?: BrowserAction) {
    if (closed) return;
    remember(); closed = true; controller.abort(); options.done(action);
  }
  const abort = () => finish();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) queueMicrotask(abort);
  function loadSaved() {
    if (saved.status !== "idle") return;
    saved = { status: "loading" };
    void Promise.resolve().then(() => { controller.signal.throwIfAborted(); return options.loadSaved!(controller.signal); }).then(loaded => {
      if (closed || signal.aborted) return;
      groups = [...groups.filter(group => group.current), ...loaded.filter(group => !group.current && group.id !== currentGroup()?.id)];
      saved = { status: "ready" }; refreshItems();
      if (scope === "all") rebuild(memory.selected.get("all"));
      tui.requestRender();
    }, error => {
      if (closed || signal.aborted) return;
      saved = { status: "failed", message: `Saved pins unavailable: ${sanitizeTerminalText(String(error))}` }; tui.requestRender();
    });
  }
  function changeScope(next: PinScope) {
    if (next === scope || readerKey) return;
    scope = next; editing = false; notice = ""; input.setValue(""); if (query()) input.handleInput(query());
    // Select the newest message on the first All visit, including after background loading.
    rebuild(memory.selected.get(scope) ?? (scope === "all" ? items().at(-1)?.key : undefined));
    if (scope === "all") loadSaved();
  }
  function changeFilter(action: Keybinding) {
    const target = filters[action];
    filter = target ? target === "default" || filter === target ? "default" : target
      : filterModes[(filterModes.indexOf(filter) + (action.endsWith("Backward") ? filterModes.length - 1 : 1)) % filterModes.length];
    rebuild();
  }
  function scroll(delta: number, byPage = false) {
    component.render(tui.terminal.columns);
    const max = Math.max(0, lineCount - page);
    offset = Math.max(0, Math.min(Math.min(offset, max) + delta * (byPage ? page : 1), max));
  }
  async function toggle() {
    const item = current();
    if (!item || busy) return;
    if (!item.group.current) { notice = "Unpin in its session (read-only here)."; tui.requestRender(); return; }
    if (!options.togglePin) return;
    busy = true;
    try {
      const group = await options.togglePin(item);
      if (closed || signal.aborted) return;
      const old = currentGroup()?.pins.map(pin => pin.id).join("\0"), previous = items();
      groups = groups.map(existing => existing.current ? group : existing);
      refreshItems();
      if (old !== group.pins.map(pin => pin.id).join("\0")) rebuild(item.key, previous);
    } catch (error) { if (!closed && !signal.aborted) notice = sanitizeTerminalText(String(error)); }
    finally { busy = false; if (!closed && !signal.aborted) tui.requestRender(); }
  }
  rebuild(options.initial ?? memory.selected.get(scope));
  const component = {
    get focused() { return focused; },
    set focused(value: boolean) { focused = value; input.focused = value && editing && !readerKey; },
    render(width: number): string[] {
      if (!focused) return [];
      const rows = Math.max(1, tui.terminal.rows - FOOTER_ROWS), inner = Math.max(1, width - 2);
      const line = (text: string) => panelLine(text, width), rule = panelRule(theme, width), item = current();
      const header = [options.replacementFor
        ? theme.fg("accent", theme.bold(stripVTControlCharacters(truncateToWidth(`Replace with: ${pinLabel(options.replacementFor)}`, inner, "…"))))
        : readerKey ? theme.bold("Pin") : scopeHeader(theme, inner, scope)];
      const pinAction = item?.pinned ? "p unpin" : "p pin";
      const showQuery = !readerKey && (editing || !!query());
      if (showQuery) header.push(...editing ? input.render(inner) : [theme.fg("muted", truncateToWidth(`Search: ${query()} · / edit`, inner, "…"))]);
      const tab = keys.getKeys("tui.input.tab").map(key => key === "tab" ? "Tab" : key).join("/");
      const pinsFiltered = filter === "labeled-only";
      const filterKey = keys.getKeys("app.tree.filter.labeledOnly").map(key => key === "ctrl+l" ? "Ctrl+L" : key).join("/");
      const pinFilter = filterKey ? `${filterKey} ${pinsFiltered ? "all" : "pins"}` : "";
      // Style the complete hint row once; an inner foreground reset would leave
      // the following hints in the terminal's default color.
      const actions = [...(item && !item.group.current ? [] : [pinAction]), "c copy", "i insert"];
      const readerHints = ["↑/↓ previous/next", "PgUp/PgDn scroll"];
      const hints = replacing ? ["r replace", ...(readerKey ? readerHints : ["↑/↓ move", "PgUp/PgDn scroll", "Enter read"]), readerKey ? "Esc back" : "Esc cancel"]
        : editing ? ["↑/↓ move", "PgUp/PgDn scroll", "Enter read", ...(tab ? [`${tab} scope`] : []), "Esc finish search"]
        : readerKey ? [...actions, ...readerHints, "Esc back"] : [
          ...actions, ...(scope === "current" && pinFilter ? [pinFilter] : []), ...(!showQuery ? ["/ search"] : []),
          "↑/↓ move", "PgUp/PgDn scroll", "Enter read", ...(tab ? [`${tab} scope`] : []), "Esc close",
        ];
      const feedback = !editing && (notice || item && copiedKey === item.key)
        ? [line(theme.fg("muted", truncateToWidth(notice || `Copied: ${pinLabel(item!.source)}`, inner, "…")))] : [];
      const before = [...header.map(line), ...hintRows(theme, hints, inner).map(line), ...feedback, rule];
      const caption = item && scope === "all" ? sourceCaption(theme, item.group, inner).map(line) : [];
      const minimum = readerKey ? 3 : 2 + (item ? 3 : 0);
      const preferredMinimum = readerKey ? 3 : minimum + (item ? 1 : 0); // two sources + native counter
      if (caption.length && rows - before.length - caption.length - 1 < preferredMinimum) caption.pop();
      let available = rows - before.length - caption.length - 1;
      const divider = !readerKey && item && available > preferredMinimum ? [rule] : [];
      available -= divider.length;
      cramped = inner < 36 || available < minimum;
      if (cramped) {
        const warning = [line("More room is needed to browse pins."), line("Esc back/close")];
        while (warning.length < rows - 1) warning.push("");
        return [...warning.slice(0, rows - 1), rule];
      }
      let choices: string[] = [];
      if (!readerKey) {
        const preview = item ? Math.min(5, available - (available >= 6 ? 3 : 2)) : 0;
        choices = tree.render(width, Math.max(1, available - preview - 1));
        if (!choices.length) choices = [line(theme.fg("muted", scope === "all" && saved.status !== "ready" ? saved.status === "failed" ? saved.message : "Loading saved pins…" : scope === "all" ? "No saved pins." : "No messages to pin yet.")), line(theme.fg("muted", "(0/0)"))];
      }
      page = Math.max(1, available - choices.length);
      if (markdownKey !== item?.key) { markdownKey = item?.key; markdown = item ? new Markdown(readerText(item.source.text), 0, 0, getMarkdownTheme()) : undefined; }
      const lines = markdown?.render(inner) ?? []; lineCount = lines.length;
      const displayed = Math.max(0, Math.min(offset, Math.max(0, lineCount - page)));
      const body = lines.slice(displayed, displayed + page);
      while (body.length < page) body.push("");
      let closing = rule;
      if (lineCount) {
        const position = ` lines ${displayed + 1}–${Math.min(lineCount, displayed + page)}/${lineCount} `;
        closing = truncateToWidth(rule, Math.max(0, width - position.length), "") + theme.fg("muted", position);
      }
      return [...before, ...choices, ...divider, ...caption, ...body.map(line), closing];
    },
    handleInput(data: string) {
      if (closed || signal.aborted || busy) return;
      if (matchesKey(data, "ctrl+c")) return finish();
      if (keys.matches(data, "tui.select.cancel")) {
        if (readerKey) readerKey = undefined;
        else if (editing) { editing = false; input.focused = false; }
        else return finish();
      } else if (cramped) return;
      else if (matchesKey(data, "pageDown")) scroll(1, true);
      else if (matchesKey(data, "pageUp")) scroll(-1, true);
      else if (keys.matches(data, "tui.select.confirm")) {
        if (!readerKey && selected()) { readerKey = selected()!.key; readerOrder = items().map(item => item.key); editing = false; input.focused = false; }
      } else if (!replacing && !readerKey && keys.matches(data, "tui.input.tab")) changeScope(scope === "current" ? "all" : "current");
      else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        if (readerKey) {
          const direction = keys.matches(data, "tui.select.up") ? -1 : 1;
          // Unpin may remove the reader from the tree. Use its original order
          // so previous/next still move in the requested direction, or stay put.
          const origin = readerOrder.indexOf(readerKey);
          // Native filtering falls back to the last row when no preceding
          // ancestor is visible. The nearest successor is then the first row.
          if (readerKey !== tree.selected() && readerOrder.indexOf(tree.selected() ?? "") > origin) {
            tree.move(-1, Infinity);
          }
          const relativePosition = () => direction * (readerOrder.indexOf(tree.selected() ?? "") - origin);
          if (readerKey === tree.selected() || relativePosition() < 0) tree.move(direction, 1);
          if (tree.selected() && relativePosition() > 0) readerKey = tree.selected();
        } else tree.handleInput(data);
      } else if (editing && !readerKey) {
        input.handleInput(data);
        if (input.getValue() !== query()) {
          if (scope === "all") memory.query = input.getValue(); else memory.localQuery = input.getValue();
          rebuild();
        }
      } else if (!replacing && !readerKey && data === "/") { editing = true; input.focused = focused; }
      else if (!replacing && !readerKey && scope === "current" && filterActions.some(action => keys.matches(data, action))) {
        changeFilter(filterActions.find(action => keys.matches(data, action))!);
      } else if (!readerKey && (keys.matches(data, "tui.editor.cursorLeft") || keys.matches(data, "tui.editor.cursorRight"))) {
        tree.move(keys.matches(data, "tui.editor.cursorLeft") ? -1 : 1);
      } else if (replacing && data === "r" && current()) return finish({ kind: "replace", id: current()!.source.id });
      else if (!replacing && data === "p") { void toggle(); }
      else if (!replacing && data === "i" && current()) return finish({ kind: "insert", text: current()!.source.text });
      else if (!replacing && data === "c" && current()) {
        const item = current()!; notice = "";
        void (options.copy ?? copyToClipboard)(item.source.text).then(() => {
          if (!closed && !signal.aborted) { copiedKey = item.key; tui.requestRender(); }
        }, error => { if (!closed && !signal.aborted && current()?.key === item.key) { notice = `Copy failed: ${sanitizeTerminalText(String(error))}`; tui.requestRender(); } });
      } else if (matchesKey(data, "home")) offset = 0;
      else if (matchesKey(data, "end")) offset = Number.POSITIVE_INFINITY;
      remember(); tui.requestRender();
    },
    handleMouse(event: TuiMouseEvent) {
      if (closed || busy || signal.aborted || cramped) return undefined;
      if (event.type === "wheel" && event.wheelDelta) { scroll(event.wheelDelta); return { handled: true, render: true }; }
      return undefined; // TreeList itself has no public mouse-selection API.
    },
    invalidate() { markdownKey = undefined; markdown = undefined; tree.invalidate(); input.invalidate(); },
    dispose() { remember(); closed = true; controller.abort(); signal.removeEventListener("abort", abort); },
  };
  if (scope === "all") loadSaved();
  return component;
}

// Pins always opens in Session scope.
export function browsePins(ctx: ExtensionContext, options: Omit<BrowserOptions, "tui" | "theme" | "keys" | "done" | "scope" | "copy">) {
  return ctx.ui.custom<BrowserAction | undefined>((tui, theme, keys, done) => createBrowser({ ...options, tui, theme, keys, done, scope: "current" }), { overlay: true, overlayOptions: panelOverlay });
}

export async function chooseReplacement(ctx: ExtensionContext, group: PinGroup, incoming: PinSource, signal: AbortSignal) {
  // Separate reading memory keeps the originating query and selection intact.
  // The existing browser, with its reading position, remains alive beneath this full frame.
  const action = await browsePins(ctx, {
    groups: [group], memory: readingMemory(), signal, initial: pinKey(group.id, group.pins[0].id), replacementFor: incoming,
  });
  if (signal.aborted || action?.kind !== "replace") return undefined;
  return action.id;
}
