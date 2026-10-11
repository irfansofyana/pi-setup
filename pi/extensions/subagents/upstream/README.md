# pi-subagent-manager

[![npm version](https://img.shields.io/npm/v/pi-subagent-manager.svg)](https://www.npmjs.com/package/pi-subagent-manager)
[![npm downloads](https://img.shields.io/npm/dm/pi-subagent-manager.svg)](https://www.npmjs.com/package/pi-subagent-manager)
[![CI](https://github.com/championswimmer/pi-subagent-manager/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/championswimmer/pi-subagent-manager/actions/workflows/tests.yml)
[![codecov](https://codecov.io/gh/championswimmer/pi-subagent-manager/branch/main/graph/badge.svg)](https://codecov.io/gh/championswimmer/pi-subagent-manager)

Subagents for pi: let your main conversation hand work to named, steerable helper agents — in parallel, nested, and resumable.

📜 [Changelog](CHANGELOG.md)

## Install

Requires pi **0.99.2+**. No build step.

```sh
pi install npm:pi-subagent-manager
```

For local development:

```sh
pi install /absolute/path/to/pi-subagent
# Or try it without installing:
pi -e ./src/index.ts
```

## How it works

It combines ideas from two tools:

- **Like Claude Code subagents:** each agent runs in its own session, with its own system prompt, model and tools, and hands back only its final answer. Agent **types** are Markdown files with frontmatter. The type says _what job_ an agent does.
- **Like Codex:** every running agent has a **path**, such as `/root/fix-auth/review`. The path says _where it sits_ in the tree.

Type and path are independent. One `reviewer` type can run at `/root/fix-auth/review` and `/root/docs-pass/review` at the same time.

```text
/root                          ← your main pi conversation
  /root/fix-auth               ← child: starts with a snapshot of /root
    /root/fix-auth/review      ← grandchild: snapshot of /root/fix-auth
/k                             ← independent root: no /root history
```

## What a subagent can do

- **Finish** — returns a final answer (not its whole transcript) to the parent.
- **Pause** — hands back without an answer; resume it later.
- **Report progress** — sends updates while it keeps working.
- **Be steered** — the parent can send it more input, or resume it after it finishes.
- **Survive restarts** — threads are saved with the main session and come back on `/reload` or `pi --resume`.

## Bundled agents

| Type         | Use it for                                          |
| ------------ | --------------------------------------------------- |
| `architect`  | Plans, tradeoffs, coordinating other agents         |
| `coder`      | Implementation, debugging, refactoring, frontend UI |
| `researcher` | Source-backed codebase and web research             |
| `reviewer`   | Finding real defects; suggests minimal fixes        |
| `tasker`     | Small bounded jobs and quick repo lookups           |
| `writer`     | Prose and editing                                   |

They inherit your current model until you set preferences. Details: [docs/default-agents.md](docs/default-agents.md).

## Commands

| Command          | Opens                                                  |
| ---------------- | ------------------------------------------------------ |
| `/agents`        | Settings (mode, limits, model picking, tool filtering) |
| `/agents types`  | Agent-type browser and editor                          |
| `/agents tree`   | Fullscreen tree and live viewer with manual steering |
| `/agents import` | Import agents from other subagent extensions           |
| `/agents reload` | Reload definitions and settings                        |
| `/agents reap`   | Confirm the eligible count, then forget completed agents and free retained-thread slots (cannot be resumed); preserves active parents and ancestors of retained threads. Session files remain on disk. |

A live **Agents** widget sits above the input box. Choose **Full** (the existing tree) or **Minimal** (colored status counts and running-agent token totals, plus the browser hint) under **Status Widget** in `/agents` settings. In the fullscreen tree, **Enter** opens an agent's live view. Type in the bottom **Steer** input and press **Enter** to send it a steering message, including nested agents. **Tab** switches between input and transcript controls, **Escape** returns, and **i** in the tree opens existing thread actions. A status strip below the previews shows how many agents are running and **Press ← to open subagent browser**. Once the main turn ends and all subagents are idle, the preview collapses to a single status-count line. A fresh prompt hides previously settled agents from the widget; they reappear only when resumed, and `/agents tree` always keeps them available. While subagents are starting or running, press **Left** at the start of the main draft to open it; otherwise Left stays native. Press **Right** at the end of the draft (or in an empty input) to collapse the widget to one line for this session only, without changing saved settings. `/agents tree` remains available regardless of agent activity. See [live navigation](docs/tools-and-ui.md#live-agent-navigation) for controls and compatibility.

**Cost accounting:** Agent rows show estimated USD cost (including cache reads/writes) when reported. Completed, paused, stopped, and failed agents roll up only newly incurred cost. Accounting survives resume, reload, branch navigation, and reaping; nested agents' own costs are counted once. Running-agent costs remain in their rows until settlement. This changes the footer display, not Pi's native session statistics.

- Choose **[labs] Cost display** in `/agents settings`: **pi-footer status key** (default), **pi-footer event**, or **Pi status only**. The stable ID/key is **`subagent_cost`**.
- **`npm:pi-footer`:** with the default status-key mode, add **Extension Status** through `/footer` and select **`subagent_cost`**. Event mode instead requires a **Pi Event Value** widget with **Widget ID** entered manually and **Raw value only** enabled; event IDs are not listed in the status selector.
- Values publish at session start and immediately on subagent startup, including `$0.0000`, then after settlement/settings changes. Status modes leave your footer untouched; event mode retains the combined-cost fallback when no extension provides `/footer`. See [Cost display settings](docs/settings.md#labs-cost-display-costdisplay) and the [pi-footer setup guide with exact snippets](docs/pi-footer.md).

Experimental features are marked **[labs]** in settings. Enable **[labs] Nerd Font icons** in `/agents` to show role-specific icons beside agent names (off by default; requires a Nerd Font in your terminal). Loaders appear **before**, never instead of, the role icon. Choose Circle, Braille, or Hourglass under **[labs] Loader style**, with previews of every animation frame and each family's completed, paused, failed, and stopped icons. Custom agent types can set an optional `icon` or use **[labs] Icon** in `/agents types`. See [icon setup](docs/settings.md#labs-nerd-font-icons-nerdfonticons).

Enable **[labs] Final Recap** in `/agents` to automatically ask the idle main agent to summarize detached-agent results, keeping the final response in the main thread. It is off by default and suppressed by Subagent Mode Off. **Enabling it may cause extra model turns and uses more tokens and context.** See [Final Recap](docs/settings.md#labs-final-recap-finalrecap).

## Docs

- [Your own agent](docs/custom-agents.md) — walkthrough for writing an agent type
- [Settings](docs/settings.md) — every setting and option, and when to use each
- [Threads and lifecycle](docs/threads.md) — paths, context, pause/resume, persistence
- [Tools and UI](docs/tools-and-ui.md) — model-facing tools, parallel work, dialogs
- [Importing agents](docs/importing-agents.md) — migrate from other pi subagent packages
- [Bundled agents](docs/default-agents.md) — routing, tool boundaries, model suggestions
- [Development](docs/development.md) — tests, code layout, releases

## Good to know

- Tool policies are **not a sandbox**. Agents share your working directory and OS permissions.
- Children can use your registered extension, MCP and web tools when [Tool Filtering](docs/settings.md#tool-filtering-toolfiltering) permits them. Skills are not automatically loaded; external tools share main-session resources/context.
- Don't run multiple subagent extensions together — they clash on `/agents`.

## License

[MIT](LICENSE)

