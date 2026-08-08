# Managed Skills Pi Extension

Local OMP-inspired managed skills for Pi.

Requires Pi `>=0.80.4`. Automatic continuation uses Pi's `agent_settled` lifecycle hook, introduced in `0.80.4`.

This extension adds model-callable `manage_skill` and `learn` tools plus a `/managed-skills` command. It writes generated skills only under an isolated managed directory:

```text
~/.pi/agent/managed-skills/<skill-name>/SKILL.md
```

It never writes user-authored skill directories such as `~/.pi/agent/skills`, `.pi/skills`, or `.agents/skills`.

## Install

From repository root, use canonical private backup-and-replace procedure in [setup installation guide](../../../docs/setup/installation.md#install-local-templates).

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

Daily-use defaults:

```json
{
  "enabled": true,
  "learnEnabled": false,
  "autoCapture": true,
  "autoContinue": false,
  "minToolCalls": 8,
  "maxSkillBytes": 64000,
  "maxMemoryChars": 12000
}
```

- `enabled`: registers managed-skills tooling and discovers managed skills.
- `learnEnabled`: registers `learn` for Hindsight-backed lesson retention. Keep off when standalone Hindsight tools already handle durable memory; enable when one call should retain a lesson and optionally write a skill.
- `autoCapture`: adds standing system-prompt guidance to capture genuinely reusable procedures during normal work. It does not start another turn.
- `autoContinue`: after eligible tool-heavy work and all queued follow-ups/retries settle, runs one hidden capture turn that may call `learn` and/or `manage_skill`, then stops. Keep off unless extra token use and autonomous writes are wanted.
- `minToolCalls`: threshold for `autoContinue`; ignored while `autoContinue` is off.
- `maxSkillBytes`: max serialized `SKILL.md` size.
- `maxMemoryChars`: max Hindsight lesson/context length for `learn`.

This profile keeps lightweight capture guidance active while leaving Hindsight retention and hidden capture turns explicit.

If an existing config file is malformed or unreadable, the extension fails closed: managed tools, discovery, and automation stay disabled. `/managed-skills status` and `/managed-skills config` show the diagnostic. Correct the file or run a config-changing command, then `/reload`.

## Architecture

- `extension.ts`: Pi commands, tools, discovery, prompts, and lifecycle wiring
- `auto-capture.ts`: pure `agent_end`/`agent_settled` state machine
- `config.ts`: defaults, fail-closed reads, and atomic config persistence
- `filesystem.ts`: bounded no-follow reads and atomic file primitives
- `skill-store.ts`: isolated generated-skill CRUD and discovery
- `hindsight.ts`: redaction, scoping, and Hindsight retention
- `schema.ts` / `types.ts`: tool schemas and shared contracts
- `index.ts`: thin Pi entry point and compatibility exports

## Safety rules

The extension enforces:

- strict kebab-case names: lowercase letters/digits with single hyphens between segments, max 64 chars
- no slashes, `..`, absolute paths, or empty names
- managed root must not be a symlink
- managed skill directories and `SKILL.md` files must not be symlinks
- reads use bounded `O_NOFOLLOW` file handles and reject hard links
- discovery contributes only explicit validated `SKILL.md` files, never the parent managed root
- create is exclusive; config and skill updates use same-directory atomic replacement
- failed updates preserve the previous complete file
- serialized, discovered, listed, and viewed skills honor `maxSkillBytes`
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
- Pi `0.80.3` and older do not provide `agent_settled`; upgrade Pi before using this extension version.

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
npm test --prefix pi/extensions/managed-skills
```

Typecheck after installing development dependencies in the extension directory:

```bash
npm install --prefix pi/extensions/managed-skills
npm run typecheck --prefix pi/extensions/managed-skills
```
