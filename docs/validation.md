# Validation

## Reproducible checks

```sh
npm ci
npm test
npm run check
npm run release:check
```

Tests use temporary databases, local processes, synthetic protocol fixtures and Git repositories. They require no Codex account, hosting credentials or model quota.

Coverage includes transactional recovery, fair scheduling, human blocks, retry history, quota polling/reset behavior, immutable QA pins, independent review contracts, replayable Git integration, orphan process cleanup, hostile local HTTP requests, bridge replay receipts, cumulative usage accounting and project profiles.

Distribution regressions additionally cover native/npm-shim command resolution, argument preservation, prerequisite diagnostics, timezone migration, built-in SQLite transactions/backup, background/foreground lifecycle, duplicate start, durable operator stop and generic roadmap provenance/containment.

## Platform evidence

The GitHub Actions matrix runs the same tests and syntax/release checks on Windows, macOS and Linux, using Node 22 and 24. A configured matrix is not itself evidence of a successful run: check the actual Actions results for the commit you install.

On Windows, all 118 deterministic tests passed on both Node 22.16.0 and Node 24.13.0. A clean npm ci installed only six JavaScript packages without a compiler. A consistent private copy of the prior database was opened with the built-in SQLite adapter: projects, missions, tasks, runs, questions and events retained identical logical hashes and integrity_check returned ok. This private compatibility fixture is not distributed. Native macOS execution must be confirmed by its CI job; Windows results do not prove macOS runtime behavior. Model/GUI behavior on another OS also requires deliberate live testing.

## Live Codex check

`npm run smoke` creates an isolated tiny repository with a deliberately broken function, asks Codex to fix it, runs the protected regression, requests a separate review and integrates the result. **This consumes real account quota.** It is excluded from CI.

Doctor reads official login status and account/rateLimits/read without reading credentials. A successful doctor confirms connection/protocol, not model task completion.

Do not reinterpret planned work, generated documents, passing synthetic tests or old quota snapshots as delivered product behavior.

## Distribution verification — 2026-11-01

A clean export successfully ran npm run setup (including official Codex login/protocol diagnostics), npm run up, authenticated console state retrieval and npm run down on Windows. The fresh state contained zero projects and zero tasks. The explicit live Codex smoke completed implement → verify → independent review → integrate with its original test pinned and no open questions. This evidence does not substitute for macOS CI.
