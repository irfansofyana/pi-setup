/**
 * Local Caveman Pi extension.
 * Inspired by upstream Caveman-style Pi extension work; MIT notice in UPSTREAM-LICENSE.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const LEVELS = ["off", "lite", "full", "ultra", "micro"] as const;
export type Level = (typeof LEVELS)[number];
export type ActiveLevel = Exclude<Level, "off">;

const ACTIVE_LEVELS = LEVELS.filter((level): level is ActiveLevel => level !== "off");
const STOP_ALIASES = new Set(["off", "stop", "quit", "normal"]);
const ON_VALUES = new Set(["on", "true", "yes", "1", "enable", "enabled"]);
const OFF_VALUES = new Set(["off", "false", "no", "0", "disable", "disabled"]);

export interface CavemanConfig {
  /** Level applied when a new session has no session-level override. */
  defaultLevel: Level;
  /** Show footer/status indicator while active. */
  showStatus: boolean;
  /** Let natural phrases like "be brief" or "normal mode" toggle current session. */
  autoTrigger: boolean;
  /** Level used by natural-language start triggers. */
  triggerLevel: ActiveLevel;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "caveman", "config.json");
export const LEGACY_CONFIG_PATH = join(homedir(), ".pi", "agent", "caveman.json");
export const DEFAULT_CONFIG: CavemanConfig = {
  defaultLevel: "full",
  showStatus: true,
  autoTrigger: true,
  triggerLevel: "full",
};

const LEVEL_LABEL: Record<Level, string> = {
  off: "OFF",
  lite: "LITE",
  full: "FULL",
  ultra: "ULTRA",
  micro: "MICRO",
};

const COMMAND_OPTIONS = [
  { value: "lite", label: "lite", description: "Professional, no fluff" },
  { value: "full", label: "full", description: "Classic terse caveman" },
  { value: "ultra", label: "ultra", description: "Maximum compression" },
  { value: "micro", label: "micro", description: "Smallest prompt" },
  { value: "off", label: "off", description: "Disable caveman mode" },
  { value: "stop", label: "stop", description: "Disable caveman mode" },
  { value: "normal", label: "normal", description: "Disable caveman mode" },
  { value: "status", label: "status", description: "Show current mode/config" },
  { value: "config", label: "config", description: "Show config commands" },
  { value: "default", label: "default", description: "Persist default level" },
  { value: "status-bar", label: "status-bar", description: "Toggle footer status" },
  { value: "auto-trigger", label: "auto-trigger", description: "Toggle phrase triggers" },
] as const;

const BASE_PROMPT = `\
IMPORTANT: You are in CAVEMAN MODE. Respond terse like smart caveman. \
All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically/actually/simply), \
pleasantries, hedging
- Fragments OK. Short synonyms preferred. Technical terms exact
- Code blocks unchanged. Shell commands unchanged. JSON/YAML/TOML unchanged
- Errors, file paths, flags, API names, function names quoted exact
- Prefer bullets for final summaries. Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`;

const MICRO_PROMPT = `# Token efficiency
Respond like smart caveman. Cut filler, keep technical substance.
- Drop articles, filler, pleasantries, hedging.
- Fragments fine. Short synonyms. Technical terms exact.
- Code blocks, commands, data formats, quoted errors unchanged.
- Security warnings and irreversible actions use full clarity.`;

const INTENSITY: Record<Exclude<ActiveLevel, "micro">, string> = {
  lite: `\
No filler/hedging. Keep full sentences when useful. Professional but tight.
Example: "Your component re-renders because each render creates a new object reference. Wrap it in \`useMemo\`."`,

  full: `\
Drop articles, fragments OK, short synonyms.
Example: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."`,

  ultra: `\
Abbreviate common terms (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y). Use only when clarity survives.
Example: "Inline obj prop → new ref → re-render. \`useMemo\`."`,
};

const SAFETY_PROMPT = `\
Auto-clarity: drop caveman for security warnings, irreversible action confirmations, legal/compliance caveats, \
or when user is confused. Resume after.
Boundaries: write normal code and exact config. Only compress explanations. \
If user says "stop caveman", "normal mode", or "/caveman off", return to normal style.`;

export type ParsedCommand =
  | { kind: "toggle" }
  | { kind: "set-level"; level: Level }
  | { kind: "status" }
  | { kind: "show-config" }
  | { kind: "set-default"; level: Level }
  | { kind: "set-status"; showStatus: boolean }
  | { kind: "set-auto-trigger"; autoTrigger: boolean }
  | { kind: "set-trigger-level"; triggerLevel: ActiveLevel }
  | { kind: "help" }
  | { kind: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeLevel(value: unknown): Level | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return LEVELS.includes(normalized as Level) ? (normalized as Level) : undefined;
}

