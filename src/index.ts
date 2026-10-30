import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMIT, addPin, identity, originGroups, pinnedCopy, removePin, renameOrigin, sessionSources, type Origin, type Pin, type PinSource } from "./state.ts";
import { pinStore, type PinStore } from "./store.ts";
import { findOrigin } from "./sessions.ts";
import { createShelf, type ShelfPin } from "./widget.ts";
import { pinLabel } from "./tree.ts";
import { browsePins, chooseReplacement, readingMemory, type PinItem, type PinView } from "./browser.ts";

export function registerPins(pi: ExtensionAPI, store: PinStore = pinStore) {
  let pins: Pin[] = [];
  // Numbers each read and save, so a slow read cannot replace newer pins.
  let sequence = 0;
  let running = false;
  let stopWatching: (() => void) | undefined;
  let updateShelf: ((pins: ShelfPin[]) => void) | undefined;
  let active: AbortController | undefined;
  const memory = readingMemory();

  function view(ctx: ExtensionContext): PinView {
    const manager = ctx.sessionManager, pinned = new Set(pins.map(pin => identity(pin.entry)));
    const messages = sessionSources(manager.getEntries(), manager.getBranch(), pinned);
    return {
      session: { id: manager.getSessionId(), name: pi.getSessionName(), pins: messages.filter(source => pinned.has(identity(source.entry))) },
      messages, all: originGroups(pins),
    };
  }

  function refresh(ctx: ExtensionContext) {
    // After shutdown, ctx throws on access.
    if (!running || ctx.mode !== "tui") return;
    let shelf: ShelfPin[];
    try { shelf = view(ctx).session.pins.map(pin => ({ id: identity(pin.entry), label: pinLabel(pin, false) })); }
    catch (error) {
      ctx.ui.setWidget("pins:shelf", undefined);
      updateShelf = undefined;
      ctx.ui.notify(String(error), "error");
      return;
    }
    if (!shelf.length) {
      ctx.ui.setWidget("pins:shelf", undefined);
      updateShelf = undefined;
      return;
    }
    if (updateShelf) { updateShelf(shelf); return; }
    ctx.ui.setWidget("pins:shelf", (tui, theme) => {
      updateShelf = updated => { shelf = updated; tui.requestRender(); };
      return createShelf(theme, () => shelf, key => {
        void runUI(ctx, signal => browse(ctx, signal, key));
      });
    }, { placement: "aboveEditor" });
  }

  /** Reads the pins file; an invalid file clears the shelf and throws. */
  async function load(ctx: ExtensionContext): Promise<Pin[]> {
    const mine = ++sequence;
    try {
      const read = await store.read();
      if (mine === sequence) { pins = read; refresh(ctx); }
      return read;
    } catch (error) {
      if (mine === sequence) { pins = []; refresh(ctx); }
      throw error;
    }
  }
  function reload(ctx: ExtensionContext) {
    const mine = sequence + 1;
    return load(ctx).then(() => {}, error => { if (running && mine === sequence) ctx.ui.notify(String(error), "error"); });
  }
  // A save finishes even if the session ends meanwhile: pins belong to messages, which outlive a session.
  async function save(ctx: ExtensionContext, change: (pins: Pin[]) => Pin[]) {
    const saved = await store.update(change);
    ++sequence;
    pins = saved;
    refresh(ctx);
  }

  async function runUI(ctx: ExtensionContext, action: (signal: AbortSignal) => Promise<void>) {
    if (ctx.mode !== "tui" || active) return;
    const controller = new AbortController();
    active = controller;
    try { await action(controller.signal); }
    catch (error) { if (running) ctx.ui.notify(String(error), "error"); }
    finally { if (active === controller) active = undefined; }
  }

  /** Pins a message unless it is already pinned. A session holding LIMIT pinned messages asks which one to replace. */
  async function pin(ctx: ExtensionContext, signal: AbortSignal, source: PinSource, origin?: Origin) {
    // Capture session data before waiting: once the session ends, ctx can no longer be used.
    const manager = ctx.sessionManager, header = manager.getHeader(), name = pi.getSessionName();
    const id = manager.getSessionId(), entries = manager.getEntries(), branch = manager.getBranch();
    const key = identity(source.entry), current = await load(ctx);
    const pinned = new Set(current.map(pin => identity(pin.entry)));
    if (pinned.has(key)) return;
    let replacing: string | undefined;
    if (entries.some(entry => entry.type === "message" && identity(entry) === key)) {
      const shelf = sessionSources(entries, branch, pinned).filter(pin => pinned.has(identity(pin.entry)));
      if (shelf.length >= LIMIT) {
        if (signal.aborted) return;
        const choice = await chooseReplacement(ctx, { id, name, pins: shelf }, source, signal);
        const outgoing = shelf.find(pin => pin.id === choice);
        if (!outgoing) return;
        replacing = identity(outgoing.entry);
      }
    }
    origin ??= header ? await findOrigin(header, name, source.entry.timestamp) : { id, name };
    await save(ctx, latest => addPin(latest, { entry: pinnedCopy(source.entry), origin }, replacing));
  }
  async function toggle(ctx: ExtensionContext, signal: AbortSignal, item: PinItem) {
    // The row's mark decides the action, so p does what the row shows even if another Pi changed that pin meanwhile.
    if (item.pinned) await save(ctx, current => removePin(current, item.key));
    // An All row from another session already knows where its message was written.
    else await pin(ctx, signal, item.source, item.group.id === ctx.sessionManager.getSessionId() ? undefined : { id: item.group.id, name: item.group.name });
  }

  // The shelf opens its pin among pins only; /pins opens the latest answer among all messages.
  async function browse(ctx: ExtensionContext, signal: AbortSignal, key?: string) {
    await load(ctx);
    if (signal.aborted) return;
    memory.localQuery = "";
    const current = view(ctx);
    const latest = current.messages.findLast(({ entry }) => entry.message.role === "assistant") ?? current.messages.at(-1);
    const action = await browsePins(ctx, {
      view: current, memory, signal, initial: key ?? (latest && identity(latest.entry)), pinnedOnly: key !== undefined,
      async togglePin(item) {
        await toggle(ctx, signal, item);
        return running && !signal.aborted ? view(ctx) : undefined;
      },
    });
    if (!action || signal.aborted) return;
    if (action.kind === "insert") ctx.ui.pasteToEditor(action.text);
  }
  pi.registerCommand("pins", {
    description: "Browse and pin messages",
    handler: (_args, ctx) => runUI(ctx, signal => browse(ctx, signal)),
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    running = true;
    try { stopWatching = store.watch(() => void reload(ctx)); }
    catch (error) { ctx.ui.notify(`Pins from other Pi sessions will not update live: ${String(error)}`, "warning"); }
    // Pi waits for this, so the shelf is in place when the session starts.
    return reload(ctx);
  });
  pi.on("session_info_changed", (event, ctx) => {
    if (!running) return;
    const id = ctx.sessionManager.getSessionId();
    save(ctx, current => renameOrigin(current, id, event.name)).catch(error => { if (running) ctx.ui.notify(String(error), "error"); });
  });
  pi.on("session_shutdown", () => {
    active?.abort();
    active = undefined;
    running = false;
    ++sequence;
    stopWatching?.();
    stopWatching = undefined;
    updateShelf = undefined;
  });
}
