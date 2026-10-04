# Configuration

Keep package-owned resources, global Pi configuration, and project-local configuration separate. Package installation does not rewrite user files. Preserve unknown keys when modifying existing files through an approved proposal.

## Configuration paths

| Path | Scope | Use |
| --- | --- | --- |
| Installed `@irfansofyana/pi-setup` package | Pi-managed | Repository-owned extensions, themes, skills, and prompts |
| Required companion packages | Pi-managed | Separate sources with documented minimum versions |
| `~/.pi/agent/settings.json` | Global Pi | Pi settings and selected theme |
| `~/.pi/agent/themes/` | Global Pi | Themes |
| `~/.pi/agent/extensions/` | Global Pi | Extensions |
| `~/.pi/agent/agents/` | Global Pi | Trusted reusable subagent roles |
| `~/.pi/agent/prompts/` | Global Pi | User-owned prompt templates; separate from package prompts |
| `<project>/.pi/prompts/` | Project-local | Project prompt templates; review before granting trust |
| `~/.pi/agent/subagents.json` | Global Pi | Subagent concurrency, UI, model-scope, and transcript defaults |
| `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/web-research/artifacts/` | Global Pi | Owner-only bounded native-web artifacts; package code owns format, user owns retained state |
| `<project>/.pi/agents/` | Project-local | Project agent definitions; trusted repositories only |
| `<project>/.agents/agents/` | Project-local | Shared project agent definitions; trusted repositories only |
| `<project>/.pi/subagents.json` | Project-local | Subagent settings overriding global defaults |
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
| `~/.config/mcp/mcp.json` | Other clients/legacy | Shared config; not loaded by native Pi |
| `.pi/mcp.json` | Project-local | Native Pi project MCP servers; trust required |
| `~/.pi/agent/mcp.json` | Pi global | Native Pi personal MCP servers |

Package-owned code may read user-owned paths, but updates must not replace them. Global configuration applies across projects; project subagent settings override global keys. Treat project agent definitions as executable-capability configuration and load only trusted repositories; see [Subagent team](subagents.md). Native project MCP uses `.pi/mcp.json` after project trust. See [MCP](mcp.md) for examples.

## Secrets and authentication

Prefer `/login` or environment variables. Never commit secrets.

