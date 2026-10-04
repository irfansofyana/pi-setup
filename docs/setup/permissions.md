# Permissions and trust

This repository does not install or manage a permission-system companion. The required companion list is owned by `piSetup.requiredPackages` in root `package.json`; do not reinstall a removed permission extension during setup or migration.

## What still requires approval

The bundled setup skill remains proposal-first:

- Audit before changing settings, package sources, loaders, agents or configuration.
- Present numbered proposals; apply only explicitly approved actions.
- Re-read targets, stop on drift, and back up privately before mutation.
- Preserve unrelated settings, state, credentials and unknown keys.
- Keep existing theme selection unless a separate switch is approved.

These are procedural instructions, not automatic tool-execution gates or a sandbox. This package does not promise approval prompts for every shell command, file write, MCP call or memory retention operation. Any controls supplied by the surrounding client, OS or user configuration remain separate.

## Extension and project trust

Pi extensions execute inside the Pi process with its operating-system permissions. Review sources before installing packages or trusting project resources; tool allowlists and agent instructions are not an OS security boundary.

Use reviewed global agent templates. Do not invoke agent definitions from an untrusted repository. Keep credentials in `/login`, environment variables or provider profiles, not repository files.

## Existing configurations

Removing an extension source does not authorize deleting its configuration, logs or state. Leave residual user-owned policy files untouched unless cleanup is separately approved. Setup must not restore the removed extension or generate a replacement policy.

Run `/reload` or restart Pi after approved package/configuration changes. See [Installation](installation.md#existing-device-migration) for audit, backups and rollback.
