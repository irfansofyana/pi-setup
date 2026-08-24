# Configuration

Keep package-owned resources, global Pi configuration, and project-local configuration separate. Package installation does not rewrite user files. Preserve unknown keys when modifying existing files through an approved proposal.

## Configuration paths

| Path | Scope | Use |
| --- | --- | --- |
| Installed `@irfansofyana/pi-setup` package | Pi-managed | Repository-owned extensions, themes, and skills |
| Required companion packages | Pi-managed | Separate sources pinned by `piSetup.requiredPackages` |
| `~/.pi/agent/settings.json` | Global Pi | Pi settings and selected theme |
| `~/.pi/agent/themes/` | Global Pi | Themes |
| `~/.pi/agent/extensions/` | Global Pi | Extensions |
| `~/.pi/agent/agents/` | Global Pi | Trusted reusable subagent roles |
| `~/.pi/agent/subagents.json` | Global Pi | Subagent concurrency, UI, model-scope, and transcript defaults |
| `<project>/.pi/agents/` | Project-local | Project agent definitions; trusted repositories only |
| `<project>/.agents/agents/` | Project-local | Shared project agent definitions; trusted repositories only |
| `<project>/.pi/subagents.json` | Project-local | Subagent settings overriding global defaults |
| `~/.pi/agent/extensions/pi-permission-system/config.json` | Global Pi | Permission policy |
| `~/.pi/agent/headroom/config.json` | Global Pi | Headroom adapter config |
| `~/.pi/agent/hindsight/config.json` | Global Pi | Hindsight daemon config |
| `~/.pi/agent/managed-skills/config.json` | Global Pi | Managed skills config |
| `~/.pi/agent/managed-skills/` | Global Pi | Generated managed skill files |
| `~/.pi/agent/btw/config.json` | Global Pi | BTW side-question config |
| `~/.pi/agent/caveman/config.json` | Global Pi | Caveman extension config |
| `~/.pi/agent/goal-loop/config.json` | Global Pi | Goal-loop config |
| `~/.pi/agent/goal-loop/state/<root-key>.json` | Global Pi | Per-working-root active goal state |
| `~/.pi/agent/goal-loop/archive/<root-key>/<goal-id>.json` | Global Pi | Completed goal snapshots |
| `~/.pi/agent/goal-loop/logs/<root-key>.jsonl` | Global Pi | Append-only goal-loop audit log |
| `~/.config/mcp/mcp.json` | Global shared | Preferred MCP config |
| `.mcp.json` | Project-local | Project MCP servers |
| `~/.pi/agent/mcp.json` | Pi global | Pi-specific MCP override |

Package-owned code may read these user-owned paths, but package updates must not replace them. Use global paths for behavior shared across projects. Project subagent settings override global keys. Treat project agent definitions as executable-capability configuration and use them only in trusted repositories; see [Subagent team](subagents.md). Put `.mcp.json` at project root only when servers are project-specific. See [MCP](mcp.md) for examples.

## Secrets and authentication

Prefer `/login` or environment variables. Never commit secrets.

```bash
# LLM provider example
export ANTHROPIC_API_KEY="sk-ant-..."

# Search providers
export TAVILY_API_KEY="tvly-..."
export EXA_API_KEY="exa-..."
export BRAVE_API_KEY="BSA..."

# Work MCP examples
export WORK_CUSTOM_HEADER="..."
export WORK_MCP_TOKEN="..."
```

Reload shell:

```bash
source ~/.zshrc
# or
source ~/.bashrc
```

Inside Pi:

```text
/login
/model
```

For provider credentials, prefer environment variables or `/login`; do not hardcode values in repository files. Keep Hindsight provider credentials in environment/profile config, not this repo.

## Theme and signature UI

Included:

- `irfan-pi`: main blue/cobalt theme with inline color variables and export colors; standalone with no runtime dependencies.
- `irfan-sumi`: ink-black, warm-neutral, and amber theme and the fresh-install setup metadata default. Its theme directory directly owns the borderless two-line editor, placeholder, state labels, spinner, hints, and responsive fallback. It also activates Pi Signature's one-line breathing `π` header without changing `irfan-pi`.
- `irfan-gruvbox`: alternate Gruvbox Dark theme with OMP-inspired neutral tool cards, readable code output, and softer greens.
- `pi-signature.ts`: animated gradient `π` header, current-user detection, `crafted from Irfan's Pi setup` credit, `π` spinner, and compact footer statuses. Under `irfan-sumi`, the ornament collapses into a one-line signature whose amber `π` slowly breathes, plus a quiet `working` pulse. Header animation uses cached normal-render line count to pause outside live viewport without polling full TUI tree, preserving terminal scrollback and idle performance.

The first-party package exposes theme bundles and Pi Signature directly. Do not copy package-owned resources into `~/.pi/agent/`. Existing manual copies are migration candidates handled by the approval-gated procedure in [Installation](installation.md#existing-device-migration); user settings remain user-owned.

Select theme in `/settings`, or merge these settings into existing Pi settings:

```json
{
  "theme": "irfan-pi",
  "editorPaddingX": 2
}
```

`pi/themes/irfan-sumi/` owns both `theme.json` and its compact editor extension. Pi requires separate manifest entries for theme JSON and executable TypeScript, but both resources ship from one theme directory. The editor activates only when `irfan-sumi` is selected at session start; `editorPaddingX` controls its text padding. Pi persists the selected theme separately in `~/.pi/agent/settings.json`.

Installing another package does not reset or remove `irfan-sumi`. A package that claims Pi's single custom-editor slot can replace the Sumi editor visually; Sumi warns and leaves Pi's normal last-loaded-editor policy intact. The theme palette and Pi Signature remain active. See [Local Extensions](local-extensions.md#irfan-sumi-theme-editor) for conflict handling and `pi-fff` compatibility.

### Switch from `irfan-pi` to `irfan-sumi`

The themes coexist. Switching to `irfan-sumi` does not overwrite or remove `irfan-pi`.

1. Confirm the first-party package is installed and up to date with `pi list`. Do not replace any manually copied theme or extension during this step.
2. Start Pi and reload package resources:

   ```text
   /reload
   ```

3. Open Pi settings:

   ```text
   /settings
   ```

4. Set **Theme** to `irfan-sumi`. Pi persists the choice in `~/.pi/agent/settings.json`. On an existing device, do this only after approving the separate theme-change proposal.

Alternatively, while Pi is stopped, change only the existing `theme` field:

```json
{
  "theme": "irfan-sumi"
}
```

Preserve every other setting already present in the file. Restart Pi after editing it directly.

Verify the switch:

- Header is one line and only the amber `π` slowly breathes.
- Empty chat input is a borderless two-line prompt rail.
- Working state uses the quiet amber `· → ∙ → • → ∙` pulse.
- Footer, file completion, slash commands, multiline input, and scroll indicators still work.

To return to `irfan-pi`, open `/settings` and select `irfan-pi`, or restore `"theme": "irfan-pi"` while Pi is stopped. Run `/reload` or restart Pi. Pi restores its standard editor and the orbit signature; no theme files need to be deleted.

Optional signature overrides:

```bash
export PI_SIGNATURE_NAME="Your Name"
export PI_SIGNATURE_COMPACT_FOOTER=0
```

Run `/reload` after changes.
