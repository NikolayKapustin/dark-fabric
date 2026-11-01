# Dark Fabric

A local, durable development orchestrator for **Codex CLI**. Give a project a goal; Dark Fabric researches, plans, implements in isolated Git worktrees, runs your checks, requests an independent review, and integrates accepted commits into a mission branch.

Runs on **Windows and macOS** with Node.js and Git. No Docker, database server, cloud account for Dark Fabric, or project-specific engine is required. Codex needs its own supported account and available quota. The operator interface is currently in Russian.

[Русская инструкция](README.ru.md) · [Configuration](docs/configuration.md) · [Operations](docs/operations.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md)

## Quick start

Install **Node.js 24 LTS**, **Git**, and the official [Codex CLI](https://developers.openai.com/codex/cli/). Node.js 22.16+ is the minimum; SQLite is bundled with Node; no compiler or Python is needed. Follow Codex's installation instructions for your OS, then run `codex login` in your terminal.

Clone this repository and open a terminal in its directory. The same commands work in PowerShell and macOS Terminal:

```sh
npm run setup
npm run up
```

Open **http://127.0.0.1:4317**. Setup installs locked dependencies, initializes an empty local state, and checks Git, SQLite, Codex login and the app-server protocol. It does not register projects or start work. It never reads or copies Codex authentication files.

To stop, including the optional remote bridge:

```sh
npm run down
```

The stop command waits for process exit. It preserves the queue, results and worktrees. An explicit `npm run up` starts the service again. `npm run service:status` lists service process IDs.

For foreground development use `npm start` and Ctrl+C. A persisted operator stop is respected: use `npm run up` to explicitly restart after stopping.

## Localhost portal without execution

Run `npm ci`, then `npm run portal` and open **http://localhost:4317**. This mode does not need a Codex connection and never starts the executor or remote bridge. It preserves stop markers and queue pause. Settings, saved results, human answers and new project requests are available locally; quota readings may be stale.

Use **Проекты → Новый проект** to enter a name, goal and priority. The durable request is provisioned only after the executor starts. Lost responses and page reloads retain the same request ID. Existing repositories can still be registered with the CLI below.

The portal and executor share one ownership lock. If the factory is already running, use its existing portal. To execute queued work, close portal-only mode with Ctrl+C or `npm run down`, then explicitly run `npm run up`. Queue pause is preserved. Use `npm run portal -- --home "/absolute/state/path"` for another installation; set `port` in that installation's config.json to change the port. The server binds only to 127.0.0.1, not your LAN or a public address.

## Publish a private portal in OpenAI Sites

Open this repository in a Sites-enabled ChatGPT/Codex environment and tell the agent:

```text
$publish-dark-fabric Publish my private factory portal in OpenAI Sites with ChatGPT sign-in, connect this installation, and preserve any existing pause or stop.
```

The repository skill lives in [.agents/skills/publish-dark-fabric/SKILL.md](.agents/skills/publish-dark-fabric/SKILL.md). If the client does not discover repository skills, ask the agent to read that file and carry out the same request; `AGENTS.md` routes natural-language publication requests there as well. The skill requires the Sites plugin and account access; installing the repository does not grant hosting access.

The agent builds the hosted adapter from the included UI and protocol contract, publishes it privately, and configures the selected local bridge. The hosted server is generated for your installation; this is not a prebuilt cloud bundle or an npm deployment command. Execution stays on your computer. See [remote access](docs/remote-access.md) for prerequisites, retries and the stopped-factory behavior.

## Your first project

Use a Git repository with at least one commit and committed source changes:

```sh
node src/cli.js project add "/absolute/path/to/project" --name "My project"
```

Copy the returned project ID. npm projects with test/check scripts get these checks detected automatically; inspect them and pin critical regressions where appropriate:

```sh
node src/cli.js project checks PROJECT_ID examples/checks.node.json
node src/cli.js mission PROJECT_ID --goal-file examples/goal.txt
```

Replace PROJECT_ID with the actual ID; adapt the example commands to the project's real build and tests. A mission consumes Codex quota once the service is running. For a source directory without Git, use `project import`: it creates a separate snapshot without changing the original.

The integrated result lives in the mission worktree and branch shown by `status`. The original working copy is not overwritten, and nothing is pushed or deployed automatically.

## What you get

- Durable SQLite queue, human questions, retry history, token usage and account quota.
- Discovery and planning; dependency-aware work; fair scheduling across projects.
- One writer per project, isolated task worktrees and checkpoints.
- Host-owned quality commands, protected test hashes, separate Codex review.
- Replayable integration, crash recovery and automatic technical retries.
- Official quota polling and waiting, without account rotation or bypasses.
- Local browser console. Optional Sites bridge is a separate deployment; see [remote access](docs/remote-access.md).

New installations contain **no projects, personal URLs, credentials, full-access grants or existing work history**. Default execution access is `workspace`. Full host access requires the operator's explicit choice; checks and review remain mandatory.

## Documentation

| Guide | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | OS prerequisites, paths, first mission, troubleshooting |
| [Configuration](docs/configuration.md) | Every runtime setting, limits, access and state location |
| [Operations](docs/operations.md) | Pause/stop, login startup, backup/restore, upgrades |
| [Architecture](docs/architecture.md) | Modules, state transitions, concurrency and trust boundaries |
| [Remote access](docs/remote-access.md) | Optional connector and deployment contract |
| [Validation](docs/validation.md) | Automated coverage and platform evidence |
| [Security](SECURITY.md) | Sensitive data and reporting |
| [Contributing](CONTRIBUTING.md) | Development, tests, review and release rules |

```sh
npm test
npm run check
npm run release:check
```

Deterministic tests do not require Codex login or consume model quota. `npm run smoke` is a separate, **quota-consuming** live integration test; run it deliberately after changing the Codex version.

Dark Fabric is a single-user local tool for trusted projects, not a multi-tenant service or a sandbox for hostile code. Keep port 4317 bound to localhost.
