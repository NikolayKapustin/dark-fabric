# Contributing

Use Node 24 LTS and npm ci. Keep changes in an isolated Git branch/worktree; never edit an active task workspace from a second writer.

Run npm test, npm run check and npm run release:check. Add meaningful failure/recovery regressions for lifecycle, scheduler, database, process, protocol and Git changes. The CI matrix must remain enabled. Run quota-consuming live smoke explicitly when changing the app-server adapter.

Preserve existing assertions and quality pins. Fix the cause of a failure rather than loosening a threshold or resetting evidence. Changes to the orchestrator require independent review before release. Describe the problem, resulting behavior, validation and remaining limits in the PR.

Keep installation neutral: no personal names, account URLs, absolute machine paths, deployment IDs, runtime databases, credentials or product-specific branches. Examples must be synthetic. Do not copy Codex authentication files.

Release from a reviewed commit. Include only tracked application source, docs, examples and tests. Inspect the complete Git history before first publication; local development history may contain installation data even when the current tree does not. Use a fresh sanitized root commit when necessary, preserving private history locally.

The npm package is marked private: GitHub publication does not authorize publishing to the npm registry.
