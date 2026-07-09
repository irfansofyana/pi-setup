# Managed Skills Pi Extension

Local OMP-inspired managed skills for stock Pi.

This extension adds model-callable `manage_skill` and `learn` tools plus a `/managed-skills` command. It writes generated skills only under an isolated managed directory:

```text
~/.pi/agent/managed-skills/<skill-name>/SKILL.md
```

It never writes user-authored skill directories such as `~/.pi/agent/skills`, `.pi/skills`, or `.agents/skills`.

## Install

From this repository:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/managed-skills ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
```

## Commands

```text
/managed-skills status                 # show config and counts
/managed-skills list                   # list managed skills
/managed-skills enable                 # enable managed skill discovery/tooling
/managed-skills disable                # disable managed skill discovery/tooling
/managed-skills learn on|off           # enable or disable the Hindsight-backed learn tool
/managed-skills auto on|off            # add standing capture guidance to the system prompt
/managed-skills autocontinue on|off    # run one hidden capture turn after large tool-heavy turns
/managed-skills view <name>            # show a managed skill file preview
/managed-skills delete <name>          # delete one managed skill after confirmation
/managed-skills config                 # show config path and effective config
/managed-skills reload                 # reload extensions, skills, prompts, and themes
```

## Tools

When enabled, the extension registers:

```text
manage_skill  # generated skill CRUD
learn         # Hindsight retain + optional managed skill create/update
```

### `manage_skill`

Actions:

```text
create  # create a new managed skill; fails if it already exists
update  # replace an existing managed skill; fails if missing
delete  # remove an existing managed skill
list    # list managed skills
view    # read one managed skill
```

`create` / `update` require:

```json
{
  "action": "create",
  "name": "kebab-case-name",
  "description": "Trigger-focused description for skill discovery.",
  "body": "# Markdown body without frontmatter"
}
```

After any create/update/delete, run:

```text
/reload
```

Pi discovers skills at startup/reload, so new managed skills are not active until reload.

### `learn`

Use `learn` for durable facts, project conventions, user preferences, non-obvious fixes, or tool quirks that should survive future sessions in Hindsight.

```json
{
  "memory": "Durable lesson: what, when, and why.",
  "context": "Optional source context. No secrets.",
  "skill": {
    "action": "create",
    "name": "kebab-case-name",
    "description": "When to use this generated skill.",
    "body": "# Markdown body without frontmatter"
  }
}
```

`skill` is optional. Use it only when the lesson is also a repeatable procedure worth codifying as a `SKILL.md`.

`learn` reads the existing Hindsight config/env used by `pi/extensions/hindsight`:

```text
~/.pi/agent/hindsight/config.json
HINDSIGHT_API_URL
HINDSIGHT_API_TOKEN / HINDSIGHT_API_KEY
HINDSIGHT_BANK_ID
HINDSIGHT_SCOPING
HINDSIGHT_REQUEST_TIMEOUT_MS
```

No separate memory backend is created.

## Config

Config lives at:

```text
~/.pi/agent/managed-skills/config.json
```

Defaults:

```json
{
  "enabled": true,
  "learnEnabled": true,
  "autoCapture": false,
  "autoContinue": false,
  "minToolCalls": 5,
  "maxSkillBytes": 64000,
  "maxMemoryChars": 12000
}
```

- `enabled`: registers managed-skills tooling and discovers managed skills.
- `learnEnabled`: registers `learn` for Hindsight-backed lesson retention.
- `autoCapture`: adds system prompt guidance telling the agent it may call `learn` and/or `manage_skill`.
- `autoContinue`: after a turn with at least `minToolCalls`, queues one hidden capture turn that may call `learn` and/or `manage_skill`, then stop.
- `minToolCalls`: threshold for `autoContinue`.
- `maxSkillBytes`: max serialized `SKILL.md` size.
- `maxMemoryChars`: max Hindsight lesson/context length for `learn`.

Recommended start:

```json
{
  "enabled": true,
  "learnEnabled": true,
  "autoCapture": false,
  "autoContinue": false,
  "minToolCalls": 5,
  "maxSkillBytes": 64000,
  "maxMemoryChars": 12000
}
```

Turn on automation only after manual workflow feels good.

## Safety rules

The extension enforces:

- strict kebab-case names: lowercase letters, digits, hyphens, max 64 chars
- no slashes, `..`, absolute paths, or empty names
- managed root must not be a symlink
- managed skill directory and `SKILL.md` must not be symlinks
- discovery contributes only explicit, lstat-validated `SKILL.md` files, never the parent managed root
- update and discovery reject hard-linked `SKILL.md` files
- create uses exclusive file creation
- update requires an existing regular file
- serialized `SKILL.md` is capped by `maxSkillBytes`
- descriptions are one-line sanitized strings
- authored skills keep priority; the tool refuses known authored-name collisions during active turns
- `learn` redacts common secret patterns before retaining to Hindsight
- `learn` enforces `maxMemoryChars` for memory and context

Keep `pi-permission-system` enabled and leave `manage_skill` and `learn` gated as `ask` if you want approval before writes/retention.

## Limitations

- New/changed skills require `/reload`.
- Authored skill collision detection depends on loaded skills visible during the active turn; Pi still keeps first-discovered skill on collision.
- `learn` requires the local Hindsight daemon/config to be reachable.
- `learn` stores memory first; if optional skill creation fails, it reports a partial outcome.
- `autoContinue` spends extra tokens and can surprise you; keep it off unless explicitly wanted.

## Smoke test

Inside Pi:

```text
/managed-skills status
Ask the agent: remember that this repo copies local extension templates from pi/extensions/<name> to ~/.pi/agent/extensions.
Ask the agent: create a managed skill named demo-workflow that says when to use it and has a short body.
/managed-skills list
/managed-skills reload
/skill:demo-workflow
```

Local helper tests from this repository:

```bash
node --test pi/extensions/managed-skills/index.test.ts
```
