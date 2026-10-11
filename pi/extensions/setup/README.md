# Pi Setup Commands

Package entry points for safe setup and migration:

- `/pi-setup-init` queues the bundled `pi-setup` skill's audit/proposal prompt.
- `/pi-setup-doctor` queues a strictly read-only health audit.

Neither command installs packages, edits settings, copies files or removes legacy resources directly. Both audit native `web-research`/`my-web-search`, bundled subagents, user overrides, legacy agent files/config and 9router/Tavily/Exa MCP coexistence. Bundled roles need no global deployment. Native config, selected custom-agent import, exact legacy cleanup and later web/MCP removal stay separately numbered and approval-first.