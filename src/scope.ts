import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PinScope = "current" | "all";

export function scopeHeader(theme: Theme, width: number, scope: PinScope) {
  const values = ["current", "all"] as const;
  const parts = ["Session", "All"].map((name, i) => `${scope === values[i] ? "◉" : "○"} ${name}`);
  const separator = " | ";
  const rightWidth = visibleWidth(parts.join(separator));
  const title = truncateToWidth("Pins", Math.max(0, width - rightWidth - 1), "…");
  const prefix = theme.bold(title) + " ".repeat(Math.max(1, width - rightWidth - visibleWidth(title)));
  return prefix + parts.map((part, i) => theme.fg(scope === values[i] ? "accent" : "muted", part)).join(theme.fg("muted", separator));
}
