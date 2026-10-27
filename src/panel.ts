import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayOptions } from "@earendil-works/pi-tui";

// Preserves Pi's standard two-line footer in fullscreen mode only.
// Regular mode can place the footer above the terminal bottom; custom/status footers also differ.
export const FOOTER_ROWS = 2;
export const panelOverlay: OverlayOptions = {
  width: "100%", maxHeight: "100%", anchor: "bottom-center", margin: { bottom: FOOTER_ROWS },
};
export const panelRule = (theme: Theme, width: number) =>
  new DynamicBorder(text => theme.fg("border", text)).render(width)[0];
export const panelLine = (text: string, width: number) =>
  " " + truncateToWidth(text, Math.max(1, width - 2), "", true) + " ";

export function hintRows(theme: Theme, hints: string[], width: number): string[] {
  const rows = [""];
  for (const hint of hints) {
    const previous = rows.at(-1)!;
    const next = previous ? `${previous} · ${hint}` : hint;
    if (previous && visibleWidth(next) > width) rows.push(hint);
    else rows[rows.length - 1] = next;
  }
  return rows.flatMap(row => wrapTextWithAnsi(theme.fg("muted", row), width));
}
