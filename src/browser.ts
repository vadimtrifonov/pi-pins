import { stripVTControlCharacters } from "node:util";
import { copyToClipboard, getMarkdownTheme, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type Keybinding, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { identity, type PinSource, type PinGroup } from "./state.ts";
import { FOOTER_ROWS, hintRows, oneLine, panelLine, panelOverlay, panelRule } from "./panel.ts";
import { scopeHeader, type PinScope } from "./scope.ts";
import { createTree, filterModes, pinLabel, type FilterMode } from "./tree.ts";
export type { PinScope } from "./scope.ts";
export function sourceCaption(theme: Theme, group: PinGroup, width: number): string[] {
  const name = oneLine(group.name ?? "").replace(/\s+/g, " ").trim();
  const lines = name ? [truncateToWidth(`Session name: ${name}`, width, "…")] : [];
  lines.push(...wrapTextWithAnsi(`Session ID: ${group.id}`, width), "");
  return lines.map(line => theme.fg("muted", line));
}
export interface ReadingMemory {
  selected: Map<PinScope, string>;
  query: string;
  localQuery: string;
}
export const readingMemory = (): ReadingMemory => ({ selected: new Map(), query: "", localQuery: "" });
export interface PinItem { key: string; source: PinSource; group: PinGroup; pinned: boolean }
export function pinItems(group: PinGroup, sources: readonly PinSource[]): PinItem[] {
  const pinned = new Set(group.pins.map(source => identity(source.entry)));
  return sources.map(source => { const key = identity(source.entry); return { key, source, group, pinned: pinned.has(key) }; });
}
/**
 * session: the current session and the pinned messages it contains; messages: its Session rows;
 * all: every pin, grouped by the session where it was written.
 */
export interface PinView { session: PinGroup; messages: PinSource[]; all: PinGroup[] }
const pinnedKeys = (view: PinView) => [view.session, ...view.all].flatMap(group => group.pins.map(source => identity(source.entry))).join("\0");
export type BrowserAction = { kind: "insert"; text: string } | { kind: "replace"; id: string };
interface BrowserOptions {
  tui: Pick<TUI, "terminal" | "requestRender">; theme: Theme; keys: KeybindingsManager;
  view: PinView; memory: ReadingMemory; signal: AbortSignal;
  scope: PinScope; initial?: string; pinnedOnly?: boolean;
  replacementFor?: PinSource;
  done(action?: BrowserAction): void;
  copy?: (text: string) => Promise<void>;
  // Resolves to the updated view, or undefined when the session has ended.
  togglePin?: (item: PinItem) => Promise<PinView | undefined>;
}
const filters: Partial<Record<Keybinding, FilterMode>> = {
  "app.tree.filter.default": "default", "app.tree.filter.noTools": "no-tools", "app.tree.filter.userOnly": "user-only",
  "app.tree.filter.all": "all",
};
const filterActions: Keybinding[] = [...Object.keys(filters) as Keybinding[], "app.tree.filter.cycleBackward", "app.tree.filter.cycleForward"];

export function createBrowser(options: BrowserOptions) {
  const { tui, theme, keys, memory, signal } = options;
  const replacing = options.replacementFor !== undefined;
  let view = options.view;
  // Session rows stay fixed while the panel is open, so an unpinned message can be read and pinned again.
  const messages = view.messages;
  let scope = options.scope;
  let filter: FilterMode = options.pinnedOnly ? "labeled-only" : "default";
  let focused = false, editing = false, closed = false, cramped = false, busy = false;
  let reader: PinItem | undefined;
  let readerOrder: string[] = [];
  let copiedKey: string | undefined, notice = "";
  const query = () => scope === "current" ? memory.localQuery : memory.query;
  const input = new Input({ placeholder: "Search", placeholderStyle: text => theme.fg("dim", text) });
  if (query()) input.handleInput(query());
  let catalog: PinItem[] = [], local: PinItem[] = [];
  function refreshItems() {
    const next = view.all.flatMap(group => pinItems(group, group.pins))
      .sort((a, b) => (Date.parse(a.source.entry.timestamp) || 0) - (Date.parse(b.source.entry.timestamp) || 0) || a.key.localeCompare(b.key));
    catalog = next;
    local = pinItems(view.session, messages);
    const previous = reader;
    if (previous) reader = items().find(item => item.key === previous.key) ?? { ...previous, pinned: false };
  }
  const items = () => scope === "all" ? catalog : local;
  refreshItems();
  let tree: ReturnType<typeof createTree>;
  let page = 1, lineCount = 0, offset = 0, shownKey: string | undefined;
  let markdown: Markdown | undefined, markdownKey: string | undefined;
  const selected = () => items().find(item => item.key === tree?.selected());
  const current = () => reader ?? selected();
  // Opening another message starts at its top and clears the previous message's notice.
  const remember = () => {
    if (shownKey !== current()?.key) { shownKey = current()?.key; offset = 0; notice = ""; }
    const key = tree?.selected();
    if (key) memory.selected.set(scope, key);
  };
  function rebuild(initial = tree?.selected() ?? memory.selected.get(scope), previous = items()) {
    const candidates = items();
    // If the selected row is gone, select the nearest remaining row above it.
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
    remember(); closed = true; options.done(action);
  }
  const abort = () => finish();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) queueMicrotask(abort);
  function changeScope(next: PinScope) {
    if (next === scope || reader) return;
    scope = next; editing = false; notice = ""; input.setValue(""); if (query()) input.handleInput(query());
    // Select the newest message on the first All visit.
    rebuild(memory.selected.get(scope) ?? (scope === "all" ? items().at(-1)?.key : undefined));
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
    if (!item || busy || !options.togglePin) return;
    busy = true; notice = "";
    try {
      const next = await options.togglePin(item);
      if (closed || signal.aborted || !next) return;
      const old = pinnedKeys(view), previous = items();
      view = next;
      refreshItems();
      if (old !== pinnedKeys(next)) rebuild(item.key, previous);
    } catch (error) { if (!closed && !signal.aborted) notice = oneLine(String(error)); }
    finally { busy = false; if (!closed && !signal.aborted) tui.requestRender(); }
  }
  rebuild(options.initial ?? memory.selected.get(scope));
  const component = {
    get focused() { return focused; },
    set focused(value: boolean) { focused = value; input.focused = value && editing && !reader; },
    render(width: number): string[] {
      if (!focused) return [];
      const rows = Math.max(1, tui.terminal.rows - FOOTER_ROWS), inner = Math.max(1, width - 2);
      const line = (text: string) => panelLine(text, width), rule = panelRule(theme, width), item = current();
      const header = [options.replacementFor
        ? theme.fg("accent", theme.bold(stripVTControlCharacters(truncateToWidth(`Replace with: ${pinLabel(options.replacementFor)}`, inner, "…"))))
        : reader ? theme.bold("Pin") : scopeHeader(theme, inner, scope)];
      const pinAction = item?.pinned ? "p unpin" : "p pin";
      const showQuery = !reader && (editing || !!query());
      if (showQuery) header.push(...editing ? input.render(inner) : [theme.fg("muted", truncateToWidth(`Search: ${query()} · / edit`, inner, "…"))]);
      const tab = keys.getKeys("tui.input.tab").map(key => key === "tab" ? "Tab" : key).join("/");
      const pinsFiltered = filter === "labeled-only";
      const pinFilter = `Ctrl+P ${pinsFiltered ? "all" : "pins"}`;
      // Style the complete hint row once; an inner foreground reset would leave
      // the following hints in the terminal's default color.
      const actions = [pinAction, "c copy", "i insert"];
      const readerHints = ["↑/↓ previous/next", "PgUp/PgDn scroll"];
      const hints = replacing ? ["r replace", ...(reader ? readerHints : ["↑/↓ move", "PgUp/PgDn scroll", "Enter read"]), reader ? "Esc back" : "Esc cancel"]
        : editing ? ["↑/↓ move", "PgUp/PgDn scroll", "Enter read", ...(tab ? [`${tab} scope`] : []), "Esc finish search"]
        : reader ? [...actions, ...readerHints, "Esc back"] : [
          ...actions, ...(scope === "current" ? [pinFilter] : []), ...(!showQuery ? ["/ search"] : []),
          "↑/↓ move", "PgUp/PgDn scroll", "Enter read", ...(tab ? [`${tab} scope`] : []), "Esc close",
        ];
      const feedback = !editing && (notice || item && copiedKey === item.key)
        ? [line(theme.fg(notice ? "error" : "muted", truncateToWidth(notice || `Copied: ${pinLabel(item!.source)}`, inner, "…")))] : [];
      const before = [...header.map(line), ...hintRows(theme, hints, inner).map(line), ...feedback, rule];
      const caption = item && scope === "all" ? sourceCaption(theme, item.group, inner).map(line) : [];
      const minimum = reader ? 3 : 2 + (item ? 3 : 0);
      const preferredMinimum = reader ? 3 : minimum + (item ? 1 : 0); // two rows + the native counter
      if (caption.length && rows - before.length - caption.length - 1 < preferredMinimum) caption.pop();
      let available = rows - before.length - caption.length - 1;
      const divider = !reader && item && available > preferredMinimum ? [rule] : [];
      available -= divider.length;
      cramped = inner < 36 || available < minimum;
      if (cramped) {
        const warning = [line("More room is needed to browse pins."), line("Esc back/close")];
        while (warning.length < rows - 1) warning.push("");
        return [...warning.slice(0, rows - 1), rule];
      }
      let choices: string[] = [];
      if (!reader) {
        // The preview keeps a quarter of the room, but no fewer than 5 lines
        // unless the list would lose its last row; a short list leaves it more.
        const preview = item ? Math.max(Math.floor(available / 4), Math.min(5, available - (available >= 6 ? 3 : 2))) : 0;
        choices = tree.render(width, Math.max(1, available - preview - 1));
        if (!choices.length) choices = [line(theme.fg("muted", scope === "all" ? "No pins." : "No messages to pin yet.")), line(theme.fg("muted", "(0/0)"))];
      }
      page = Math.max(1, available - choices.length);
      if (markdownKey !== item?.key) { markdownKey = item?.key; markdown = item ? new Markdown(item.source.text, 0, 0, getMarkdownTheme()) : undefined; }
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
        if (reader) reader = undefined;
        else if (editing) { editing = false; input.focused = false; }
        else return finish();
      } else if (cramped) return;
      else if (matchesKey(data, "pageDown")) scroll(1, true);
      else if (matchesKey(data, "pageUp")) scroll(-1, true);
      else if (keys.matches(data, "tui.select.confirm")) {
        if (!reader && selected()) { reader = selected(); readerOrder = items().map(item => item.key); editing = false; input.focused = false; }
      } else if (!replacing && !reader && keys.matches(data, "tui.input.tab")) changeScope(scope === "current" ? "all" : "current");
      else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        if (reader) {
          const direction = keys.matches(data, "tui.select.up") ? -1 : 1;
          // Unpin may remove the reader from the tree. Use its original order
          // so previous/next still move in the requested direction, or stay put.
          const origin = readerOrder.indexOf(reader.key);
          // Native filtering falls back to the last row when no preceding
          // ancestor is visible. The nearest successor is then the first row.
          if (reader.key !== tree.selected() && readerOrder.indexOf(tree.selected() ?? "") > origin) {
            tree.move(-1, Infinity);
          }
          const relativePosition = () => direction * (readerOrder.indexOf(tree.selected() ?? "") - origin);
          if (reader.key === tree.selected() || relativePosition() < 0) tree.move(direction, 1);
          if (tree.selected() && relativePosition() > 0) reader = selected();
        } else tree.handleInput(data);
      } else if (editing && !reader) {
        input.handleInput(data);
        if (input.getValue() !== query()) {
          if (scope === "all") memory.query = input.getValue(); else memory.localQuery = input.getValue();
          rebuild();
        }
      } else if (!replacing && !reader && data === "/") { editing = true; input.focused = focused; }
      else if (!replacing && !reader && scope === "current" && matchesKey(data, "ctrl+p")) {
        filter = filter === "labeled-only" ? "default" : "labeled-only"; rebuild();
      } else if (!replacing && !reader && scope === "current" && filterActions.some(action => keys.matches(data, action))) {
        changeFilter(filterActions.find(action => keys.matches(data, action))!);
      } else if (!reader && (keys.matches(data, "tui.editor.cursorLeft") || keys.matches(data, "tui.editor.cursorRight"))) {
        tree.move(keys.matches(data, "tui.editor.cursorLeft") ? -1 : 1);
      } else if (replacing && data === "r" && current()) return finish({ kind: "replace", id: current()!.source.id });
      else if (!replacing && data === "p") { void toggle(); }
      else if (!replacing && data === "i" && current()) return finish({ kind: "insert", text: current()!.source.text });
      else if (!replacing && data === "c" && current()) {
        const item = current()!; notice = "";
        void (options.copy ?? copyToClipboard)(item.source.text).then(() => {
          if (!closed && !signal.aborted) { copiedKey = item.key; tui.requestRender(); }
        }, error => { if (!closed && !signal.aborted && current()?.key === item.key) { notice = `Copy failed: ${oneLine(String(error))}`; tui.requestRender(); } });
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
    dispose() { remember(); closed = true; signal.removeEventListener("abort", abort); },
  };
  return component;
}

// Pins always opens in Session scope.
export function browsePins(ctx: ExtensionContext, options: Omit<BrowserOptions, "tui" | "theme" | "keys" | "done" | "scope" | "copy">) {
  return ctx.ui.custom<BrowserAction | undefined>((tui, theme, keys, done) => createBrowser({ ...options, tui, theme, keys, done, scope: "current" }), { overlay: true, overlayOptions: panelOverlay });
}

export async function chooseReplacement(ctx: ExtensionContext, group: PinGroup, incoming: PinSource, signal: AbortSignal) {
  // The chooser has its own reading memory, so the browser beneath it keeps its search, selection and position.
  const action = await browsePins(ctx, {
    view: { session: group, messages: group.pins, all: [] }, memory: readingMemory(), signal, initial: identity(group.pins[0].entry), replacementFor: incoming,
  });
  // A choice already made is saved even if the session ends first.
  return action?.kind === "replace" ? action.id : undefined;
}
