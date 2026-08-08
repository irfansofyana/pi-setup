# Installation

Use [README package manifest](../../README.md#required-npm-package-manifest) as canonical npm package list. This guide covers prerequisites, Pi installation, and repo-owned local templates without repeating that manifest.

## Prerequisites

- Node.js/npm on `PATH`
- Git
- `pipx` or `uv` for Headroom/Hindsight helper tools
- LLM provider configured by `/login` or environment variables
- API keys only for providers you use
- Shell profile such as `~/.zshrc` or `~/.bashrc`

## Install Pi

```bash
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g @earendil-works/pi-coding-agent
```

Verify:

```bash
pi --version
pi
```

## Install required npm packages

Run every command in [README required npm package manifest](../../README.md#required-npm-package-manifest). Do not substitute package aliases or duplicate that manifest in topic docs.

After installation:

```text
/reload
```

Inspect package sources:

```bash
pi list
```

## Install local templates

Repo-owned templates are copied rather than installed from npm.

| Template | Source | Target |
| --- | --- | --- |
| Theme | `pi/themes/irfan-pi.json` | `~/.pi/agent/themes/irfan-pi.json` |
| Signature UI | `pi/extensions/pi-signature.ts` | `~/.pi/agent/extensions/pi-signature.ts` |
| Terminal title | `pi/extensions/terminal-title` | `~/.pi/agent/extensions/terminal-title` |
| Command Deck chat editor | `pi/extensions/command-deck` | `~/.pi/agent/extensions/command-deck` |
| Headroom | `pi/extensions/headroom` | `~/.pi/agent/extensions/headroom` |
| Hindsight | `pi/extensions/hindsight` | `~/.pi/agent/extensions/hindsight` |
| Managed skills | `pi/extensions/managed-skills` | `~/.pi/agent/extensions/managed-skills` |
| Goal loop | `pi/extensions/goal-loop` | `~/.pi/agent/extensions/goal-loop` |
| Prompt loop | `pi/extensions/loop` | `~/.pi/agent/extensions/loop` |
| BTW | `pi/extensions/btw` | `~/.pi/agent/extensions/btw` |
| Caveman | `pi/extensions/caveman` | `~/.pi/agent/extensions/caveman` |

Deploy exact copies with private backups. Run from repository root:

```bash
set -eu
umask 077
mkdir -p "$HOME/.pi/agent/themes" "$HOME/.pi/agent/extensions" "$HOME/.pi/agent/backups"
backup_root=$(mktemp -d "$HOME/.pi/agent/backups/setup-XXXXXXXX")

deploy() {
  src=$1
  dst=$2
  name=$3
  had_old=0
  if [ -e "$dst" ]; then
    mv "$dst" "$backup_root/$name"
    had_old=1
  fi
  if ! cp -R "$src" "$dst"; then
    rm -rf "$dst"
    if [ "$had_old" -eq 1 ]; then
      mv "$backup_root/$name" "$dst"
    fi
    return 1
  fi
}

deploy pi/themes/irfan-pi.json "$HOME/.pi/agent/themes/irfan-pi.json" irfan-pi.json
deploy pi/extensions/pi-signature.ts "$HOME/.pi/agent/extensions/pi-signature.ts" pi-signature.ts
deploy pi/extensions/terminal-title "$HOME/.pi/agent/extensions/terminal-title" terminal-title
deploy pi/extensions/command-deck "$HOME/.pi/agent/extensions/command-deck" command-deck
deploy pi/extensions/headroom "$HOME/.pi/agent/extensions/headroom" headroom
deploy pi/extensions/hindsight "$HOME/.pi/agent/extensions/hindsight" hindsight
deploy pi/extensions/managed-skills "$HOME/.pi/agent/extensions/managed-skills" managed-skills
deploy pi/extensions/goal-loop "$HOME/.pi/agent/extensions/goal-loop" goal-loop
deploy pi/extensions/loop "$HOME/.pi/agent/extensions/loop" loop
deploy pi/extensions/btw "$HOME/.pi/agent/extensions/btw" btw
deploy pi/extensions/caveman "$HOME/.pi/agent/extensions/caveman" caveman

printf 'Backups: %s\n' "$backup_root"
```

Keep backup directory until `/reload` and component verification pass. Restore failed components from their named backup entries. Do **not** copy entire `pi/` directory into `~/.pi/`.

## Install Headroom CLI

Headroom CLI comes from Python packaging. npm `headroom-ai` is SDK-only.

```bash
pipx install "headroom-ai[proxy]"
# or
uv tool install "headroom-ai[proxy]"
```

## Initial Pi setup

Start Pi:

```bash
pi
```

Then run:

```text
/login
/reload
/mcp setup
/settings
```

Select `irfan-pi`. Continue with:

- [Configuration](configuration.md)
- [MCP](mcp.md)
- [Permissions](permissions.md)
- [Local extensions](local-extensions.md)
- [Skills and tools](skills-and-tools.md)

Run `/reload` after extension, theme, MCP, permission, or skill changes.
