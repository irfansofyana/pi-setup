import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { companionConfigured, DEFAULT_NATIVE_CAPS, validateNativeConfig } from "./config.ts";

async function readOptionalJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Reads user-owned configuration only; never creates or migrates it.
export async function nativeActivation(agentDir: string, cwd: string, requested = process.env.PI_SETUP_SUBAGENTS_NATIVE) {
  if (requested === "0") return undefined;
  const input = await readOptionalJson(join(agentDir, "subagents-native.json"));
  if (input?.version === 1 && input.enabled === false) return undefined;
  for (const path of [join(agentDir, "settings.json"), join(cwd, ".pi/settings.json")]) {
    if (companionConfigured(await readOptionalJson(path))) {
      if (requested === "1") throw Error("Companion conflict: review/disable Tintinweb source before native activation");
      return undefined;
    }
  }
  return validateNativeConfig(input ?? {
    version: 1,
    enabled: true,
    ...DEFAULT_NATIVE_CAPS,
  });
}
