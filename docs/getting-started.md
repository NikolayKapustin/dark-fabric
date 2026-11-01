# Getting started

## Prerequisites

- Node.js 24 LTS recommended (minimum 22.16), with npm. Install a native version for your CPU.
- Git, available in the same terminal as Node.
- [Official Codex CLI](https://developers.openai.com/codex/cli/), logged in with `codex login`. Your account must have access to the models you use.
- Project-specific tools only when needed: e.g. a browser test runner, compiler, Godot or .NET.

On Windows use PowerShell. Node's Windows installer includes npm; if script execution blocks `npm.ps1`, run `npm.cmd`. Dark Fabric supports the native Codex executable and the official npm-installed Codex shim without enabling a shell. See [Windows Codex setup](https://developers.openai.com/codex/windows/).

On macOS use Terminal and the macOS builds of Node/Git/Codex. Git may require Apple's Command Line Tools (`xcode-select --install`). Keep native and Rosetta installations consistent. Dark Fabric uses Node’s built-in SQLite; installing npm dependencies does not require a native build toolchain.

Check `node --version`, `git --version`, `codex --version`, and `codex login status`.

## Install

Clone this GitHub repository, enter its directory and run:

```sh
npm run setup
npm run up
```

Setup uses `npm ci`, never floating dependency upgrades. It can be repeated after correcting a missing prerequisite. It does not clear a previous stop or pause. An exhausted but readable Codex quota is a valid connection; it does not make doctor fail.

The background launcher prints the resolved state directory and process IDs. Open http://127.0.0.1:4317 (or your configured port). No account for Dark Fabric or remote hosting is needed.

## First mission

Use `project add` for the root of a Git repository with at least one commit, or `project import` to snapshot a non-Git source folder. Quote paths containing spaces. Commit intended source changes first.

```sh
node src/cli.js project add "/absolute/path/to/project" --name "Example"
node src/cli.js project checks PROJECT_ID examples/checks.node.json
node src/cli.js mission PROJECT_ID "Add input validation with tests and documentation"
```

For Windows a path such as `D:/work/example` also works. PROJECT_ID is a placeholder. The example quality commands are for npm projects; use actual project commands for other stacks. At least one real quality command is required before implementation can be accepted. Add `protectedFiles` to pin existing regressions. Run quality commands manually once before delegating.

For longer goals use `--goal-file examples/goal.txt`. Add `--continuous` to reassess and work in bounded batches until the goal is met. This can consume many model turns; review your daily budget first.

Read questions in the console or with `questions`; answer with `answer ID "decision"`. A blocked task does not block unrelated projects.

## Find the result

`node src/cli.js status` reports mission workspace and branch. Accepted changes are fast-forwarded there after checks and review. Inspect them with Git, then explicitly merge or publish when you decide. Source imports are snapshots, not continuous synchronization.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Codex not found / cannot resolve | Install the official CLI, reopen the terminal, or set CODEX_BIN before init |
| Doctor reports login failure | Run codex login yourself; never copy credentials into this repository |
| app-server protocol fails | Inspect doctor output; use a compatible CLI and run the explicit live smoke after upgrades |
| node:sqlite is unavailable | Install Node 24 LTS (or at least 22.16); no third-party SQLite addon is needed |
| Port already in use | Stop the other instance or set a different port in config.json |
| Factory is stopped | Use npm run up to explicitly restart; resume alone only changes queue pause |
| Background start times out | Inspect supervisor/launcher.log and supervisor/supervisor.log in the state directory |
| Tasks wait on quota | Inspect observedAt, checkedAt and quotaPollMs; do not bypass account limits |
| Task is blocked | Read its question and provide the product decision |
| Node dependency errors after update | Stop, npm ci, test/check, then start explicitly |

A PID or existing SQLite file alone is not evidence of progress. Inspect fresh heartbeat, run completion, checkpoints and host verification results.
