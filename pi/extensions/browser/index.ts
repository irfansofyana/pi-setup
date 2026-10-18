import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBrowser } from "./extension.ts";

export default function browserExtension(pi: ExtensionAPI): void {
  registerBrowser(pi, getAgentDir);
}
