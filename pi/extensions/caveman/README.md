# Local Caveman Pi extension

Repo-owned replacement for the old external Caveman package.

Purpose: terse Pi answers on demand, with local config and no external Git package dependency.

## Install

From repo root:

```bash
mkdir -p ~/.pi/agent/extensions
rm -rf ~/.pi/agent/extensions/caveman
cp -r pi/extensions/caveman ~/.pi/agent/extensions/
```

Then reload Pi:

```text
/reload
```

Do not keep the old external Caveman package active at the same time. Both register `/caveman`.

## Commands

```text
/caveman                         Toggle off/full
/caveman lite                    Professional, no fluff
/caveman full                    Classic terse caveman
/caveman ultra                   Maximum compression
/caveman micro                   Small prompt, terse output
/caveman off                     Disable
/caveman normal                  Disable
/caveman status                  Show current state
/caveman config                  Show config help
/caveman default full            Persist default level
/caveman status-bar off          Hide footer status
/caveman auto-trigger on         Enable phrase triggers
/caveman trigger-level full      Level used by phrase triggers
```

Natural phrases also work when `autoTrigger` is on:

- `caveman mode`
- `talk like caveman`
- `less tokens`
- `be brief`
- `be terse`
- `normal mode`
- `stop caveman`

## Config

Primary config:

```text
~/.pi/agent/caveman/config.json
```

Legacy upstream config is read if primary config does not exist:

```text
~/.pi/agent/caveman.json
```

Default config:

```json
{
  "defaultLevel": "full",
  "showStatus": true,
  "autoTrigger": true,
  "triggerLevel": "full"
}
```

## Verify

```text
/caveman status
/caveman full
Explain why React inline object props cause re-render.
/caveman off
```

Expected caveman answer keeps technical terms exact, e.g. `useMemo`, file paths, commands, JSON, and quoted errors remain unchanged.

## Upstream credit

Inspired by upstream Caveman-style Pi extension work and Julius Brussee's caveman prompt. Upstream MIT notice lives in `UPSTREAM-LICENSE.md`. This local extension is kept in-repo so install steps remain reproducible on fresh machines.
