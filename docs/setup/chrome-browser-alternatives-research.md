# Chrome assistance alternatives: extension-free constraint

Research date: 2026-10-18. Documentation research only; no installs, browser connections, local benchmarks or user-configuration changes.

## Updated decision

The user subsequently accepted Chrome's default profile. The arbitrary named-profile eligibility gate below is therefore historical, not a current requirement. The package now implements opt-in Chrome DevTools MCP `--autoConnect`; see [current setup and acceptance checks](mcp.md#browser-assistance). No additional Chrome extension is required. Live browser/enterprise compatibility remains untested.

## Original decision (before profile requirement was relaxed)

**No researched candidate is verified to satisfy all requirements together:** already-running authenticated Chrome, no additional Chrome extension, explicit saved selection of a named profile, and operation under unspecified IT policies.

Use **Chrome DevTools MCP autoConnect as the attachment reference**, and evaluate **agent-browser CDP mode** plus **browser-use CLI** as alternate control surfaces. Neither CLI is an established workaround for a browser that disallows debugging. There is no demonstrated universal reliability or token-efficiency winner.

This updates the provisional Playwright extension-mode recommendation in [the original research](chrome-browser-research.md). The user subsequently made no additional Chrome extension a hard requirement. A Pi extension with bundled skills remains acceptable.

## Eligible shortlist

| Candidate | Extension-free existing-browser path | Strength worth testing | Unresolved constraint |
| --- | --- | --- | --- |
| Chrome DevTools MCP | Chrome 144+, enable remote debugging in Chrome UI, approve `--autoConnect` session | Chrome-maintained, documented normal-session attachment | Chrome chooses default profile; arbitrary saved named-profile routing not established [1][2] |
| agent-browser | `--auto-connect`, `--cdp`, or `connect` to an existing endpoint | CLI/JSON surface; documented strict tab binding and recovery | Endpoint selection is not named-profile selection; release parity and policy compatibility need testing [3] |
| browser-use / Browser Harness CLI | Default local flow documents existing Chrome CDP attachment; `BU_CDP_URL`/`BU_CDP_WS` override endpoint | Task-specific code/output and batching | Named local-profile routing and recovery guarantees unverified; Python execution grants broader process authority [5] |

The parent fetched [3], [4], [5], [9] and [10]; researchers fetched the other material sources. Current documentation is not proof of behavior in a pinned release.

### agent-browser: important distinction

Its documentation says:

> agent-browser copies the profile to a temp directory (read-only snapshot) and launches Chrome with your existing cookies and sessions.

That describes `--profile` reuse, **not** the requested attachment workflow. Exclude profile copying, authentication export and replacement-browser launch. Use only an established existing-browser CDP connection. [4]

CDP auto-discovery reads `DevToolsActivePort`, then probes common ports. Current docs connect this to Chrome 144+ UI-enabled remote debugging. Strict `--pin-tab` returns `tab_gone` when a bound tab disappears rather than silently targeting another tab. These are useful mechanisms, not measured resilience or profile isolation. A named agent-browser session is not a Chrome profile. [3][4]

### browser-use: important distinction

Its current CLI docs say:

> The default local flow attaches to your running Chrome or Chromium through CDP.

They document retaining tabs, cookies and logins, and explicit endpoint overrides. They do not establish an independent way to attach when Chrome forbids debugging, or reliable selection of a named local profile. Keep cloud modes separate: a remote cloud browser does not satisfy live local Chrome. [5]

### Shared attachment limitation

Browser channel, CDP endpoint, selected tab, CLI session and named Chrome profile are different identities. Do not label a saved endpoint “Work” and claim verified profile routing without testing the connection against independently established identity.

Chrome 136's default-data-directory restriction applies to legacy `--remote-debugging-port`/`--remote-debugging-pipe` startup switches. Do not propose a separate user-data directory as a solution: it violates this task's requirements. Chrome 144+ UI-enabled autoConnect is the documented normal-session path. [1][2][11]

## Excluded alternatives

| Alternative | Reason |
| --- | --- |
| Playwright MCP extension mode | Requires additional Chrome extension, despite documented named-profile routing |
| Playwriter | Existing-profile/tab opt-in and profile selectors documented, but browser bridge requires Chrome extension |
| Browser MCP | Existing-profile connected-tab workflow requires Chrome extension |
| hangwin/mcp-chrome | Chrome extension plus native bridge; deterministic profile arbitration not established |
| real-browser-mcp | Separate ports can route profile connections, but Chrome extension required |
| Stagehand v4 documented local connection | Discovers or loads Stagehand extension; automatically loading one still violates requirement [7] |
| Browserbase/cloud browser sessions | Not the user's running local Chrome |

Stagehand v3 documents `localBrowserLaunchOptions.cdpUrl` attachment and semantic extraction. Keep as a reserve experiment only after pinning a v3 release and proving no extension is installed/loaded. Count its own model calls when comparing costs. It does not resolve the underlying profile/policy gap on this evidence. [6]

