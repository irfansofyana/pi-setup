export interface MemoryEntry {
  id: string;
  project: string;
  text: string;
  category: string;
  createdAt: string;
  source: "retain" | "auto-retain";
}

export interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  repeat?: "always" | "once" | "gap";
  repeatGap?: number;
  provider: string;
  priority: number;
}

export type RuleBucket = "ttsr" | "alwaysApply" | "rulebook";
