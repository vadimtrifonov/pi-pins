import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PIN_STATE, LIMIT, addPin, sourceFromEntry, sourcesOnBranch, pinnedSources, pinsOnBranch, snapshot, type PinGroup } from "./state.ts";
import { createShelf, type ShelfPin } from "./widget.ts";
import { pinLabel } from "./tree.ts";
import { browsePins, chooseReplacement, pinKey, readingMemory } from "./browser.ts";

export function registerPins(pi: ExtensionAPI, listSaved?: (ctx: ExtensionContext, signal: AbortSignal) => Promise<PinGroup[]>) {
  let updateShelf: ((pins: ShelfPin[]) => void) | undefined;
  let active: AbortController | undefined;
  let memory = readingMemory();

  const current = (ctx: ExtensionContext, branch: readonly SessionEntry[] = ctx.sessionManager.getBranch()): PinGroup =>
    ({ id: ctx.sessionManager.getSessionId(), name: pi.getSessionName(), current: true, pins: pinnedSources(branch) });

  function refresh(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    let pins: ShelfPin[];
    try { pins = current(ctx).pins.map(pin => ({ id: pin.id, label: pinLabel(pin, false) })); }
    catch (error) {
      ctx.ui.setWidget("pins:shelf", undefined);
      updateShelf = undefined;
      ctx.ui.notify(String(error), "error");
      return;
    }
    if (!pins.length) {
      ctx.ui.setWidget("pins:shelf", undefined);
      updateShelf = undefined;
      return;
    }
    if (updateShelf) { updateShelf(pins); return; }
    ctx.ui.setWidget("pins:shelf", (tui, theme) => {
      updateShelf = updated => { pins = updated; tui.requestRender(); };
      return createShelf(theme, () => pins, id => {
        void runUI(ctx, signal => browse(ctx, signal, id));
      });
    }, { placement: "aboveEditor" });
  }
  function reset() {
    active?.abort();
    active = undefined;
  }
  async function runUI(ctx: ExtensionContext, action: (signal: AbortSignal) => Promise<void>) {
    if (ctx.mode !== "tui" || active) return;
    const controller = new AbortController();
    active = controller;
    try { await action(controller.signal); }
    catch (error) { if (!controller.signal.aborted) ctx.ui.notify(String(error), "error"); }
    finally { if (active === controller) active = undefined; }
  }
  function commit(ctx: ExtensionContext, ids: string[]) {
    pi.appendEntry(PIN_STATE, snapshot(ids));
    refresh(ctx);
  }
  async function pin(ctx: ExtensionContext, signal: AbortSignal, id: string) {
    if (signal.aborted) return;
    const branch = ctx.sessionManager.getBranch(), ids = pinsOnBranch(branch);
    const entry = branch.find(e => e.id === id), incoming = entry && sourceFromEntry(entry);
    if (ids.includes(id) || !incoming) return;
    let replace: string | undefined;
    if (ids.length >= LIMIT) {
      replace = await chooseReplacement(ctx, current(ctx, branch), incoming, signal);
      if (!replace || signal.aborted) return;
    }
    commit(ctx, addPin(ids, id, replace));
    memory.selected.set("current", pinKey(ctx.sessionManager.getSessionId(), id));
  }
  // The shelf opens its pin among pins only; /pins opens the latest answer among all messages.
  async function browse(ctx: ExtensionContext, signal: AbortSignal, pinId?: string) {
    memory.localQuery = "";
    const branch = ctx.sessionManager.getBranch(), group = current(ctx, branch), messages = sourcesOnBranch(branch);
    const latest = messages.findLast(({ entry }) => entry.message.role === "assistant") ?? messages.at(-1);
    const initial = pinId ?? latest?.id;
    const action = await browsePins(ctx, {
      groups: [group], memory, signal, initial: initial && pinKey(group.id, initial),
      loadSaved: listSaved && (signal => listSaved(ctx, signal)),
      messages, pinnedOnly: pinId !== undefined,
      async togglePin(item) {
        // Only the owning session can append branch-relative pin state.
        if (signal.aborted || !item.group.current) return current(ctx);
        const ids = pinsOnBranch(ctx.sessionManager.getBranch());
        if (ids.includes(item.source.id)) commit(ctx, ids.filter(id => id !== item.source.id));
        else await pin(ctx, signal, item.source.id);
        return current(ctx);
      },
    });
    if (!action || signal.aborted) return;
    if (action.kind === "insert") ctx.ui.pasteToEditor(action.text);
  }
  pi.registerCommand("pins", {
    description: "Browse and pin messages",
    handler: (_args, ctx) => runUI(ctx, signal => browse(ctx, signal)),
  });

  pi.on("session_start", (_event, ctx) => { reset(); updateShelf = undefined; memory = readingMemory(); refresh(ctx); });
  pi.on("session_tree", (_event, ctx) => { reset(); refresh(ctx); });
  pi.on("session_shutdown", () => { reset(); updateShelf = undefined; });
}