export function normalizeActiveLevel(value: unknown): ActiveLevel | undefined {
  const level = normalizeLevel(value);
  return level && level !== "off" ? level : undefined;
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (ON_VALUES.has(normalized)) return true;
  if (OFF_VALUES.has(normalized)) return false;
  return undefined;
}

export function normalizeCavemanConfig(input: unknown): CavemanConfig {
  if (!isRecord(input)) return { ...DEFAULT_CONFIG };

  const defaultLevel = normalizeLevel(input.defaultLevel) ?? DEFAULT_CONFIG.defaultLevel;
  const showStatus =
    parseBoolean(input.showStatus) ??
    parseBoolean(input.showFooter) ??
    DEFAULT_CONFIG.showStatus;
  const autoTrigger = parseBoolean(input.autoTrigger) ?? DEFAULT_CONFIG.autoTrigger;
  const triggerLevel = normalizeActiveLevel(input.triggerLevel) ?? DEFAULT_CONFIG.triggerLevel;

  return { defaultLevel, showStatus, autoTrigger, triggerLevel };
}

export async function loadCavemanConfig(): Promise<CavemanConfig> {
  for (const path of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      if (!existsSync(path)) continue;
      const raw = await readFile(path, "utf8");
      return normalizeCavemanConfig(JSON.parse(raw));
    } catch {
      // Ignore broken config and keep safe defaults.
    }
  }
  return { ...DEFAULT_CONFIG };
}

export async function saveCavemanConfig(config: CavemanConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function parseCavemanCommand(args?: string): ParsedCommand {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (!trimmed) return { kind: "toggle" };

  const [first = "", second = "", third = ""] = trimmed.split(/\s+/);

  if (first === "help" || first === "--help" || first === "-h") return { kind: "help" };
  if (first === "status") return { kind: "status" };
  if (first === "config" && !second) return { kind: "show-config" };
  if (first === "config" && second === "show") return { kind: "show-config" };

  const directLevel = normalizeLevel(first);
  if (directLevel) return { kind: "set-level", level: directLevel };
  if (STOP_ALIASES.has(first)) return { kind: "set-level", level: "off" };

  if (first === "default" || (first === "config" && second === "default")) {
    const requested = first === "default" ? second : third;
    const level = normalizeLevel(requested);
    return level
      ? { kind: "set-default", level }
      : { kind: "error", message: `Unknown default level: ${requested || "<missing>"}` };
  }

  if (first === "status-bar" || (first === "config" && second === "status-bar")) {
    const requested = first === "status-bar" ? second : third;
    const showStatus = parseBoolean(requested);
    return showStatus === undefined
      ? { kind: "error", message: `Use status-bar on|off, got: ${requested || "<missing>"}` }
      : { kind: "set-status", showStatus };
  }

  if (first === "auto-trigger" || (first === "config" && second === "auto-trigger")) {
    const requested = first === "auto-trigger" ? second : third;
    const autoTrigger = parseBoolean(requested);
    return autoTrigger === undefined
      ? { kind: "error", message: `Use auto-trigger on|off, got: ${requested || "<missing>"}` }
      : { kind: "set-auto-trigger", autoTrigger };
  }

  if (first === "trigger-level" || (first === "config" && second === "trigger-level")) {
    const requested = first === "trigger-level" ? second : third;
    const triggerLevel = normalizeActiveLevel(requested);
    return triggerLevel
      ? { kind: "set-trigger-level", triggerLevel }
      : { kind: "error", message: `Use trigger-level lite|full|ultra|micro, got: ${requested || "<missing>"}` };
  }

  return { kind: "error", message: `Unknown /caveman arg: ${trimmed}` };
}

export function buildCavemanPrompt(level: Level): string {
  if (level === "off") return "";
  if (level === "micro") return MICRO_PROMPT;
  return `${BASE_PROMPT}\n\n${INTENSITY[level]}\n\n${SAFETY_PROMPT}`;
}

export function promptTriggerDecision(prompt: string, config: CavemanConfig): Level | undefined {
  if (!config.autoTrigger) return undefined;
  const normalized = prompt.toLowerCase();
  if (/\b(stop caveman|disable caveman|caveman off|normal mode|talk normally|be normal|stop terse|less terse)\b/.test(normalized)) {
    return "off";
  }
  if (/\b(caveman mode|talk like caveman|less tokens|save tokens|be brief|be terse|terse mode|short answer|short answers)\b/.test(normalized)) {
    return config.triggerLevel;
  }
  return undefined;
}

export function statusText(level: Level, config: CavemanConfig): string {
  return [
    `level=${level}`,
    `default=${config.defaultLevel}`,
    `status=${config.showStatus ? "on" : "off"}`,
    `auto-trigger=${config.autoTrigger ? "on" : "off"}`,
    `trigger-level=${config.triggerLevel}`,
  ].join(" ");
}

export function configText(config: CavemanConfig): string {
  return [
    `Config path: ${CONFIG_PATH}`,
    `Legacy read path: ${LEGACY_CONFIG_PATH}`,
    "Commands:",
    "  /caveman [lite|full|ultra|micro|off]",
    "  /caveman default [off|lite|full|ultra|micro]",
    "  /caveman status-bar on|off",
    "  /caveman auto-trigger on|off",
    "  /caveman trigger-level [lite|full|ultra|micro]",
    "Current config:",
    JSON.stringify(config, null, 2),
  ].join("\n");
}

function readSessionLevel(ctx: ExtensionContext): Level | undefined {
  let found: Level | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== "caveman-level") continue;
    const data = entry.data;
    const level = isRecord(data) ? normalizeLevel(data.level) : undefined;
    if (level) found = level;
  }
  return found;
}

