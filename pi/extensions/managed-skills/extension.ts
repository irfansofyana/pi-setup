import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  AUTO_CAPTURE_TYPE,
  EMPTY_AUTO_CAPTURE_STATE,
  recordAgentEnd,
  settleAutoCapture,
  type AutoCaptureState,
} from "./auto-capture.ts";
import {
  CONFIG_PATH,
  MANAGED_SKILLS_DIR,
  readManagedSkillsConfig,
  writeManagedSkillsConfig,
  type ManagedSkillsConfigResult,
} from "./config.ts";
import { retainHindsightLesson } from "./hindsight.ts";
import { learnSchema, manageSkillSchema } from "./schema.ts";
import {
  deleteManagedSkill,
  discoverManagedSkillFiles,
  listManagedSkills,
  sanitizeSkillName,
  viewManagedSkill,
  writeManagedSkill,
} from "./skill-store.ts";
import type { LearnParams, ManagedSkillInfo, ManagedSkillsConfig, ManageSkillParams } from "./types.ts";

export interface ManagedSkillsExtensionDependencies {
  managedRoot?: string;
  configPath?: string;
  readConfig?: () => ManagedSkillsConfigResult;
  writeConfig?: (config: ManagedSkillsConfig) => Promise<void>;
  discoverSkills?: (root: string, maxBytes: number) => ReturnType<typeof discoverManagedSkillFiles>;
  listSkills?: (root: string, maxBytes: number) => ReturnType<typeof listManagedSkills>;
  viewSkill?: (name: string, root: string, maxBytes: number) => ReturnType<typeof viewManagedSkill>;
  writeSkill?: typeof writeManagedSkill;
  deleteSkill?: typeof deleteManagedSkill;
  retainLesson?: typeof retainHindsightLesson;
}

export interface AutoCaptureDeliveryOptions {
  deliverAs: "followUp";
  triggerTurn: true;
}

export function autoCaptureDeliveryOptions(): AutoCaptureDeliveryOptions {
  return { deliverAs: "followUp", triggerTurn: true };
}

function boolFromOnOff(value: string): boolean | undefined {
  if (["on", "true", "yes", "enable", "enabled"].includes(value.toLowerCase())) return true;
  if (["off", "false", "no", "disable", "disabled"].includes(value.toLowerCase())) return false;
  return undefined;
}

function parseCommand(args: string): { command: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { command: "status", rest: "" };
  const [command = "status", ...rest] = trimmed.split(/\s+/);
  return { command: command.toLowerCase(), rest: rest.join(" ") };
}

function notify(
  ctx: { ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void } },
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  ctx.ui?.notify?.(message, level);
}

function formatSkillList(skills: ManagedSkillInfo[], root: string): string {
  if (!skills.length) return "No managed skills.";
  return skills
    .map((skill) => `- ${skill.name}: ${skill.description || "(no description)"} (${relative(root, skill.path)})`)
    .join("\n");
}

function formatStatus(
  config: ManagedSkillsConfig,
  skills: ManagedSkillInfo[],
  root: string,
  configPath: string,
  diagnostic?: string,
): string {
  return [
    `Managed skills: ${config.enabled ? "enabled" : "disabled"}`,
    `Root: ${root}`,
    `Config: ${configPath}`,
    `Skills: ${skills.length}`,
    `Learn tool: ${config.learnEnabled ? "on" : "off"}`,
    `Auto capture guidance: ${config.autoCapture ? "on" : "off"}`,
    `Auto continue capture: ${config.autoContinue ? "on" : "off"}`,
    `Minimum tool calls: ${config.minToolCalls}`,
    `Max skill bytes: ${config.maxSkillBytes}`,
    `Max memory chars: ${config.maxMemoryChars}`,
    ...(diagnostic ? [`Warning: ${diagnostic}`] : []),
  ].join("\n");
}

function buildAutoCaptureGuidance(config: ManagedSkillsConfig, root: string): string {
  const lines = ["\n\n## Managed Skills (experimental)"];
  if (config.learnEnabled) {
    lines.push("When you discover a durable fact, convention, user preference, or non-obvious fix, call `learn` to retain it in Hindsight.");
  }
  lines.push(
    config.learnEnabled
      ? "When you discover a reusable procedure, call `manage_skill` or call `learn` with a `skill` object."
      : "When you discover a reusable procedure, call `manage_skill` to capture it.",
    `Managed skills are SKILL.md files under ${root} and become active after /reload.`,
    "Use this sparingly for repeatable setup sequences, debugging recipes, and project workflows.",
    "Never store secrets, credentials, tokens, or one-off facts in managed skills or Hindsight.",
    `Current config: learn=${config.learnEnabled}, autoCapture=${config.autoCapture}, autoContinue=${config.autoContinue}, minToolCalls=${config.minToolCalls}.`,
  );
  return lines.join("\n");
}

