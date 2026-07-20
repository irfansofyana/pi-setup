# Command Deck

Repo-owned custom Pi chat editor used by the `irfan-pi` setup.

Provides:

- `ASK` labeled input frame
- `Ask, build, or investigate…` placeholder
- Ready, thinking, tools, error, and bash state labels
- Spinner and scroll indicators
- Responsive narrow-terminal fallback
- `@` file, `/` command, and newline hints

Uses Pi's public `CustomEditor` extension API. It does not patch Pi or `@earendil-works/pi-tui`.

Requires Pi `>=0.80.10`. Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`; no extra runtime package is required.

Install by copying this directory to:

```text
~/.pi/agent/extensions/command-deck/
```

Run `/reload` after installation. Re-copy repo template after updates.
