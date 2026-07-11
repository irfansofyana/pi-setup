import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile, readRegularFileSync } from "./filesystem.ts";
import type { ManagedSkillsConfig } from "./types.ts";

export const DEFAULT_MAX_MANAGED_SKILL_BYTES = 64_000;
export const DEFAULT_MAX_LEARN_MEMORY_CHARS = 12_000;
export const DEFAULT_CONFIG: ManagedSkillsConfig = Object.freeze({
  enabled: true,
  learnEnabled: true,
  autoCapture: false,
  autoContinue: false,
  minToolCalls: 5,
  maxSkillBytes: DEFAULT_MAX_MANAGED_SKILL_BYTES,
  maxMemoryChars: DEFAULT_MAX_LEARN_MEMORY_CHARS,
});

export const AGENT_DIR = join(homedir(), ".pi", "agent");
export const MANAGED_SKILLS_DIR = join(AGENT_DIR, "managed-skills");
export const CONFIG_PATH = join(MANAGED_SKILLS_DIR, "config.json");
export const HINDSIGHT_CONFIG_PATH = join(AGENT_DIR, "hindsight", "config.json");

export function getManagedSkillsDir(): string {
  return MANAGED_SKILLS_DIR;
}

export function getManagedSkillsConfigPath(): string {
  return CONFIG_PATH;
}

export interface ManagedSkillsConfigResult {
  config: ManagedSkillsConfig;
  diagnostic?: string;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

export function normalizeManagedSkillsConfig(value: unknown): ManagedSkillsConfig {
  const obj = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ManagedSkillsConfig>
    : {};
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled,
    learnEnabled: typeof obj.learnEnabled === "boolean" ? obj.learnEnabled : DEFAULT_CONFIG.learnEnabled,
    autoCapture: typeof obj.autoCapture === "boolean" ? obj.autoCapture : DEFAULT_CONFIG.autoCapture,
    autoContinue: typeof obj.autoContinue === "boolean" ? obj.autoContinue : DEFAULT_CONFIG.autoContinue,
    minToolCalls: Number.isFinite(obj.minToolCalls) && Number(obj.minToolCalls) >= 0
      ? Math.floor(Number(obj.minToolCalls))
      : DEFAULT_CONFIG.minToolCalls,
    maxSkillBytes: positiveInteger(obj.maxSkillBytes, DEFAULT_CONFIG.maxSkillBytes),
    maxMemoryChars: positiveInteger(obj.maxMemoryChars, DEFAULT_CONFIG.maxMemoryChars),
  };
}

function failClosedConfig(): ManagedSkillsConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: false,
    learnEnabled: false,
    autoCapture: false,
    autoContinue: false,
  };
}

function validateManagedSkillsConfig(value: Record<string, unknown>): void {
  const booleanKeys = ["enabled", "learnEnabled", "autoCapture", "autoContinue"] as const;
  const numericKeys = ["minToolCalls", "maxSkillBytes", "maxMemoryChars"] as const;
  const allowedKeys = new Set<string>([...booleanKeys, ...numericKeys]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`unknown field "${key}"`);
  }
  for (const key of booleanKeys) {
    if (key in value && typeof value[key] !== "boolean") throw new Error(`field "${key}" must be a boolean`);
  }
  for (const key of numericKeys) {
    if (!(key in value)) continue;
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`field "${key}" must be a finite number`);
    if (key === "minToolCalls" ? number < 0 : number <= 0) throw new Error(`field "${key}" is outside its allowed range`);
  }
}

export function readManagedSkillsConfig(configPath = CONFIG_PATH): ManagedSkillsConfigResult {
  try {
    const text = readRegularFileSync(configPath, {
      label: "Managed-skills config",
      maxBytes: 1_000_000,
    });
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    validateManagedSkillsConfig(parsed as Record<string, unknown>);
    return { config: normalizeManagedSkillsConfig(parsed) };
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { config: DEFAULT_CONFIG };
    const reason = err instanceof Error ? err.message : String(err);
    return {
      config: failClosedConfig(),
      diagnostic: `Invalid managed-skills config at ${configPath}: ${reason}. Managed skills are disabled until the file is corrected.`,
    };
  }
}

export async function writeManagedSkillsConfig(config: ManagedSkillsConfig, configPath = CONFIG_PATH): Promise<void> {
  const content = `${JSON.stringify(normalizeManagedSkillsConfig(config), null, 2)}\n`;
  await atomicWriteFile(configPath, content, { mode: 0o600 });
}
