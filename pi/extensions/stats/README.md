# Stats

Package-owned `/stats` dashboard over local Pi session history. Ported from
[`irfansofyana/pi-stats-ext`](https://github.com/irfansofyana/pi-stats-ext), version
`0.2.0`, commit
[`572574a039fe7bba4af6caceea4ba0af6067f5b0`](https://github.com/irfansofyana/pi-stats-ext/commit/572574a039fe7bba4af6caceea4ba0af6067f5b0).
MIT license, Copyright (c) 2026 Irfan Sofyana. See [LICENSE](LICENSE).

Upstream dashboard features preserved. Command, header and indexing-summary prefix
renamed to `stats`; no `/pi-stats` alias. Relative imports use `.ts` for native
Node tests, with added command/cache compatibility checks. Root extension glob loads `index.ts`.
No extra runtime dependency, model call, network request or startup scan.

## Dashboard

```text
/stats
/stats today
/stats 7d
/stats 30d
/stats 90d
/stats all
/stats 2026-06-01..2026-06-30
```

- Default range: `30d`. Numeric aliases `7`, `30`, `90` also work. Dates use UTC;
  custom range includes both endpoints.
- Overview, Models, Projects and Sessions views.
- Responsive, Pi-theme-aware cards: fresh tokens, cost, cache leverage and cost
  per million fresh tokens. Fresh tokens = input + output + cache writes.
- Previous-period comparisons, matched elapsed windows for current periods,
  spend/cache signals and model-concentration guidance.
- Activity heatmap with month labels, active-day cadence, peak/average usage,
  current/best streaks, busiest weekday and fresh-token trend.
- Model efficiency table: usage share, cost, cache leverage, efficiency and session
  count. Inspector shows provider, project/session reach, baseline and routing advice.
- Bordered project/session tables ranked by cost, then total tokens.
- Cached results display immediately; incremental refresh updates open dashboard.
  Late refresh completion does not repaint closed dashboard.

## Keys

| Key | Action |
| --- | --- |
| `1` / `2` / `3` / `4` / `5` | Today / 7d / 30d / 90d / all |
| Left / Right | Cycle date range |
| `d` | Enter custom range; Enter applies, Esc cancels |
| `o` / `m` / `p` / `s` | Overview / Models / Projects / Sessions |
| Tab | Cycle views |
| Up / Down or `k` / `j` | Select model |
| Enter in Models | Toggle model inspector |
| `q` / Esc / Ctrl-C | Close dashboard, except while editing dates |

Kitty printable-key encoding supported. Narrow terminals reflow cards/activity
panels and fit table columns to available width.

## State and modes

Agent root: `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`.

- Reads `sessions/**/*.jsonl`; never rewrites session history.
- Keeps existing version-2 cache at `pi-stats/cache.json`, including session names,
  project paths and usage metadata. Treat cache as private user-owned state.
- Reuses unchanged files, deduplicates copied fork events and saves cache atomically.
- Missing session root or shrinking/unreadable file retains prior cached data and
  reports indexing errors. Invalid/legacy cache rebuilds from session files.
- TUI opens dashboard. Other modes retain upstream stdout indexing summary rather
  than custom UI. No new configuration or model-facing tool.

Standalone `pi-stats-ext` still exposes `/pi-stats`, a redundant dashboard rather
than a `/stats` alias. Audit manual loaders too. Verify bundled command first;
source removal needs explicit approval and private backup.
Preserve cache and sessions. See [migration guidance](../../../docs/setup/local-extensions.md#stats).
Run `/reload` after approved package/source changes; restart Pi after changing
`PI_CODING_AGENT_DIR`.

## Validation

27 upstream tests cover aggregation/cache safety, date ranges, responsive layout,
comparisons, activity, Kitty keys, model inspection and command lifecycle. Added
registration test enforces `/stats` without legacy alias; command refresh test
checks unchanged version-2 cache path. Root
extension suite and bounded CI discover adjacent `*.test.ts` files automatically.

Focused command, inside resource-bounded validation environment:

```bash
node --experimental-transform-types --test --test-concurrency=1 pi/extensions/stats/*.test.ts
```
