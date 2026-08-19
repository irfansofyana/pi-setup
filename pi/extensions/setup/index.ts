import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const INIT_PROMPT = `Use the bundled pi-setup skill to audit this Pi installation and propose setup or migration. Verify the first-party package, required companion packages, legacy manual extension/theme duplicates, selected theme, user-owned config/state, global subagent templates, and the optional global automatic-delegation prompt. Present numbered proposals with impact, backup, rollback, and reload requirements. Do not mutate anything until I approve specific proposal numbers.`;

export const DOCTOR_PROMPT = `Use the bundled pi-setup skill to run a read-only audit of this Pi installation. Verify package sources and versions, first-party resources, required companion packages, duplicate manual loaders, selected theme, component health, user-owned config/state, global subagent templates, and the optional global automatic-delegation prompt. Redact credential values. Do not install, write, copy, move, remove, or change anything. Report compliant, missing, duplicate, drifted, optional, and blocked items.`;

export default function registerSetupCommands(pi: ExtensionAPI): void {
  pi.registerCommand("pi-setup-init", {
    description: "Audit setup and propose approval-gated initialization or migration",
    handler: async () => {
      await pi.sendUserMessage(INIT_PROMPT);
    },
  });

  pi.registerCommand("pi-setup-doctor", {
    description: "Run a read-only pi-setup health audit",
    handler: async () => {
      await pi.sendUserMessage(DOCTOR_PROMPT);
    },
  });
}
