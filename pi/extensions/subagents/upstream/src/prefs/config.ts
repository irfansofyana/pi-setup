import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isMap, isScalar, parseDocument, stringify } from "yaml";
import { getModelPreferences } from "./models.ts";
import { THINKING_LEVELS, type AgentType } from "../types.ts";
import type { ToolFilteringMode } from "./settings.ts";

// Pi semantic color tokens, resolved as concrete colors for agent name backgrounds.
export const AGENT_COLORS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "scrollbarTrack",
  "scrollbarThumb",
  "searchMatchText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const;

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const TOOL = /^[a-zA-Z0-9_-]+$/;
const FIELDS = new Set([
  "name",
  "description",
  "models",
  "model",
  "modelSuggestions",
  "thinkingLevel",
  "color",
  "icon",
  "tools",
]);
const SUBAGENT_MANAGER_DIR = "subagent-manager";
const AGENTS_DIR = "agents";

type AgentScope = "user" | "project";
type SaveOrigin = Pick<AgentType, "name" | "source" | "filePath">;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function lstatIfPresent(
  path: string,
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function assertNotSymlinkPath(
  path: string,
): ReturnType<typeof lstatSync> | undefined {
  const stat = lstatIfPresent(path);
  if (stat?.isSymbolicLink()) throw new Error(`Unsafe symlink path: ${path}`);
  return stat;
}

function validatePreservedDestination(
  filePath: string,
  directory: string,
  extensions: readonly string[] = [".md"],
): string {
  const resolved = resolve(filePath);
  if (
    dirname(resolved) !== directory ||
    !extensions.some((extension) => resolved.endsWith(extension))
  )
    throw new Error(`Unsafe agent destination: ${resolved}`);
  const stat = lstatIfPresent(resolved);
  if (!stat?.isFile()) throw new Error(`Unsafe agent destination: ${resolved}`);
  return resolved;
}

function frontmatter(content: string): { yaml: string; body: string } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(
    content,
  );
  if (!match || match.index !== 0)
    throw new Error("Expected YAML frontmatter enclosed by --- lines");
  return { yaml: match[1], body: content.slice(match[0].length) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

/** Advisory display names only. Empty means no suggestions; never a model pin. */
function modelSuggestionNames(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new Error("modelSuggestions must be an array of nonempty display names");
  const suggestions = value.map((entry, index) => {
    if (typeof entry !== "string")
      throw new Error(`modelSuggestions[${index}] must be a nonempty display name`);
    const name = entry.trim();
    if (!name) throw new Error(`modelSuggestions[${index}] must be a nonempty display name`);
    return name;
  });
  if (new Set(suggestions).size !== suggestions.length)
    throw new Error("modelSuggestions contains duplicate display names");
  return [...suggestions];
}

function toolNames(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== "string" || !TOOL.test(name))
  ) {
    throw new Error(
      `${label} must be an array of exact tool names (no wildcards or patterns)`,
    );
  }
  if (new Set(value).size !== value.length)
    throw new Error(`${label} contains duplicate tool names`);
  return [...value];
}

function toolPolicy(value: unknown): NonNullable<AgentType["tools"]> {
  const mapping = record(value, "tools");
  for (const key of Object.keys(mapping))
    if (key !== "allow" && key !== "block")
      throw new Error(`Unknown tools field: ${key}`);
  const result: NonNullable<AgentType["tools"]> = {};
  if (Object.hasOwn(mapping, "allow"))
    result.allow = toolNames(mapping.allow, "tools.allow");
  if (Object.hasOwn(mapping, "block"))
    result.block = toolNames(mapping.block, "tools.block");
  return result;
}