function persistSessionLevel(pi: ExtensionAPI, level: Level): void {
  pi.appendEntry("caveman-level", { level });
}

function setStatus(ctx: ExtensionContext, level: Level, config: CavemanConfig): void {
  if (level === "off" || !config.showStatus) {
    ctx.ui.setStatus("caveman", undefined);
    return;
  }

  const theme = ctx.ui.theme;
  ctx.ui.setStatus(
    "caveman",
    `${theme.fg("accent", "🪨")} ${theme.fg("muted", "caveman ")}${theme.fg("text", LEVEL_LABEL[level])}`,
  );
}

function notifyLevel(ctx: ExtensionContext, level: Level): void {
  ctx.ui.notify(level === "off" ? "Caveman mode off." : `Caveman mode ${LEVEL_LABEL[level]}.`, "info");
}

export default function caveman(pi: ExtensionAPI) {
  let level: Level = "off";
  let config: CavemanConfig = { ...DEFAULT_CONFIG };
  let configLoadPromise: Promise<void> | undefined;

  const ensureConfigLoaded = async () => {
    if (!configLoadPromise) {
      configLoadPromise = (async () => {
        config = await loadCavemanConfig();
        if (level === "off") level = config.defaultLevel;
      })();
    }
    await configLoadPromise;
  };

  const saveConfigAndNotify = async (ctx: ExtensionContext, message: string) => {
    await saveCavemanConfig(config);
    setStatus(ctx, level, config);
    ctx.ui.notify(`${message}\nSaved: ${CONFIG_PATH}`, "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    await ensureConfigLoaded();
    const sessionLevel = readSessionLevel(ctx);
    level = sessionLevel ?? config.defaultLevel;
    if (!sessionLevel && level !== "off") persistSessionLevel(pi, level);
    setStatus(ctx, level, config);
  });

  pi.on("agent_start", async (_event, ctx) => {
    setStatus(ctx, level, config);
  });

  pi.on("agent_end", async (_event, ctx) => {
    setStatus(ctx, level, config);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("caveman", undefined);
  });

  pi.registerCommand("caveman", {
    description: "Toggle terse caveman responses, set level, or configure local defaults",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const items = COMMAND_OPTIONS.filter((item) => item.value.startsWith(normalized));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      await ensureConfigLoaded();
      const parsed = parseCavemanCommand(args);

      switch (parsed.kind) {
        case "toggle":
          level = level === "off" ? config.triggerLevel : "off";
          persistSessionLevel(pi, level);
          setStatus(ctx, level, config);
          notifyLevel(ctx, level);
          return;
        case "set-level":
          level = parsed.level;
          persistSessionLevel(pi, level);
          setStatus(ctx, level, config);
          notifyLevel(ctx, level);
          return;
        case "status":
          ctx.ui.notify(statusText(level, config), "info");
          return;
        case "show-config":
        case "help":
          ctx.ui.notify(configText(config), "info");
          return;
        case "set-default":
          config = { ...config, defaultLevel: parsed.level };
          await saveConfigAndNotify(ctx, `Caveman default=${parsed.level}`);
          return;
        case "set-status":
          config = { ...config, showStatus: parsed.showStatus };
          await saveConfigAndNotify(ctx, `Caveman status-bar=${parsed.showStatus ? "on" : "off"}`);
          return;
        case "set-auto-trigger":
          config = { ...config, autoTrigger: parsed.autoTrigger };
          await saveConfigAndNotify(ctx, `Caveman auto-trigger=${parsed.autoTrigger ? "on" : "off"}`);
          return;
        case "set-trigger-level":
          config = { ...config, triggerLevel: parsed.triggerLevel };
          await saveConfigAndNotify(ctx, `Caveman trigger-level=${parsed.triggerLevel}`);
          return;
        case "error":
          ctx.ui.notify(`${parsed.message}\nRun /caveman config for help.`, "error");
          return;
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureConfigLoaded();

    const triggerLevel = promptTriggerDecision(event.prompt, config);
    if (triggerLevel) {
      level = triggerLevel;
      persistSessionLevel(pi, level);
      setStatus(ctx, level, config);
    }

    const prompt = buildCavemanPrompt(level);
    if (!prompt) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    };
  });
}