export function createManagedSkillsExtension(overrides: ManagedSkillsExtensionDependencies = {}) {
  const managedRoot = overrides.managedRoot ?? MANAGED_SKILLS_DIR;
  const configPath = overrides.configPath ?? CONFIG_PATH;
  const readConfig = overrides.readConfig ?? (() => readManagedSkillsConfig(configPath));
  const writeConfig = overrides.writeConfig ?? ((config) => writeManagedSkillsConfig(config, configPath));
  const discoverSkills = overrides.discoverSkills ?? discoverManagedSkillFiles;
  const listSkills = overrides.listSkills ?? listManagedSkills;
  const viewSkill = overrides.viewSkill ?? viewManagedSkill;
  const writeSkill = overrides.writeSkill ?? writeManagedSkill;
  const deleteSkill = overrides.deleteSkill ?? deleteManagedSkill;
  const retainLesson = overrides.retainLesson ?? retainHindsightLesson;

  return function managedSkillsExtension(pi: ExtensionAPI): void {
    let configResult = readConfig();
    let config = configResult.config;
    let toolCallsThisTurn = 0;
    let captureMarkerSeenThisRun = false;
    let postCaptureUserActive = false;
    let userWorkAfterCapture = false;
    let postCaptureToolCalls = 0;
    let autoCaptureState: AutoCaptureState = EMPTY_AUTO_CAPTURE_STATE;
    let authoredSkillNames = new Set<string>();

    const reloadConfig = (): ManagedSkillsConfig => {
      configResult = readConfig();
      return configResult.config;
    };

    pi.registerCommand("managed-skills", {
      description: "Manage isolated generated skills",
      handler: async (args, ctx) => {
        config = reloadConfig();
        const parsed = parseCommand(args);
        try {
          if (parsed.command === "status") {
            const skills = config.enabled ? await listSkills(managedRoot, config.maxSkillBytes) : [];
            notify(ctx, formatStatus(config, skills, managedRoot, configPath, configResult.diagnostic), configResult.diagnostic ? "warning" : "info");
            return;
          }
          if (parsed.command === "list") {
            notify(ctx, formatSkillList(await listSkills(managedRoot, config.maxSkillBytes), managedRoot));
            return;
          }
          if (parsed.command === "enable" || parsed.command === "disable") {
            config = { ...config, enabled: parsed.command === "enable" };
            await writeConfig(config);
            notify(ctx, `Managed skills ${config.enabled ? "enabled" : "disabled"}. Run /reload to apply discovery/tool changes.`);
            return;
          }
          if (["learn", "auto", "autocontinue"].includes(parsed.command)) {
            const enabled = boolFromOnOff(parsed.rest);
            if (enabled === undefined) {
              notify(ctx, `Usage: /managed-skills ${parsed.command} on|off`, "warning");
              return;
            }
            const key = parsed.command === "learn" ? "learnEnabled" : parsed.command === "auto" ? "autoCapture" : "autoContinue";
            config = { ...config, [key]: enabled };
            await writeConfig(config);
            const label = parsed.command === "learn" ? "learn tool" : parsed.command === "auto" ? "auto-capture guidance" : "auto-continue capture";
            notify(ctx, `Managed skills ${label} ${enabled ? "enabled" : "disabled"}. Run /reload to apply.`);
            return;
          }
          if (parsed.command === "view" || parsed.command === "open") {
            if (!parsed.rest) {
              notify(ctx, `Usage: /managed-skills ${parsed.command} <name>`, "warning");
              return;
            }
            const skill = await viewSkill(parsed.rest, managedRoot, config.maxSkillBytes);
            notify(ctx, `${skill.path}\n\n${skill.content.slice(0, 2000)}${skill.content.length > 2000 ? "\n..." : ""}`);
            return;
          }
          if (parsed.command === "delete") {
            if (!parsed.rest) {
              notify(ctx, "Usage: /managed-skills delete <name>", "warning");
              return;
            }
            const name = sanitizeSkillName(parsed.rest);
            const confirmed = ctx.hasUI
              ? await ctx.ui.confirm("Delete managed skill?", `${name}\n\nThis removes only ${join(managedRoot, name)}.`)
              : false;
            if (!confirmed) {
              notify(ctx, "Delete cancelled.", "warning");
              return;
            }
            await deleteSkill(name, managedRoot);
            notify(ctx, `Deleted managed skill "${name}". Run /reload to apply.`);
            return;
          }
          if (parsed.command === "config") {
            const warning = configResult.diagnostic ? `\n\nWarning: ${configResult.diagnostic}` : "";
            notify(ctx, `${configPath}\n\n${JSON.stringify(config, null, 2)}${warning}`, configResult.diagnostic ? "warning" : "info");
            return;
          }
          if (parsed.command === "reload") {
            await ctx.reload();
            return;
          }
          notify(ctx, "Usage: /managed-skills status|list|enable|disable|learn on|off|auto on|off|autocontinue on|off|view <name>|delete <name>|config|reload", "warning");
        } catch (err) {
          notify(ctx, err instanceof Error ? err.message : String(err), "error");
        }
      },
    });

    pi.on("resources_discover", async () => {
      config = reloadConfig();
      if (!config.enabled) return {};
      const skills = await discoverSkills(managedRoot, config.maxSkillBytes);
      return { skillPaths: skills.map((skill) => skill.path) };
    });

    pi.on("before_agent_start", async (event) => {
      config = reloadConfig();
      const managedRootResolved = resolve(managedRoot);
      const skills = (event.systemPromptOptions?.skills ?? []) as Array<{
        name?: string;
        filePath?: string;
        path?: string;
        sourceInfo?: { path?: string };
      }>;
      authoredSkillNames = new Set();
      for (const skill of skills) {
        const path = skill.filePath ?? skill.path ?? skill.sourceInfo?.path ?? "";
        const resolvedPath = path ? resolve(path) : "";
        const managed = resolvedPath === managedRootResolved || resolvedPath.startsWith(`${managedRootResolved}${sep}`);
        if (!managed && typeof skill.name === "string") authoredSkillNames.add(skill.name);
      }
      if (!config.enabled || !config.autoCapture) return;
      return { systemPrompt: `${event.systemPrompt}${buildAutoCaptureGuidance(config, managedRoot)}` };
    });

    if (config.enabled) {
      pi.registerTool<any, Record<string, unknown>>({
        name: "manage_skill",
        label: "Manage Skill",
        description: `Create, update, delete, list, or view isolated managed Pi skills under ${managedRoot}.`,
        promptSnippet: "Create, update, delete, list, or view isolated managed SKILL.md files.",
        promptGuidelines: [
          "Use manage_skill only for repeatable procedures worth reusing as Pi skills, not for one-off facts.",
          "Never use manage_skill for secrets or credentials.",
          "After a mutation, tell the user to run /reload before relying on the change.",
        ],
        parameters: manageSkillSchema as any,
        async execute(_toolCallId: string, params: ManageSkillParams) {
          config = reloadConfig();
          if (!config.enabled) throw new Error("Managed skills are disabled. Run /managed-skills enable, then /reload.");
          if (params.action === "list") {
            const skills = await listSkills(managedRoot, config.maxSkillBytes);
            return { content: [{ type: "text", text: formatSkillList(skills, managedRoot) }], details: { action: params.action, skills } };
          }
          if (!params.name) throw new Error(`"${params.action}" requires "name".`);
          const name = sanitizeSkillName(params.name);
          if (params.action === "view") {
            const skill = await viewSkill(name, managedRoot, config.maxSkillBytes);
            return { content: [{ type: "text", text: skill.content }], details: { action: params.action, name, path: skill.path } };
          }
          if (params.action === "delete") {
            await deleteSkill(name, managedRoot);
            return { content: [{ type: "text", text: `Deleted managed skill "${name}". Run /reload before relying on discovery changes.` }], details: { action: params.action, name } };
          }
          if (params.action !== "create" && params.action !== "update") throw new Error(`Unsupported action: ${params.action}`);
          if (!params.description || !params.body) throw new Error(`"${params.action}" requires "description" and "body".`);
          if (authoredSkillNames.has(name)) {
            return {
              content: [{ type: "text", text: `Cannot ${params.action} managed skill "${name}": an authored skill with that name already exists.` }],
              isError: true,
              details: { action: params.action, name, shadowed: true },
            };
          }
          const result = await writeSkill({
            action: params.action,
            name,
            description: params.description,
            body: params.body,
            root: managedRoot,
            maxBytes: config.maxSkillBytes,
          });
          const verb = params.action === "create" ? "Created" : "Updated";
          return {
            content: [{ type: "text", text: `${verb} managed skill "${result.name}" (${relative(managedRoot, result.path)}). Run /reload before relying on it.` }],
            details: { action: params.action, name: result.name, path: result.path },
          };
        },
      });

      if (config.learnEnabled) {
        pi.registerTool<any, Record<string, unknown>>({
          name: "learn",
          label: "Learn",
          description: "Retain a durable lesson in Hindsight and optionally create or update a managed skill in the same call.",
          promptSnippet: "Retain durable facts/preferences in Hindsight; optionally create/update a managed skill for repeatable procedures.",
          promptGuidelines: [
            "Use learn for durable facts, project conventions, user preferences, non-obvious fixes, or tool quirks.",
            "Use a skill object only when the lesson is also a repeatable procedure.",
            "Never pass secrets, tokens, passwords, API keys, or raw large logs to learn.",
          ],
          parameters: learnSchema as any,
          async execute(_toolCallId: string, params: LearnParams, signal, _onUpdate, ctx) {
            config = reloadConfig();
            if (!config.enabled) throw new Error("Managed skills are disabled. Run /managed-skills enable, then /reload.");
            if (!config.learnEnabled) throw new Error("The learn tool is disabled. Run /managed-skills learn on, then /reload.");
            if (!params.memory) throw new Error("learn requires a non-empty memory.");
            const retained = await retainLesson({
              cwd: ctx.cwd || process.cwd(),
              memory: params.memory,
              context: params.context,
              maxMemoryChars: config.maxMemoryChars,
              signal,
            });
            if (!params.skill) {
              return { content: [{ type: "text", text: `Lesson queued for Hindsight (${retained.bankId}).` }], details: { bankId: retained.bankId, tags: retained.tags ?? null, skill: null } };
            }
            const name = sanitizeSkillName(params.skill.name);
            if (authoredSkillNames.has(name)) {
              return {
                content: [{ type: "text", text: `Lesson queued for Hindsight (${retained.bankId}). Did not ${params.skill.action} managed skill "${name}": an authored skill with that name exists.` }],
                isError: true,
                details: { bankId: retained.bankId, tags: retained.tags ?? null, skill: null, shadowed: true },
              };
            }
            try {
              const result = await writeSkill({ ...params.skill, name, root: managedRoot, maxBytes: config.maxSkillBytes });
              const verb = params.skill.action === "create" ? "Created" : "Updated";
              return {
                content: [{ type: "text", text: `Lesson queued for Hindsight (${retained.bankId}). ${verb} managed skill "${result.name}" (${relative(managedRoot, result.path)}). Run /reload before relying on it.` }],
                details: { bankId: retained.bankId, tags: retained.tags ?? null, skill: result.name, path: result.path },
              };
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              throw new Error(`Lesson queued for Hindsight (${retained.bankId}), but the managed skill could not be written: ${reason}`);
            }
          },
        });
      }
    }

    pi.on("agent_start", async () => {
      toolCallsThisTurn = 0;
      captureMarkerSeenThisRun = false;
      userWorkAfterCapture = postCaptureUserActive;
      postCaptureToolCalls = 0;
    });
    pi.on("message_start", async (event) => {
      const message = event.message as { role?: string; customType?: string };
      if (message.role === "custom" && message.customType === AUTO_CAPTURE_TYPE) {
        captureMarkerSeenThisRun = true;
        postCaptureUserActive = false;
        userWorkAfterCapture = false;
      } else if (message.role === "user" && (captureMarkerSeenThisRun || autoCaptureState.captureChainActive)) {
        postCaptureUserActive = true;
        userWorkAfterCapture = true;
      }
    });
    pi.on("tool_execution_end", async () => {
      toolCallsThisTurn += 1;
      if (userWorkAfterCapture) postCaptureToolCalls += 1;
    });
    pi.on("agent_end", async (event) => {
      config = reloadConfig();
      autoCaptureState = recordAgentEnd(autoCaptureState, {
        config,
        messages: event.messages,
        toolCalls: toolCallsThisTurn,
        postCaptureToolCalls: userWorkAfterCapture ? postCaptureToolCalls : undefined,
      });
      toolCallsThisTurn = 0;
      postCaptureToolCalls = 0;
    });
    pi.on("agent_settled", async (_event, ctx) => {
      config = reloadConfig();
      const previousState = autoCaptureState;
      const decision = settleAutoCapture(previousState, {
        config,
        isIdle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
      });
      autoCaptureState = decision.state;
      postCaptureUserActive = false;
      userWorkAfterCapture = false;
      if (!decision.prompt || decision.toolCalls === undefined) return;
      try {
        pi.sendMessage({
          customType: AUTO_CAPTURE_TYPE,
          content: decision.prompt,
          display: false,
          details: { toolCalls: decision.toolCalls, minToolCalls: config.minToolCalls },
        }, autoCaptureDeliveryOptions());
      } catch (err) {
        autoCaptureState = previousState;
        throw err;
      }
    });
  };
}

export const managedSkillsExtension = createManagedSkillsExtension();