```bash
# LLM provider example
export ANTHROPIC_API_KEY="sk-ant-..."

# Native web-research providers (`TAVILY_API_KEY` is the ordinary default)
export TAVILY_API_KEY="tvly-..."
export EXA_API_KEY="exa-..."
# Optional legacy/other search integrations
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

## Codemode

On Pi versions with built-in Codemode (verified with Pi `1.0.2`), no separate package is required. To enable it persistently, merge this additive selection into global `~/.pi/agent/settings.json`; preserve existing `defaultTools` entries and unrelated settings:

```json
{
  "defaultTools": ["+codemode"]
}
```

- Default `codemode.mode: "on"` keeps direct tools available alongside JavaScript tool scripts.
- Optional `codemode.mode: "only"` hides direct tools from the model; scripts still call them through `tools.<name>()`. Choose it separately.
- Scripts support parallel calls and filtering results before they reach model context. The JavaScript sandbox does not sandbox side effects of called tools.
- Run `/reload` or restart Pi after changes. `/reload` enables newly added default tools; explicit CLI tool selections override these settings.
- Rollback removes only the approved addition after checking for drift, preserving other tool selections and settings.

See official [Codemode](https://pi.dev/docs/latest/codemode) and [tool settings](https://pi.dev/docs/latest/settings#tools) references.

## Theme and signature UI

Included:

- `irfan-pi`: main blue/cobalt theme with inline color variables and export colors; standalone with no runtime dependencies.
- `pi-irfan-devs`: recommended fresh-install default green palette with native header, integrated editor, Signature UI, and themed footer.
- `irfan-gruvbox`: alternate Gruvbox Dark theme with OMP-inspired neutral tool cards, readable code output, and softer greens.
- Integrated `signature.ts`: minimal header, working indicator, footer usage/statuses and terminal title. `pi-irfan-devs` adds a faint, layout-owned 3D π welcome panel above the editor in fresh idle fullscreen sessions. Startup warnings do not block it. Click or `/pi-watermark` replays a finite π/badge morph; `/pi-watermark status` explains hiding conditions. Typing hides it; clearing an unsent draft restores static art. `PI_SIGNATURE_ANIMATION=0` disables replay, not artwork. Dock content gets priority; unknown custom components and insufficient space suppress decoration. Other palettes retain their orbit header. See [component behavior](../../pi/themes/pi-irfan-devs/README.md#welcome-panel). No standalone Signature extension loads.

The first-party package exposes theme bundles and Pi Signature directly. Do not copy package-owned resources into `~/.pi/agent/`. Existing manual copies are migration candidates handled by the approval-gated procedure in [Installation](installation.md#existing-device-migration); user settings remain user-owned.

Select theme in `/settings`, or merge these settings into existing Pi settings:

```json
{
  "theme": "pi-irfan-devs",
  "editorPaddingX": 2
}
```

`pi/themes/pi-irfan-devs/` owns `theme.json`, UI entrypoint `index.ts`, Signature runtime/tests, `smoke-test.mjs`, and component `README.md`. Palette JSON and executable UI require separate manifest fields, but only one UI entrypoint loads. Editor activates only for `pi-irfan-devs` at session start; `editorPaddingX` controls text padding. Theme selection stays in user-owned `~/.pi/agent/settings.json`.

Installing another package does not reset or remove either theme. A package that claims Pi's single custom-editor slot can replace the integrated editor visually; the editor warns and leaves Pi's normal last-loaded-editor policy intact. The theme palette and Pi Signature remain active. See [Local Extensions](local-extensions.md#irfan-devs-theme-bundle) for conflict handling and `pi-fff` compatibility.

<a id="switch-to-pi-irfan-devs"></a>

### Switch to `pi-irfan-devs`

Switching to `pi-irfan-devs` does not remove the unrelated blue/Gruvbox palettes. Package installation and repository implementation approval do not authorize local activation; existing devices require separate theme-change approval.

1. Confirm the first-party package is installed and up to date with `pi list`. Do not replace any manually copied theme or extension during this step.
2. Start Pi and reload package resources:

   ```text
   /reload
   ```

3. Open Pi settings:

   ```text
   /settings
   ```

4. Set **Theme** to `pi-irfan-devs`. Pi persists the choice in `~/.pi/agent/settings.json`. On an existing device, do this only after approving the separate theme-change proposal.

Alternatively, while Pi is stopped, change only the existing `theme` field:

```json
{
  "theme": "pi-irfan-devs"
}
```

Preserve every other setting already present in the file. Restart Pi after editing it directly.

Verify the switch:

- Header, editor, and footer use the native green palette and theme-colored signature.
- Empty input uses rounded cell borders at 34+ columns and 18+ rows; smaller terminals keep the compact prompt rail.
- Working state and hints remain readable; CSS glow, browser effects, and font changes are not palette features.
- Footer, file completion, slash commands, multiline input, and scroll indicators still work.

To return to `irfan-pi`, open `/settings` and select `irfan-pi`, or restore `"theme": "irfan-pi"` while Pi is stopped. Run `/reload` or restart Pi. Pi restores its standard editor and the orbit signature; no theme files need to be deleted.

### Local theme-only preview

For an approved development preview, load only the checkout's UI entrypoint and palette:

```json
{
  "source": "/absolute/path/to/pi-setup",
  "extensions": ["pi/themes/pi-irfan-devs/index.ts"],
  "themes": ["pi/themes/pi-irfan-devs/theme.json"],
  "skills": [],
  "prompts": []
}
```

Audit the currently resolved installed UI entrypoints and exclude only those from the existing package source before adding this override. Keep other packages, resources and ordering unchanged. Otherwise both copies can claim the header/editor or collide on theme names. Ordinary positive paths narrow selection; `+path` force-includes a resource and does not narrow the default set.

This preview depends on the checkout staying available. It does not update installed non-UI code, setup skills or their companion metadata; those remain from the installed release until a separately approved package update. Back up settings privately, preserve unknown keys, and retain rollback until accepted. Run `/reload` or restart Pi after activation or rollback.

Optional signature overrides:

- `PI_SIGNATURE_ANIMATION=0` disables header animation before starting Pi; logo stays static and the working spinner remains independent.

```bash
export PI_SIGNATURE_NAME="Your Name"
export PI_SIGNATURE_COMPACT_FOOTER=0
```

Run `/reload` after changes.
