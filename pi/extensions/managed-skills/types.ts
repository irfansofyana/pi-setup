export interface ManagedSkillsConfig {
  enabled: boolean;
  learnEnabled: boolean;
  autoCapture: boolean;
  autoContinue: boolean;
  minToolCalls: number;
  maxSkillBytes: number;
  maxMemoryChars: number;
}

export type ManagedSkillAction = "create" | "update" | "delete" | "list" | "view";

export interface ManagedSkillWriteInput {
  action: "create" | "update";
  name: string;
  description: string;
  body: string;
  root?: string;
  maxBytes?: number;
}

export interface ManagedSkillInfo {
  name: string;
  description: string;
  path: string;
  bytes: number;
}

export interface ValidatedManagedSkillFile {
  name: string;
  path: string;
  bytes: number;
}

export interface ManageSkillParams {
  action: ManagedSkillAction;
  name?: string;
  description?: string;
  body?: string;
}

export interface LearnSkillInput {
  action: "create" | "update";
  name: string;
  description: string;
  body: string;
}

export interface LearnParams {
  memory: string;
  context?: string;
  skill?: LearnSkillInput;
}

export type HindsightScoping = "global" | "per-project" | "per-project-tagged";

export interface HindsightRetainConfig {
  apiUrl: string;
  apiToken?: string;
  bankId: string;
  scoping: HindsightScoping;
  requestTimeoutMs: number;
}

export interface BankScope {
  bankId: string;
  tags?: string[];
  tagsMatch?: "any" | "all";
}
