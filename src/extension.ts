import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPins } from "./index.ts";

export default function (pi: ExtensionAPI) {
  registerPins(pi);
}