Extension alternatives were investigated before the hard constraint arrived. Their feature claims are not reasons to weaken that constraint. Project sources: [Playwriter](https://github.com/remorses/playwriter), [Browser MCP](https://github.com/browsermcp/mcp), [mcp-chrome](https://github.com/hangwin/mcp-chrome), [real-browser-mcp](https://github.com/ofershap/real-browser-mcp).

## Managed Chrome: conditional, not a bypass

Being managed does not automatically disable automation. Actual policy, Chrome version, approved software and data-handling rules decide eligibility.

Official Chrome documentation describes Chrome 155 restrictions on extensions using `chrome.debugger`: nonempty extension `runtime_blocked_hosts` can block attachment to all targets; screenshot/DLP restrictions can also prevent attachment. This directly contradicts treating extension bridges as generally more resilient to IT controls. [9]

That source concerns the extension debugger transport. It does **not** independently establish identical policy behavior for every DevTools autoConnect or CDP path. This research did not exhaustively validate `RemoteDebuggingAllowed`/`DeveloperToolsAvailability` against UI autoConnect. Do not present a blanket policy matrix as proven.

Safe deployment procedure:

- Inspect `chrome://management` and relevant effective policies at `chrome://policy` with the user; do not dump the entire policy export into chat or commit company settings.
- Verify whether remote debugging is available and permitted, and whether Pi/model access to work-page content is approved.
- Ask IT for an approved integration if blocked. Do not change managed policies, bypass consent, copy profiles or export cookies.
- Fail closed when connection or scope cannot be established.

## Token efficiency: evidence and limits

Fewer tools or a CLI interface does not automatically mean fewer total tokens. Relevant costs include schemas, skills, tool results, repeated conversation input, cached input, output/reasoning and any secondary extraction-model calls.

Browser Use publishes a vendor benchmark measured 2026-10-14, using Codex CLI 0.144.6/GPT-6 Luna, 100 BU Bench V2.1 tasks, one run per task, and the same fresh cloud browser. Reported median input tokens: [10]

| Surface | Reported median input tokens |
| --- | ---: |
| Browser Harness | 2.13M |
| agent-browser | 3.33M |
| Playwright MCP | 4.38M |
| Chrome DevTools MCP | 6.71M |

These are cumulative benchmark input figures, **not per-call context size**. The vendor states all paired success-score intervals include zero: no success winner established. It discarded and reran an initial agent-browser pass because of its own setup bug. Accounting is not decomposed into cached input, schema/results and reasoning. Cloud/Codex results cannot establish local Pi/profile performance or enterprise compatibility. Do not repeat “93% fewer tokens” as a verified general result.

Researchers observed release/docs mismatches: agent-browser releases showed v0.38.2 while other main/benchmark material mentioned 0.39.1; Browser Harness benchmark names commit `a6426f84`/CLI 0.1.13, not merely a version label. Pin exact artifacts before testing; these observations are not latest-version recommendations.

## Recommended Pi experiment

First prove attachment and identity; only then compare control surfaces.

1. **Eligibility:** no extension installed or loaded, no new browser, no profile copy or auth export. With two profiles open on the same site, confirm selected identity independently of page title/URL. Wrong-profile attachment disqualifies the candidate.
2. **Pin:** exact Pi/model/settings, Chrome/OS, CLI or MCP versions, enabled schemas, skills and output caps. Verify CLI help/tool schemas against installed artifacts.
3. **Tasks:** summaries with factual coverage checks; paginated/virtualized table extraction with cell/completeness scoring; read-only multi-step navigation; stale DOM, closed tab, process restart, endpoint change and expired-login recovery.
4. **Safety:** no unintended profile/tab switching; stop on auth or permission failures. Disconnect must preserve user tabs/browser and unsaved work. Use nonsensitive test data and IT-approved systems.
5. **Measurements:** end-to-end success, wrong-target events, factual accuracy, calls, result bytes, first-result/total latency, retries, context/input/output/cached tokens and total cost including secondary models. Separate cold start and warm runs; repeat paired tasks with varied order. Record failures, not only successful runs.
6. **Compare:** native Chrome DevTools MCP with lazy discovery/bounded output; agent-browser CDP CLI; browser-use CLI. Optionally compare a small typed wrapper over the same CLI, keeping output budgets comparable.

A custom Pi tool surface could eventually validate connection/tab identity and return compact extraction records. That is an implementation proposal, not an existing security mechanism. Skills can guide workflows; they cannot enforce read-only behavior. Arbitrary evaluation, shell and Python remain powerful. Native Pi MCP can also reduce results through codemode, so optimization need not require replacing MCP.

## Next decision

Proceed with a small **extension-free attachment/profile proof of concept**, not full UI implementation. If profile routing cannot be proven, ask whether the user accepts one explicitly confirmed active/default profile per session. Do not silently relax saved-profile selection. If IT policy prohibits attachment, stop and pursue an approved alternative workflow rather than another CDP wrapper.

No backend selected as universally superior. No package installation, live browser test, production code or user configuration mutation authorized by this report.

## Sources

1. [Chrome existing-session autoConnect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect).
2. [Chrome DevTools MCP advanced usage](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md).
3. [agent-browser CDP mode](https://agent-browser.dev/cdp-mode).
4. [agent-browser sessions and profile reuse](https://agent-browser.dev/sessions).
5. [browser-use CLI](https://docs.browser-use.com/open-source/browser-use-cli).
6. [Stagehand v3 reference](https://docs.stagehand.dev/v3/references/stagehand).
7. [Stagehand v4 browser configuration](https://docs.stagehand.dev/v4/configuration/browser).
8. [Original Pi integration design and safety contract](chrome-browser-research.md).
9. [Chrome debugger enterprise policy changes](https://developer.chrome.com/blog/debugger-enterprise-policy-restrictions).
10. [Browser Use vendor benchmark methodology/results](https://browser-use.com/benchmarks/coding-agent-browser-tools.json).
11. [Chrome remote-debugging-port security change](https://developer.chrome.com/blog/remote-debugging-port).
