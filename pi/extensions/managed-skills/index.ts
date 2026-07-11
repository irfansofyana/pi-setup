export { managedSkillsExtension as default, autoCaptureDeliveryOptions, createManagedSkillsExtension } from "./extension.ts";

export {
  AUTO_CAPTURE_TYPE,
  EMPTY_AUTO_CAPTURE_STATE,
  buildAutoCapturePrompt,
  recordAgentEnd,
  settleAutoCapture,
} from "./auto-capture.ts";

export {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  DEFAULT_MAX_LEARN_MEMORY_CHARS,
  DEFAULT_MAX_MANAGED_SKILL_BYTES,
  MANAGED_SKILLS_DIR,
  getManagedSkillsConfigPath,
  getManagedSkillsDir,
  normalizeManagedSkillsConfig,
  readManagedSkillsConfig,
  writeManagedSkillsConfig,
} from "./config.ts";

export {
  computeHindsightScope,
  projectKey,
  projectTag,
  readHindsightRetainConfig,
  redactSecrets,
  retainHindsightLesson,
  sanitizeLearnText,
} from "./hindsight.ts";

export {
  MANAGED_SKILL_NAME_PATTERN,
  deleteManagedSkill,
  discoverManagedSkillFiles,
  ensureManagedRootSafe,
  listManagedSkills,
  parseSkillFrontmatter,
  sanitizeManagedDescription,
  sanitizeSkillName,
  serializeManagedSkill,
  toSkillFrontmatter,
  viewManagedSkill,
  writeManagedSkill,
  yamlQuoted,
} from "./skill-store.ts";

export type {
  BankScope,
  HindsightRetainConfig,
  HindsightScoping,
  LearnParams,
  LearnSkillInput,
  ManagedSkillAction,
  ManagedSkillInfo,
  ManagedSkillsConfig,
  ManagedSkillWriteInput,
  ManageSkillParams,
  ValidatedManagedSkillFile,
} from "./types.ts";
