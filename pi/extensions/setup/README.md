# Pi Setup Commands

Package entry points for safe setup and migration:

- `/pi-setup-init` queues the bundled `pi-setup` skill's audit/proposal prompt.
- `/pi-setup-doctor` queues a strictly read-only health audit.

Neither command installs packages, edits settings, copies files, or removes legacy resources directly. The skill must present numbered proposals and wait for explicit approval before any mutation.
