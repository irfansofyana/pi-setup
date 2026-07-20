# Configuration

Keep global Pi configuration separate from project-local configuration. Preserve unknown keys when modifying existing files.

## Configuration paths

| Path | Scope | Use |
| --- | --- | --- |
| `~/.pi/agent/settings.json` | Global Pi | Pi settings and selected theme |
| `~/.pi/agent/themes/` | Global Pi | Themes |
| `~/.pi/agent/extensions/` | Global Pi | Extensions |
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

Use global paths for behavior shared across projects. Put `.mcp.json` at project root only when servers are project-specific. See [MCP](mcp.md) for examples.

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
- `irfan-gruvbox`: alternate Gruvbox Dark theme with OMP-inspired neutral tool cards, readable code output, and softer greens.
- `command-deck`: custom `CustomEditor` chat input with labeled borders, placeholder, state labels, spinner, hints, and responsive fallback. Uses Pi public APIs; does not patch `pi-tui`.
- `pi-signature.ts`: animated gradient `π` header, current-user detection, `crafted from Irfan's Pi setup` credit, `π` spinner, and compact footer statuses. Header animation uses cached normal-render line count to pause outside live viewport without polling full TUI tree, preserving terminal scrollback and idle performance.

Install theme and signature with private backup-and-replace procedure in [Installation](installation.md#install-local-templates). Do not overwrite existing targets with raw `cp`.

Select theme in `/settings`, or merge these settings into existing Pi settings:

```json
{
  "theme": "irfan-pi",
  "editorPaddingX": 2
}
```

`command-deck` owns chat-editor frame layout and state labels. `editorPaddingX` controls its text padding. Install it from `pi/extensions/command-deck/` as described in [Installation](installation.md#install-local-templates).

Optional signature overrides:

```bash
export PI_SIGNATURE_NAME="Your Name"
export PI_SIGNATURE_COMPACT_FOOTER=0
```

Run `/reload` after changes.
