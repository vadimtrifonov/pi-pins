import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPins } from "./index.ts";
import { listSavedPins } from "./sessions.ts";

export default function (pi: ExtensionAPI) {
  registerPins(pi, listSavedPins);
}
