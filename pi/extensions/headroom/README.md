# local Headroom adapter for Pi

Pi extension that integrates [Headroom Labs Headroom](https://github.com/headroomlabs-ai/headroom) without depending on a third-party Pi extension package.

## What it does

- Starts/stops a managed local `headroom proxy` only when asked.
- Compresses final Pi `tool_result` text through `POST /v1/compress`.
- Includes all large text tools by default, including MCP, web search, web fetch, logs, file reads, grep results, and unknown future tools.
- Skips small outputs under 500 chars, excluded tools, and secret-like outputs.
- Stores originals in a local Pi CCR store so no Headroom MCP server is needed.
- Registers native Pi tools:
  - `headroom_retrieve` — retrieve original output by hash, optionally with query.
  - `headroom_stats` — show session savings.
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

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/headroom ~/.pi/agent/extensions/
```

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
  "startup": "manual",
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

- Default startup is manual. Nothing starts until `/headroom start`.
- Remote proxy URLs are blocked unless `allowRemote` is explicitly set to `true`.
- If a proxy is already healthy at `proxyUrl`, extension adopts it as external.
- `/headroom start` waits up to `startupHealthTimeoutMs` (default 30s) for slow local proxy readiness.
- Readiness is compression-oriented: upstream-only health failures do not block local tool-output compression.
- `/headroom stop` never kills an external proxy.
- `/headroom stop` disables compression for current session.
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
/headroom start
```

Then run a command that returns long text. Compressed outputs end with a marker like:

```text
[Headroom: compressed tool output. Saved 12.3k tokens (72%). Original available via headroom_retrieve hash="hr_..."; pass query for focused retrieval.]
```