export function parseAgentType(content: string, filePath?: string): AgentType {
  try {
    const { yaml, body } = frontmatter(content);
    const doc = parseDocument(yaml, { uniqueKeys: true });
    if (doc.errors.length)
      throw new Error(doc.errors.map((error) => error.message).join("; "));
    const data = record(doc.toJS({ maxAliasCount: 0 }), "Frontmatter");
    for (const key of Object.keys(data))
      if (!FIELDS.has(key))
        throw new Error(`Unknown frontmatter field: ${key}`);
    if (typeof data.name !== "string" || !NAME.test(data.name))
      throw new Error(
        "name must be a safe identifier using letters, numbers, underscores or hyphens",
      );
    if (typeof data.description !== "string" || !data.description.trim())
      throw new Error("description must be a nonempty string");
    const result: AgentType = {
      name: data.name,
      description: data.description,
      systemPrompt: body,
    };
    const models = getModelPreferences({
      models: data.models,
      model: data.model,
    });
    if (models !== undefined) result.models = models;
    if (Object.hasOwn(data, "modelSuggestions"))
      result.modelSuggestions = modelSuggestionNames(data.modelSuggestions);
    if (Object.hasOwn(data, "thinkingLevel")) {
      if (
        !THINKING_LEVELS.includes(
          data.thinkingLevel as AgentType["thinkingLevel"] & string,
        )
      )
        throw new Error(
          `thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`,
        );
      result.thinkingLevel = data.thinkingLevel as AgentType["thinkingLevel"];
    }
    if (Object.hasOwn(data, "color")) {
      if (!AGENT_COLORS.includes(data.color as (typeof AGENT_COLORS)[number]))
        throw new Error(
          `color must be a Pi foreground token: ${AGENT_COLORS.join(", ")}`,
        );
      result.color = data.color as string;
    }
    if (Object.hasOwn(data, "icon")) {
      if (typeof data.icon !== "string" || !/^\p{Co}$/u.test(data.icon))
        throw new Error("icon must be a single literal Nerd Font glyph (Unicode private-use character)");
      result.icon = data.icon;
    }
    if (Object.hasOwn(data, "tools")) result.tools = toolPolicy(data.tools);
    if (filePath !== undefined) result.filePath = filePath;
    return result;
  } catch (error) {
    throw new Error(
      `${filePath ?? "Agent definition"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function serializeAgentType(type: AgentType): string {
  if (typeof type.systemPrompt !== "string")
    throw new Error("systemPrompt must be a string");
  const data: Record<string, unknown> = {
    name: type.name,
    description: type.description,
  };
  const models = getModelPreferences(type);
  if (models !== undefined) data.models = models;
  if (type.modelSuggestions !== undefined)
    data.modelSuggestions = modelSuggestionNames(type.modelSuggestions);
  for (const key of ["thinkingLevel", "color", "icon", "tools"] as const)
    if (type[key] !== undefined) data[key] = type[key];
  const content = `---\n${stringify(data)}---\n${type.systemPrompt}`;
  parseAgentType(content);
  return content;
}

export type AgentSettingsScope = "user" | "project";
export type AgentCustomizationKind = "fork" | "override";

/**
 * Sparse settings parsed from a `<name>.yml` override file. Plain YAML mapping,
 * no frontmatter, no Markdown body. Omitted fields follow the base definition;
 * explicit `null` on an optional field resets it to the base/inherit state.
 */
export interface AgentSettingsOverride {
  name?: string;
  description?: string;
  models?: string[] | null;
  /** @deprecated Single-model alias; normalized to models. */
  model?: string | null;
  modelSuggestions?: string[] | null;
  thinkingLevel?: AgentType["thinkingLevel"] | null;
  color?: string | null;
  icon?: string | null;
  tools?: NonNullable<AgentType["tools"]> | null;
}

export const AGENT_OVERRIDE_EXTENSIONS = [".yml", ".yaml"] as const;

function overrideBaseName(file: string): string | undefined {
  for (const extension of AGENT_OVERRIDE_EXTENSIONS)
    if (file.endsWith(extension)) return file.slice(0, -extension.length);
  return undefined;
}

export function isAgentOverrideFile(file: string): boolean {
  return overrideBaseName(file) !== undefined;
}

function nullableField<T>(value: unknown, validate: (value: unknown) => T): T | null {
  if (value === null) return null;
  return validate(value);
}

/**
 * Parse a settings-only `<name>.yml` override. Rejects prompt bodies and
 * unknown fields; validates shared fields with the same rules as full
 * definitions. `expectedName` (the file basename) must match `name` when set.
 */
export function parseAgentSettings(
  content: string,
  filePath?: string,
  expectedName?: string,
): AgentSettingsOverride {
  const label = filePath ?? "Agent settings override";
  try {
    if (/^\uFEFF?---[ \t]*\r?\n/m.test(content) || content.includes("\n---"))
      throw new Error(
        "Settings overrides are plain YAML with no frontmatter and no Markdown body",
      );
    const doc = parseDocument(content, { uniqueKeys: true });
    if (doc.errors.length)
      throw new Error(doc.errors.map((error) => error.message).join("; "));
    const data = record(doc.toJS({ maxAliasCount: 0 }) ?? {}, "Settings override");
    for (const key of Object.keys(data)) {
      if (key === "systemPrompt" || key === "prompt" || key === "body")
        throw new Error(
          `Settings overrides carry no prompt body; "${key}" belongs in a <name>.md fork`,
        );
      if (!FIELDS.has(key)) throw new Error(`Unknown settings field: ${key}`);
    }
    const result: AgentSettingsOverride = {};
    if (Object.hasOwn(data, "name")) {
      if (typeof data.name !== "string" || !NAME.test(data.name))
        throw new Error(
          "name must be a safe identifier using letters, numbers, underscores or hyphens",
        );
      if (expectedName !== undefined && data.name !== expectedName)
        throw new Error(
          `name ${JSON.stringify(data.name)} does not match override file ${JSON.stringify(expectedName)}`,
        );
      result.name = data.name;
    }
    if (Object.hasOwn(data, "description")) {
      if (typeof data.description !== "string" || !data.description.trim())
        throw new Error("description must be a nonempty string");
      result.description = data.description;
    }
    const hasModels = Object.hasOwn(data, "models");
    const hasModel = Object.hasOwn(data, "model");
    if (hasModels && hasModel)
      throw new Error("Specify either models or model, not both");
    if (hasModels)
      result.models = nullableField(data.models, (value) =>
        getModelPreferences({ models: value }),
      ) as string[] | null | undefined;
    if (hasModel) {
      if (data.model === null) result.model = null;
      else
        result.models = getModelPreferences({ model: data.model }) as string[];
    }
    if (Object.hasOwn(data, "modelSuggestions"))
      result.modelSuggestions = nullableField(data.modelSuggestions, (value) =>
        modelSuggestionNames(value),
      );
    if (Object.hasOwn(data, "thinkingLevel"))
      result.thinkingLevel = nullableField(data.thinkingLevel, (value) => {
        if (!THINKING_LEVELS.includes(value as AgentType["thinkingLevel"] & string))
          throw new Error(
            `thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`,
          );
        return value as AgentType["thinkingLevel"];
      });
    if (Object.hasOwn(data, "color"))
      result.color = nullableField(data.color, (value) => {
        if (!AGENT_COLORS.includes(value as (typeof AGENT_COLORS)[number]))
          throw new Error(
            `color must be a Pi foreground token: ${AGENT_COLORS.join(", ")}`,
          );
        return value as string;
      });
    if (Object.hasOwn(data, "icon"))
      result.icon = nullableField(data.icon, (value) => {
        if (typeof value !== "string" || !/^\p{Co}$/u.test(value))
          throw new Error(
            "icon must be a single literal Nerd Font glyph (Unicode private-use character)",
          );
        return value;
      });
    if (Object.hasOwn(data, "tools"))
      result.tools = data.tools === null ? null : toolPolicy(data.tools);
    return result;
  } catch (error) {
    throw new Error(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function serializeAgentSettings(override: AgentSettingsOverride): string {
  const data: Record<string, unknown> = {};
  if (override.name !== undefined) data.name = override.name;
  if (override.description !== undefined) data.description = override.description;
  const models = getModelPreferences({
    models: override.models ?? undefined,
    model: override.model ?? undefined,
  } as { models?: unknown; model?: unknown });
  if (override.models === null || override.model === null) data.models = null;
  else if (models !== undefined) data.models = models;
  if (override.modelSuggestions !== undefined)
    data.modelSuggestions =
      override.modelSuggestions === null
        ? null
        : modelSuggestionNames(override.modelSuggestions);
  for (const key of ["thinkingLevel", "color", "icon", "tools"] as const)
    if (override[key] !== undefined) data[key] = override[key];
  const content = `${stringify(data)}`;
  parseAgentSettings(content);
  return content;
}

/** Fields an override may clear back to the base/inherit state with null. */
const CLEARABLE_OVERRIDE_FIELDS = new Set([
  "models",
  "modelSuggestions",
  "thinkingLevel",
  "color",
  "icon",
  "tools",
]);

/**
 * Merge a sparse settings override on top of a base definition. Unset fields
 * follow the base; explicit null clears the field. The prompt body always
 * comes from the base.
 */
export function mergeAgentSettings(
  base: AgentType,
  override: AgentSettingsOverride,
): AgentType {
  const merged: AgentType = structuredClone(base);
  if (override.description !== undefined) merged.description = override.description;
  const models = getModelPreferences({
    models: override.models ?? undefined,
    model: override.model ?? undefined,
  } as { models?: unknown; model?: unknown });
  if (override.models === null || override.model === null) {
    delete merged.models;
    delete merged.model;
  } else if (models !== undefined) {
    merged.models = [...models];
    delete merged.model;
  }
  for (const key of [
    "modelSuggestions",
    "thinkingLevel",
    "color",
    "icon",
    "tools",
  ] as const) {
    const value = override[key];
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else (merged[key] as unknown) = structuredClone(value);
  }
  merged.systemPrompt = base.systemPrompt;
  return merged;
}

/**
 * Diff a draft against its base: only changed settings land in the override
 * file, so untouched fields keep tracking bundled updates. Always includes
 * the agent name for readability.
 */
export function diffAgentSettings(base: AgentType, draft: AgentType): AgentSettingsOverride {
  const override: AgentSettingsOverride = { name: draft.name };
  if (draft.description !== base.description) override.description = draft.description;
  const baseModels = getModelPreferences(base);
  const draftModels = getModelPreferences(draft);
  const sameModels =
    (baseModels === undefined && draftModels === undefined) ||
    (baseModels !== undefined &&
      draftModels !== undefined &&
      baseModels.length === draftModels.length &&
      baseModels.every((model, index) => model === draftModels[index]));
  if (!sameModels) {
    if (draftModels === undefined) override.models = null;
    else override.models = [...draftModels];
  }
  for (const key of [
    "modelSuggestions",
    "thinkingLevel",
    "color",
    "icon",
    "tools",
  ] as const) {
    const before = base[key];
    const after = draft[key];
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
    if (after === undefined) override[key] = null as never;
    else (override[key] as unknown) = structuredClone(after);
  }
  void CLEARABLE_OVERRIDE_FIELDS;
  return override;
}

export function selectTools(
  policy: AgentType["tools"],
  available: string[],
  mode: ToolFilteringMode = "allowed",
): string[] {
  const names = new Set(available);
  if (mode === "all") return [...names];
  // Ignored lists do not participate in validation or tool selection.
  const relevantPolicy =
    mode === "all-except-blocked"
      ? policy?.block === undefined
        ? {}
        : { block: policy.block }
      : policy;
  const validated = relevantPolicy === undefined ? {} : toolPolicy(relevantPolicy);
  for (const name of [...(validated.allow ?? []), ...(validated.block ?? [])]) {
    if (!names.has(name)) throw new Error(`Unavailable tool name: ${name}`);
  }
  const allow = mode === "all-except-blocked" ? names : new Set(validated.allow ?? []);
  const block = new Set(validated.block ?? []);
  return [...names].filter((name) => allow.has(name) && !block.has(name));
}

export interface ConfigStoreOptions {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
  bundledDir?: string;
}

export class ConfigStore {
  diagnostics: string[] = [];
  private types = new Map<string, AgentType>();
  private bases = new Map<string, AgentType>();
  private readonly options: ConfigStoreOptions;

  constructor(options: ConfigStoreOptions) {
    this.options = { ...options };
    this.reload();
  }

  reload(): void {
    this.types.clear();
    this.bases.clear();
    this.diagnostics = [];
    const layers: [string, NonNullable<AgentType["source"]>][] = [
      [
        this.options.bundledDir ??
          fileURLToPath(new URL("../../agents/", import.meta.url)),
        "bundled",
      ],
      ...this.scopeDirectories("user").map(
        (directory): [string, NonNullable<AgentType["source"]>] => [
          directory,
          "user",
        ],
      ),
    ];
    if (this.options.includeProject)
      layers.push(
        ...this.scopeDirectories("project").map(
          (directory): [string, NonNullable<AgentType["source"]>] => [
            directory,
            "project",
          ],
        ),
      );
    for (const [directory, source] of layers) {
      let files: string[];
      try {
        const stat = assertNotSymlinkPath(directory);
        if (!stat) continue;
        if (!stat.isDirectory())
          throw new Error(`Agent directory must be a directory: ${directory}`);
        files = readdirSync(directory)
          .filter(
            (file) => file.endsWith(".md") || isAgentOverrideFile(file),
          )
          .sort();
      } catch (error) {
        this.diagnostics.push(`${directory}: ${String(error)}`);
        // An unreadable override layer cannot safely expose lower-precedence policies.
        this.types.clear();
        this.bases.clear();
        continue;
      }
      if (source === "bundled") {
        this.loadBundledLayer(directory, files);
        continue;
      }
      this.applyScopeLayer(directory, source, files);
    }
  }

  /** Bundled layer: full `<name>.md` definitions only; overrides are rejected. */
  private loadBundledLayer(directory: string, files: string[]): void {
    const blocked = new Set<string>();
    const seenNames = new Set<string>();
    for (const file of files) {
      const filePath = join(directory, file);
      if (isAgentOverrideFile(file)) {
        blocked.add(overrideBaseName(file)!);
        this.diagnostics.push(
          `${filePath}: Settings overrides (<name>.yml) are not allowed in the bundled layer`,
        );
        continue;
      }
      let content = "";
      try {
        if (!lstatSync(filePath).isFile())
          throw new Error(
            "Agent definition must be a regular file, not a symlink",
          );
        content = readFileSync(filePath, "utf8");
        const type = parseAgentType(content, filePath);
        if (seenNames.has(type.name)) {
          blocked.add(type.name);
          this.diagnostics.push(
            `${filePath}: Duplicate agent name in bundled layer: ${type.name}`,
          );
          continue;
        }
        seenNames.add(type.name);
        this.types.set(type.name, { ...type, source: "bundled" });
      } catch (error) {
        blocked.add(file.slice(0, -3));
        // Extract declared names even if another field or duplicate key is malformed.
        try {
          const doc = parseDocument(frontmatter(content).yaml);
          if (isMap(doc.contents))
            for (const pair of doc.contents.items) {
              if (
                isScalar(pair.key) &&
                pair.key.value === "name" &&
                isScalar(pair.value) &&
                typeof pair.value.value === "string"
              )
                blocked.add(pair.value.value);
            }
        } catch {
          /* Filename still provides a fail-closed tombstone. */
        }
        this.diagnostics.push(`${filePath}: ${String(error)}`);
      }
    }
    for (const name of blocked) {
      this.types.delete(name);
      this.bases.delete(name);
    }
  }

  /**
   * User/project layer: `<name>.md` is a full fork (replaces the base),
   * `<name>.yml` is a settings-only override merged on top of the base.
   * Having both for one name, duplicate declarations, malformed files, or an
   * override without a base fails closed for that agent name.
   */
  private applyScopeLayer(
    directory: string,
    scope: AgentSettingsScope,
    files: string[],
  ): void {
    const blocked = new Set<string>();
    const forks = new Map<string, { type: AgentType; file: string }>();
    const overrides = new Map<
      string,
      { override: AgentSettingsOverride; file: string }
    >();
    const forkNames = new Set<string>();
    const declareBlocked = (name: string) => {
      blocked.add(name);
    };
    for (const file of files) {
      const filePath = join(directory, file);
      const overrideName = overrideBaseName(file);
      if (overrideName !== undefined) {
        if (!NAME.test(overrideName)) {
          declareBlocked(overrideName);
          this.diagnostics.push(`${filePath}: Invalid agent name in override filename`);
          continue;
        }
        let content = "";
        try {
          if (!lstatSync(filePath).isFile())
            throw new Error(
              "Agent settings override must be a regular file, not a symlink",
            );
          content = readFileSync(filePath, "utf8");
          const override = parseAgentSettings(content, filePath, overrideName);
          const key = override.name ?? overrideName;
          if (forkNames.has(key)) {
            declareBlocked(key);
            this.diagnostics.push(
              `${filePath}: Use either ${key}.md (full fork) or ${key}.yml (settings override), not both`,
            );
            continue;
          }
          if (overrides.has(key)) {
            declareBlocked(key);
            this.diagnostics.push(
              `${filePath}: Duplicate agent override in ${scope} layer: ${key}`,
            );
            continue;
          }
          overrides.set(key, { override, file });
        } catch (error) {
          declareBlocked(overrideName);
          try {
            const doc = parseDocument(content);
            if (isMap(doc.contents))
              for (const pair of doc.contents.items) {
                if (
                  isScalar(pair.key) &&
                  pair.key.value === "name" &&
                  isScalar(pair.value) &&
                  typeof pair.value.value === "string"
                )
                  declareBlocked(pair.value.value);
              }
          } catch {
            /* Filename still provides a fail-closed tombstone. */
          }
          this.diagnostics.push(`${filePath}: ${String(error)}`);
        }
        continue;
      }
      let content = "";
      try {
        if (!lstatSync(filePath).isFile())
          throw new Error(
            "Agent definition must be a regular file, not a symlink",
          );
        content = readFileSync(filePath, "utf8");
        const type = parseAgentType(content, filePath);
        if (overrides.has(type.name)) {
          declareBlocked(type.name);
          this.diagnostics.push(
            `${filePath}: Use either ${type.name}.md (full fork) or ${type.name}.yml (settings override), not both`,
          );
          continue;
        }
        if (forkNames.has(type.name)) {
          declareBlocked(type.name);
          this.diagnostics.push(
            `${filePath}: Duplicate agent name in ${scope} layer: ${type.name}`,
          );
          continue;
        }
        forkNames.add(type.name);
        forks.set(type.name, { type, file });
      } catch (error) {
        declareBlocked(file.slice(0, -3));
        try {
          const doc = parseDocument(frontmatter(content).yaml);
          if (isMap(doc.contents))
            for (const pair of doc.contents.items) {
              if (
                isScalar(pair.key) &&
                pair.key.value === "name" &&
                isScalar(pair.value) &&
                typeof pair.value.value === "string"
              )
                declareBlocked(pair.value.value);
            }
        } catch {
          /* Filename still provides a fail-closed tombstone. */
        }
        this.diagnostics.push(`${filePath}: ${String(error)}`);
      }
    }
    for (const name of [...forks.keys()].filter((name) => overrides.has(name))) {
      declareBlocked(name);
      this.diagnostics.push(
        `${join(directory, forks.get(name)!.file)} and ${join(directory, overrides.get(name)!.file)}: ` +
          `Use either ${name}.md (full fork) or ${name}.yml (settings override), not both`,
      );
    }
    for (const [name, { type, file }] of forks) {
      if (blocked.has(name)) continue;
      const filePath = join(directory, file);
      const base = this.types.get(name);
      const fork: AgentType = {
        ...type,
        source: scope,
        filePath,
        customization: { kind: "fork", scope, filePath },
        baseSource: base?.source,
        baseFilePath: base?.filePath,
      };
      this.bases.set(name, base ? structuredClone(base) : structuredClone(fork));
      this.types.set(name, fork);
    }
    for (const [name, { override, file }] of overrides) {
      if (blocked.has(name)) continue;
      const filePath = join(directory, file);
      const base = this.types.get(name);
      if (!base) {
        declareBlocked(name);
        this.diagnostics.push(
          `${filePath}: Settings override has no base agent named ${JSON.stringify(name)}; ` +
            `create ${name}.md first or remove the override`,
        );
        continue;
      }
      try {
        const merged = mergeAgentSettings(base, { ...override, name });
        this.bases.set(name, structuredClone(base));
        this.types.set(name, {
          ...merged,
          name,
          source: scope,
          filePath,
          customization: { kind: "override", scope, filePath },
          baseSource: base.source,
          baseFilePath: base.filePath,
        });
      } catch (error) {
        declareBlocked(name);
        this.diagnostics.push(`${filePath}: ${String(error)}`);
      }
    }
    for (const name of blocked) {
      this.types.delete(name);
      this.bases.delete(name);
    }
  }

  list(): AgentType[] {
    return structuredClone(
      [...this.types.values()].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  get(name: string): AgentType {
    const type = this.types.get(name);
    if (!type) throw new Error(`Unknown or invalid agent type: ${name}`);
    return structuredClone(type);
  }

  canSaveProject(): boolean {
    return this.options.includeProject;
  }

  private preferredScopeDirectory(scope: AgentScope): string {
    if (scope !== "user" && scope !== "project")
      throw new Error("Invalid agent scope");
    if (scope === "project" && !this.options.includeProject)
      throw new Error("Project agents are not enabled/trusted");
    return scope === "user"
      ? resolve(this.options.agentDir, SUBAGENT_MANAGER_DIR, AGENTS_DIR)
      : resolve(
          this.options.cwd,
          ".pi",
          "agent",
          SUBAGENT_MANAGER_DIR,
          AGENTS_DIR,
        );
  }

  // Manager-owned storage only. Do not scan legacy Pi agent packages.
  private scopeDirectories(scope: AgentScope): string[] {
    return [this.preferredScopeDirectory(scope)];
  }

  private destinationBasePaths(scope: AgentScope, directory: string): string[] {
    if (scope === "user") {
      const base = resolve(this.options.agentDir);
      return [base, join(base, SUBAGENT_MANAGER_DIR), directory];
    }
    const base = resolve(this.options.cwd);
    const projectPi = join(base, ".pi");
    const projectAgent = join(projectPi, "agent");
    return [
      base,
      projectPi,
      projectAgent,
      join(projectAgent, SUBAGENT_MANAGER_DIR),
      directory,
    ];
  }

  /** Base definition under the top customization, for diffing and read-only display. */
  getBase(name: string): AgentType | undefined {
    const base = this.bases.get(name);
    return base ? structuredClone(base) : undefined;
  }

  private canPreserveDestination(
    name: string,
    scope: AgentScope,
    original: SaveOrigin | undefined,
    kind: AgentCustomizationKind,
  ): boolean {
    if (
      original?.name !== name ||
      original.source !== scope ||
      typeof original.filePath !== "string" ||
      dirname(resolve(original.filePath)) !==
        this.preferredScopeDirectory(scope)
    )
      return false;
    const preserved = resolve(original.filePath);
    if (kind === "fork") return preserved.endsWith(".md");
    return AGENT_OVERRIDE_EXTENSIONS.some((extension) =>
      preserved.endsWith(extension),
    );
  }

  destination(
    name: string,
    scope: AgentScope,
    original?: SaveOrigin,
    kind: AgentCustomizationKind = "fork",
  ): string {
    if (!NAME.test(name)) throw new Error("Unsafe agent name");
    const directory = this.preferredScopeDirectory(scope);
    if (
      this.canPreserveDestination(name, scope, original, kind) &&
      typeof original?.filePath === "string"
    ) {
      return validatePreservedDestination(
        original.filePath,
        directory,
        kind === "fork" ? [".md"] : [...AGENT_OVERRIDE_EXTENSIONS],
      );
    }
    return resolve(directory, `${name}${kind === "fork" ? ".md" : ".yml"}`);
  }

  private writeContent(filePath: string, name: string, content: string): void {
    const directory = dirname(filePath);
    mkdirSync(directory, { recursive: true });
    const temporary = join(
      dirname(filePath),
      `.${name}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      renameSync(temporary, filePath);
    } finally {
      if (lstatIfPresent(temporary)) unlinkSync(temporary);
    }
  }

  private assertWritableDestination(filePath: string, scope: AgentScope): void {
    const directory = dirname(filePath);
    // Reject redirected destination directories and files before writing.
    for (const path of [
      ...this.destinationBasePaths(scope, directory),
      filePath,
    ]) {
      const stat = assertNotSymlinkPath(path);
      if (path === filePath && stat && !stat.isFile())
        throw new Error(`Unsafe agent destination: ${filePath}`);
    }
  }

  /** Save a full `<name>.md` fork. Replaces the base definition entirely. */
  save(type: AgentType, scope: AgentScope, original?: SaveOrigin): AgentType {
    const content = serializeAgentType(type);
    const validated = parseAgentType(content);
    const filePath = this.destination(validated.name, scope, original, "fork");
    this.assertWritableDestination(filePath, scope);
    this.writeContent(filePath, validated.name, content);
    this.reload();
    return this.get(validated.name);
  }

  /**
   * Save a settings-only `<name>.yml` override merged on top of the base.
   * The prompt body always comes from the base; only changed settings are
   * written so untouched fields keep tracking bundled updates.
   */
  saveOverride(
    name: string,
    draft: AgentType,
    scope: AgentScope,
    original?: SaveOrigin,
  ): AgentType {
    if (!NAME.test(name)) throw new Error("Unsafe agent name");
    if (draft.name !== name)
      throw new Error("Settings overrides cannot rename the agent; fork it instead");
    const base = this.getBase(name) ?? (() => {
      try {
        return this.get(name);
      } catch {
        return undefined;
      }
    })();
    if (!base) throw new Error(`Settings override has no base agent named ${JSON.stringify(name)}`);
    if (base.name !== name)
      throw new Error(`Settings override has no base agent named ${JSON.stringify(name)}`);
    const override = diffAgentSettings(base, { ...draft, name });
    const content = serializeAgentSettings(override);
    parseAgentSettings(content, undefined, name);
    const filePath = this.destination(name, scope, original, "override");
    this.assertWritableDestination(filePath, scope);
    this.writeContent(filePath, name, content);
    this.reload();
    return this.get(name);
  }

  /** Remove a user/project customization so the base definition shows through. */
  removeCustomization(name: string, scope: AgentScope): void {
    const current = this.types.get(name);
    const customization = current?.customization;
    if (!customization || customization.scope !== scope)
      throw new Error(`No ${scope} customization found for ${JSON.stringify(name)}`);
    const resolved = resolve(customization.filePath);
    if (
      dirname(resolved) !== this.preferredScopeDirectory(scope) ||
      (!resolved.endsWith(".md") &&
        !AGENT_OVERRIDE_EXTENSIONS.some((extension) => resolved.endsWith(extension)))
    )
      throw new Error(`Unsafe agent destination: ${resolved}`);
    const stat = lstatIfPresent(resolved);
    if (!stat?.isFile()) throw new Error(`Unsafe agent destination: ${resolved}`);
    unlinkSync(resolved);
    this.reload();
  }
}

