# Shared activity presentation

`activity-dock.ts` coordinates package-owned Todos and Subagents widgets through
Pi's public TUI component API. This is a helper module, not a separate extension
entrypoint. Neither extension requires the other or a particular theme.

- Registrations are scoped to the exact TUI host, shared across extension-loader
  evaluations through a weak registry. No task data is persisted here.
- Each extension owns and disposes its registration. Todos' component paints the
  combined area when present; otherwise Subagents paints it. Other registrations
  render zero rows. Replacing a registration cannot let old cleanup remove it.
- Content order is always Todos, then Subagents, independent of load order.
  The resting budget is six rows; focused navigation gets up to ten, with one
  summary row reserved for the other visible section. Short terminals reduce
  the budget to preserve editor/transcript space. Attention gets allocation priority.
- Mouse coordinates route through the last rendered section boundaries and
  registration identity. Obsolete components cannot act on stale rows.
- The renderer installs no editor or keyboard hooks. Extension-owned controls
  retain their focus and selected agent identity. Rendering failures fall back
  to the affected section's command without hiding the other section.

Lightweight checks:

```bash
node --test pi/extensions/shared/activity-dock.test.ts
```

After `/reload`, check each extension alone, both load orders, short/narrow
terminals, completed/unread summaries, and arrow/click navigation. Reloading or
disabling one section must leave the other usable. Real Pi UI smoke testing also
covers widget disposal, theme changes and session switches.
