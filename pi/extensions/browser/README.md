# Browser assistance

Package-owned commands, remembered opt-in and a read-only status tool over native Pi MCP. Official Chrome DevTools MCP attaches to Chrome's default profile through `--autoConnect`; no Chrome extension, profile copy, shared daemon or standalone-browser fallback.

## Interface

| Command | Effect |
| --- | --- |
| `/browser setup` | Read-only skill audit/proposal; never installs, connects or writes settings |
| `/browser enable` | Interactive one-time consent; save global opt-in and register tools now |
| `/browser disable` | Remove current registration and disable future automatic registration |
| `/browser status` / `browser_status` | Inspect registration and preference metadata without connecting or reading tabs |

The public interface has only setup, enable, disable and status. An already-approved `/browser enable` is idempotent and never duplicates an existing registration. Unsupported former lifecycle arguments report removal and make no changes; they are not aliases for persistent consent. Chrome's separate debugging approval is still required as Chrome determines. Commands apply immediately; package/code updates require `/reload` or restart.

## Preference ownership and storage

Default global path: `~/.pi/agent/browser/config.json`, resolved through Pi's `getAgentDir()`. No project overrides are read.

```json
{
  "schemaVersion": 1,
  "enabled": true
}
```

- Missing preference means off; factory, startup, setup and status create no preference files. Package installation never enables access.
- Only explicit enable/disable commands write preferences. New directories/files use `0700`/`0600` on POSIX; existing file modes and unknown JSON keys are preserved. Store no credentials, browser identities, cookies or page data here.
- Changes compare the reviewed snapshot, acquire an exclusive `.config.lock`, re-read before commit and atomically rename a private temporary file. Existing settings receive an exact `0600` backup under `browser/backups/` before mutation. Retain backups until accepted; restore only reviewed changes after checking drift, not a stale whole config over newer data.
- Malformed/future schemas, files over 64 KiB, symlinked feature paths, conflicting edits and uncertain locks fail closed. No automatic stale-lock reclamation, watcher, timer, telemetry or backup cleanup.
- If disable cannot save, current-session removal still takes effect and the error does not claim future access is disabled. Saved opt-in may remain enabled until fixed. A successfully committed opt-in remains approved even if later session registration fails; status distinguishes these states.

## Session lifecycle

- Fresh installs stay off. With saved opt-in, `session_start` automatically registers tools only for interactive TUI/RPC (`hasUI`) sessions. Print/JSON sessions never auto-start; this is not an unattended-browser feature.
- Register the pinned process as `pi-setup-browser`; discover `mcp__pi_setup_browser__*` through codemode. `controller.ts` owns pin/flags; native Pi owns transport, discovery, errors and asynchronous cleanup.
- MCP registration starts the server process (`npx` can download the pin on first use), not a separate browser. Chrome attaches on browser use and may ask permission for each debugging session. Status/tool discovery does not prove attachment, account identity or health.
- Shutdown/reload/session replacement removes only the owned registration. Saved opt-in restores tool availability in the next interactive session. No manual connection or session-pause command is needed: exit Pi normally, or use `/browser disable` to stop current and future access.
- Global disable changes future startup and this session only, not other running Pi processes, other browser connections or Chrome's remote-debugging toggle. Native `/mcp` changes to an extension registration are session-local, not remembered-access settings.
- Busy operations serialize preference/connection changes. Runtime cancellation prevents late confirmation/startup registration and preference commits before the commit point; unexpected user-facing errors are sanitized. Failed native removal retains registered state for retry.

## Conflicts and safety

Audit personal/current-project native MCP files and extension registrations before connection and around enrollment consent. Known enabled Chrome DevTools sources, partial project re-enablement of a disabled personal source and any reserved-name override block a duplicate. Checks are conservative about project trust; custom wrappers, HTTP bridges and other Pi processes cannot all be identified. User MCP configuration is never edited automatically and deleted legacy entries are never restored.

The pinned server's **full standard tool inventory** is available, including tab closing, network inspection, performance and emulation. No project category/tool filters apply; optional experimental features are not enabled automatically. Usage statistics and CrUX reporting remain opted out.

Remembered availability is not blanket authorization: scope actions to the user's task, clarify ambiguous tab cleanup, protect unsaved work and ask before consequential actions. Skills are not read-only gates or a sandbox. Data may reach providers/session logs. Chrome 144+, a running local stable Chrome, enabled remote debugging and permitted IT policies remain prerequisites. Chrome approval cannot be saved or bypassed by this preference.

## Verification

`npm run test:browser` covers the four-command interface and no-op removal guidance, preferences/backup/drift/locking, future-session reuse and revocation, duplicate detection, lifecycle cancellation, sanitized failures and skill/package contracts without starting Chrome. The consolidated bounded CI matrix checks SDK imports and tests; adding it does not mean CI ran. Existing-profile reading has been exercised; remembered startup, full tab-close/detach behavior and OS/policy compatibility still need user-approved live checks. Scenario cases are not completed LLM evaluations.

Final independent static review of the four-command interface and remembered-access implementation found no blocking defects. That review did not rerun tests or replace the remaining CI/live acceptance checks.

See [MCP browser assistance](../../../docs/setup/mcp.md#browser-assistance) for activation, rollback and acceptance checks.
