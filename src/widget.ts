import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

export interface ShelfPin { id: string; label: string }

export function createShelf(theme: Theme, getPins: () => ShelfPin[], open: (id: string) => void) {
  let hits = new Map<number, string>();
  return {
    render(width: number): string[] {
      const pins = getPins();
      hits = new Map();
      if (!pins.length || width < 1) return [];
      const lines = new DynamicBorder(text => theme.fg("borderMuted", text)).render(width);
      for (const pin of pins) {
        hits.set(lines.length, pin.id);
        lines.push(theme.fg("muted", "pin: ") + truncateToWidth(pin.label, Math.max(0, width - 5), "", true));
      }
      return lines.map(line => truncateToWidth(line, width, "", true));
    },
    handleMouse(event: TuiMouseEvent) {
      if (event.type !== "click" || event.button !== "left") return undefined;
      const id = hits.get(event.y);
      if (!id) return undefined;
      open(id);
      return { handled: true };
    },
    invalidate() {},
  };
}
