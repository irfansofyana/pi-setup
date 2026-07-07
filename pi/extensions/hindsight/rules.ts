import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Rule, RuleBucket } from "./types.ts";

export const RULES_DIR = join(homedir(), ".pi", "agent", "rules");

export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const data: Record<string, unknown> = {};
  const lines = raw.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { data, body: raw };
  }
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "---") {
      index++;
      break;
    }
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2].trim();
      if (value === "") {
        const items: string[] = [];
        let j = index + 1;
        while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
          const itemMatch = lines[j].match(/^\s*-\s+(.*)$/);
          if (itemMatch) items.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
          j++;
        }
        if (items.length > 0) {
          data[key] = items;
          index = j;
          continue;
        }
        data[key] = "";
      } else {
        data[key] = value.replace(/^["']|["']$/g, "");
      }
    }
    index++;
  }
  const body = lines.slice(index).join("\n").replace(/^\n+/, "");
  return { data, body };
}

function toStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return undefined;
}

function toBool(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function toRepeat(value: unknown): Rule["repeat"] | undefined {
  return value === "always" || value === "once" || value === "gap" ? value : undefined;
}

function toNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

export function buildRuleFromMarkdown(
  name: string,
  path: string,
  raw: string,
  provider: string,
  priority: number,
): Rule {
  const { data, body } = parseFrontmatter(raw);
  const conditionRaw = data.condition ?? data.ttsr_trigger;
  const condition = toStringArray(conditionRaw);
  const globs = toStringArray(data.globs);
  const astCondition = toStringArray(data.astCondition);
  const scope = toStringArray(data.scope);
  const alwaysApply = toBool(data.alwaysApply);
  const repeat = toRepeat(data.repeat);
  const repeatGap = toNumber(data.repeatGap);
  return {
    name,
    path,
    content: body,
    ...(globs ? { globs } : {}),
    ...(alwaysApply !== undefined ? { alwaysApply } : {}),
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    ...(condition ? { condition } : {}),
    ...(astCondition ? { astCondition } : {}),
    ...(scope ? { scope } : {}),
    ...(typeof data.interruptMode === "string" ? { interruptMode: data.interruptMode as Rule["interruptMode"] } : {}),
    ...(repeat ? { repeat } : {}),
    ...(repeatGap !== undefined ? { repeatGap } : {}),
    provider,
    priority,
  };
}

function readDirRules(dir: string, provider: string, priority: number): Rule[] {
  if (!existsSync(dir)) return [];
  const rules: Rule[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md") && !name.endsWith(".mdc")) continue;
    const path = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    rules.push(buildRuleFromMarkdown(name.replace(/\.(md|mdc)$/, ""), path, raw, provider, priority));
  }
  return rules;
}

function synthesizeRule(path: string, name: string, provider: string, priority: number): Rule[] {
  if (!existsSync(path)) return [];
  try {
    return [{ name, path, content: readFileSync(path, "utf8"), alwaysApply: true, provider, priority }];
  } catch {
    return [];
  }
}

export function builtinDefaultRules(): Rule[] {
  return [
    {
      name: "hindsight-secret-safety",
      path: "builtin://hindsight-secret-safety",
      content: "Do not retain secrets, tokens, passwords, API keys, or credentials in Hindsight memory. Redact sensitive values before any memory write.",
      alwaysApply: true,
      provider: "builtin-defaults",
      priority: 1,
    },
    {
      name: "hindsight-memory-staleness",
      path: "builtin://hindsight-memory-staleness",
      content: "Hindsight memory is heuristic and may be stale. If memory conflicts with current repo state or user instruction, trust the repo/user. Cite the memory artifact path when memory changes the plan.",
      description: "Treat Hindsight memory as heuristic/stale and cite changed-plan memory artifact paths.",
      provider: "builtin-defaults",
      priority: 1,
    },
  ];
}

export function discoverRules(cwd: string = process.cwd(), nativeRulesDir?: string): Rule[] {
  const nativeDir = nativeRulesDir ?? (cwd === RULES_DIR ? cwd : RULES_DIR);
  const rules = [
    ...readDirRules(nativeDir, "native", 100),
    ...readDirRules(join(cwd, ".cursor", "rules"), "cursor", 50),
    ...readDirRules(join(cwd, ".windsurf", "rules"), "windsurf", 50),
    ...readDirRules(join(cwd, ".cline", "rules"), "cline", 40),
    ...synthesizeRule(join(cwd, "AGENTS.md"), "AGENTS", "agents", 70),
    ...synthesizeRule(join(cwd, "RULES.md"), "RULES", "rules", 100),
    ...builtinDefaultRules(),
  ];
  return rules.sort((a, b) => b.priority - a.priority);
}

export function splitBuckets(rules: Rule[]): Record<RuleBucket, Rule[]> {
  const ttsr: Rule[] = [];
  const alwaysApply: Rule[] = [];
  const rulebook: Rule[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.name)) continue;
    seen.add(rule.name);
    if ((rule.condition && rule.condition.length > 0) || (rule.astCondition && rule.astCondition.length > 0)) {
      ttsr.push(rule);
    } else if (rule.alwaysApply === true) {
      alwaysApply.push(rule);
    } else if (rule.description) {
      rulebook.push(rule);
    }
  }
  return { ttsr, alwaysApply, rulebook };
}
