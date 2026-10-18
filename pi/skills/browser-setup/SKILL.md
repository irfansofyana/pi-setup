---
name: browser-setup
description: Set up or troubleshoot default Chrome integration and remembered opt-in in Pi without a Chrome extension. Use for prerequisites, enable/disable, startup errors, duplicate MCP sources, consent and rollback—not routine page navigation.
---

# Browser setup

Read [browser assistance](../../../docs/setup/mcp.md#browser-assistance) before auditing or proposing changes. The package's browser controller owns the MCP release pin and launch flags; use that source instead of choosing `latest`.

## Audit and proposal

1. Clarify whether the user wants setup, a read-only diagnosis, or a live connection. Implementation approval alone does not authorize personal config changes or private-page access.
2. Check Pi/Node/Chrome versions without starting a browser or MCP server. Chrome must be 144+ and already running locally; default profile is selected by Chrome. No named-profile picker or Chrome extension is required.
3. Inspect native `/mcp`, `browser_status` preference metadata and relevant personal/project MCP definitions for existing Chrome DevTools connections. Show only necessary names/status; redact credentials. Never dump environment variables, private preference values, browser profile metadata or the full policy export.
4. On managed devices, have the user check `chrome://management`, relevant `chrome://policy` entries and remote-debugging availability. Stop if prohibited; request IT approval rather than bypassing policy.
5. Report compliant, missing, conflicting and untested items. Present numbered proposals for persistent changes, including private backup/rollback plans. Preserve unknown keys, shared/legacy MCP files and existing connections. Read-only diagnosis ends here.

## Approved activation

1. Use one-time `/browser enable`: it records global opt-in and restores tools in later interactive TUI/RPC sessions/reloads without another Pi prompt. Chrome may still require approval on every debugging connection. Explain that first `npx` use may download/execute the pinned server with Pi's OS permissions; never silently enroll a device.
2. Ask the user to enable remote debugging at `chrome://inspect/#remote-debugging` in existing Chrome, only if permitted. Have the user invoke `/browser enable` and accept its notice. Do not use shell/CLI to bypass interactive activation. Existing enabled Chrome MCP entries need native `/mcp` use or a separately approved migration, not duplication.
3. Discover only the page-listing tool in namespace `mcp__pi_setup_browser`, then call it after permission to inspect existing tab metadata. Chrome's separate approval may appear on first browser use. Never interpret cancellation as approval.
4. Verify a harmless, recognizable pre-existing tab with the user. Tool discovery or a successful page listing does not independently prove profile/account identity; private authenticated reads need an agreed task and intended account.
5. Confirm no substitute browser/profile was created. If wrong session, denied consent, missing tools or connection failure occurs, stop and diagnose through `/browser status` and `/mcp`. Never copy profiles, export cookies or fall back to a standalone browser.
6. For page work, load [browser-assist](../browser-assist/SKILL.md).

## Rollback and handoff

- `/browser disable` removes current registration and revokes future startup. Other Pi sessions/connections and Chrome debugging are unchanged; have the user stop those separately if desired. Normal Pi exit cleans up its connection while retaining opt-in for the next session.
- Enrollment writes only user-owned global `browser/config.json`, preserving unknown keys and privately backing up existing contents. Invalid schemas, drift or uncertain locks need manual diagnosis, not a forced overwrite. A failed persistent disable must not be described as revocation.
- Before restoring persistent config, re-read targets and stop on drift; restore only the separately approved changes from a private backup.
- After package/code changes, ask the user to run `/reload` or restart Pi. Remembered opt-in restores tools on interactive startup; otherwise explicit `/browser enable` is required. Enable/disable commands apply their own preference changes immediately. Never restore removed legacy MCP definitions or turn project-local data into global approval.
- Report exact checks performed and unresolved live-test gaps. Keep private page data out of durable memory and repository artifacts.
