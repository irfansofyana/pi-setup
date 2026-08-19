# local Headroom adapter for Pi

Pi extension that integrates [Headroom Labs Headroom](https://github.com/headroomlabs-ai/headroom) without depending on a third-party Pi extension package.

## What it does

- Automatically starts a managed local `headroom proxy` for each Pi session, or adopts an already healthy proxy.
- Registers the configured OpenAI and Anthropic Pi providers against the complete Headroom proxy: OpenAI uses `${proxyUrl}/v1` (native `/v1/chat/completions`) and Anthropic uses `${proxyUrl}` (native `/v1/messages`).
- Compresses tool outputs as part of those real model requests, so proxy savings are recorded in the global Headroom dashboard.
- `localToolResultCompression` is a legacy opt-in mode. Only that mode applies the local `minChars`, exclusion, secret-output, and local CCR-retention rules.
- In legacy local mode, originals are stored in a local Pi CCR store and `headroom_retrieve` retrieves them by hash. It is not registered in the default native-proxy mode.
- `headroom_stats` — show session savings and whether the proxy's durable `/stats-history` is reachable. Native mode reports proxy requests separately from local compression counts. Its savings are proxy-history deltas; concurrent clients sharing the same proxy may be included.
- Shows compact Pi-session savings in the footer: `hr off` or `hr m 55k ↓10%` (`m` = managed proxy, `x` = external proxy).

## Install Headroom CLI

Headroom CLI ships from the Python package, not the npm SDK.

Recommended:

```bash
pipx install "headroom-ai[proxy]"
```

Alternative:

```bash
uv tool install "headroom-ai[proxy]"
```

Verify:

```bash
headroom --version
```

## Install this Pi extension

This extension loads from the first-party Pi package described in the [setup installation guide](../../../docs/setup/installation.md#install-the-package). Do not copy it into `~/.pi/agent/extensions/`; preserve the user-owned Headroom config when migrating a legacy copy.

Reload Pi:

```text
/reload
```

## Commands

```text
/headroom start                 # start managed proxy or adopt existing external proxy
/headroom stop                  # stop managed proxy only; disable compression
/headroom restart               # stop managed proxy, then start again
/headroom enable                # enable compression for current Pi session
/headroom disable               # disable compression for current Pi session
/headroom status                # show current status
/headroom stats                 # show Pi-session compression stats
/headroom doctor                # check CLI/proxy and print install commands
/headroom logs                  # show proxy log tail
/headroom logs clear            # clear proxy log
/headroom cleanup               # clean expired local CCR store entries
/headroom config show           # print effective runtime config
/headroom config save           # persist current runtime config
/headroom config reset          # reset runtime config to defaults
```

## Default config

Optional config path:

```text
~/.pi/agent/headroom/config.json
```

Defaults:

```json
{
  "enabled": true,
  "localToolResultCompression": false,
  "startup": "auto",
  "proxyUrl": "http://127.0.0.1:8787",
  "host": "127.0.0.1",
  "port": 8787,
  "minChars": 500,
  "compressionTimeoutMs": 10000,
  "startupHealthTimeoutMs": 30000,
  "fallbackToOriginal": true,
  "notifyFailures": "once",
  "allowRemote": false,
  "storeTtlHours": 24,
  "storeMaxEntries": 500,
  "storeMaxBytes": 104857600,
  "retrieveMaxBytes": 51200,
  "retrieveContextLines": 5,
  "excludeTools": [
    "edit",
    "write",
    "ask_user_question",
    "todo",
    "preview_export",
    "headroom_retrieve",
    "headroom_stats"
  ],
  "excludePathPatterns": [
    ".env",
    ".env.",
    "secret",
    "credential",
    "token",
    "private_key",
    "id_rsa",
    "id_ed25519"
  ]
}
```

## Lifecycle policy

### Native proxy mode (default)

- Default startup is automatic. Every Pi session starts a managed local proxy or adopts an already healthy proxy.
- Native routing requires both the Headroom proxy and its upstream provider to be ready before OpenAI or Anthropic overrides are installed.
- Readiness is checked again at `turn_start`. If an adopted external proxy disappears, the extension first restores Pi's native providers, then attempts one managed replacement when `startup` is `auto`; the triggering model request stays on native routing.
- Manual and off startup modes never recover automatically, and recovery uses no background polling.
- Optional proxy-history synchronization runs after turns. Repeated history failures back off without disabling otherwise healthy model routing.

### Legacy local compression mode

- With `localToolResultCompression: true`, provider routing is not overridden. Large Pi tool results are compressed locally through `/v1/compress`.
- Legacy readiness is compression-oriented: upstream-only health failures do not block local tool-output compression.
- If an auto-start session adopted another session's proxy and that proxy stops, the next eligible tool result triggers one managed replacement attempt. That tool result is bypassed; failed recovery disables local compression to prevent per-result retry storms.

### Shared lifecycle rules

- Set `startup` to `manual` to prevent automatic startup; then use `/headroom start`, or `/headroom enable` when the configured proxy is already healthy. Set it to `off` to prevent startup and compression.
- Remote proxy URLs are blocked unless `allowRemote` is explicitly set to `true`.
- If a proxy returns an identifiable `headroom-proxy` readiness payload at `proxyUrl`, the extension adopts it as external; unrelated local HTTP services are rejected.
- Automatic startup and `/headroom start` wait up to `startupHealthTimeoutMs` (default 30s) for slow local proxy readiness.
- If concurrent sessions race to start the same local proxy, a losing session rechecks readiness after its child exits and adopts the healthy winner instead of disabling compression.
- Missing CLI, log/PID setup failures, spawn errors, readiness timeouts, and unexpected managed-proxy exits always produce a Pi notification and disable Headroom safely; `notifyFailures` only controls repetitive legacy compression-path warnings.
- `/headroom stop` never kills an external proxy and disables Headroom for the current session.
- Native mode requires exclusive ownership of Pi's global `openai` and `anthropic` provider overrides. Do not load a duplicate Headroom copy or another extension that overrides those IDs; Pi does not stack third-party registrations. Disabling Headroom unregisters its overrides and restores Pi's built-in models, not a previous third-party override.
- Commands mutate runtime state only. Use `/headroom config save` to persist.

## Local CCR store

Original outputs are stored locally under:

```text
~/.pi/agent/headroom/store/
```

Default retention is 24 hours with entry and byte caps. Retrieval uses random `hr_...` IDs, not content hashes.

## Logs

Managed proxy logs go to:

```text
~/.pi/agent/headroom/headroom-proxy.log
```

## Smoke test

Inside Pi:

```text
/headroom doctor
/headroom status
```

The proxy should already be running after Pi starts. With `startup: "manual"`, use `/headroom start`; if the configured proxy is already healthy, `/headroom enable` activates routing without starting another process.

Then run a command that returns long text. In the legacy `localToolResultCompression: true` mode, compressed outputs end with a marker like:

```text
[Headroom: compressed tool output. Saved 12.3k tokens (72%). Original available via headroom_retrieve hash="hr_..."; pass query for focused retrieval.]
```

In the default native-proxy mode, Headroom owns compression and retrieval markers; inspect savings with `/headroom stats` or the global Headroom dashboard.
