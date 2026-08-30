import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const INIT_PROMPT = `Use the bundled pi-setup skill to audit this Pi installation and propose setup or migration. Verify the first-party package, required companion packages, package-owned web-research extension and my-web-search skill, Ciung's installed template, legacy 9router skill/routes, Tavily/Exa MCP configuration, legacy manual extension/theme duplicates, selected theme, and user-owned config/state. Keep Ciung template migration separate from later legacy removal. Present separate numbered proposals with impact, backup, rollback, and reload requirements. Do not mutate anything until I approve specific proposal numbers. Do not remove legacy resources without a separately approved removal proposal.`;

export const DOCTOR_PROMPT = `Use the bundled pi-setup skill to run a read-only audit of this Pi installation. Verify package sources and versions, first-party resources including web-research and my-web-search, required companion packages, Ciung's installed template, legacy 9router skill/routes, Tavily/Exa MCP configuration, duplicate manual loaders, selected theme, component health, and user-owned config/state. Redact credential values. Do not install, write, copy, move, remove, or change anything. Report compliant, missing, duplicate, drifted, optional, and blocked items.`;

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
