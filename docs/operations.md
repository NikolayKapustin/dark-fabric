# Operations

## Pause, stop and restart

`pause` prevents new stages; active stages may finish. `resume` removes that queue pause. Neither starts a stopped process.

`npm run down` writes durable stop markers, requests orderly shutdown, waits for service/supervisor/bridge exit and preserves work. If the deadline expires, it fails with the remaining PIDs; inspect logs before starting any replacement. Never remove live workspace locks.

`npm run up` is an explicit restart and clears stop markers. It does not clear a queue pause. Duplicate background starts reuse the existing supervisor. A separate foreground instance is rejected.

Supervisors restart failed workers with bounded backoff and a heartbeat watchdog. Replacement starts only after the previous child exits. A computer that is asleep, powered off or logged out cannot make progress.

## Start after login

Optional Windows logon registration:

```powershell
./scripts/Install-Autostart.ps1
./scripts/Uninstall-Autostart.ps1
```

The per-user task (or Startup shortcut fallback) uses `-RespectStop`: a prior operator stop is not cleared on login. Installation does not change Codex privileges. For a custom home pass the same `-StatePath`.

On macOS the supported simple background workflow is `npm run up` after login. Automatic launchd registration is not installed by this release. For managed environments a LaunchAgent can invoke the supervisor with an absolute Node path and `--home`; it must preserve the stop marker. Do not combine multiple login managers for the same home.

## Backup and restore

```sh
node src/cli.js backup "/absolute/path/to/backup.sqlite"
npm run down
```

The backup command uses SQLite's consistent backup API. For full recovery, while stopped copy the complete state directory **and registered source repositories** to protected storage. It includes Git metadata/worktrees, reports and logs. Do not copy only an open SQLite main file and omit its WAL.

Restore on the same filesystem layout, while all related processes are stopped. Git worktree metadata and database paths are absolute: moving to another machine or OS requires deliberate path/worktree repair. Portable installation means a fresh install on either OS; it does not promise transparent migration of live project worktrees. For a clean cross-machine start clone accepted source commits and register a new project.

Backups contain source code, prompts, local paths and control tokens. Never publish them. Each machine logs into Codex independently through the official CLI.

## Upgrade

1. Stop and verify exit.
2. Make a complete stopped backup.
3. Update the application checkout; keep runtime state outside Git.
4. Run npm ci, npm test and npm run check.
5. Run doctor. If Codex changed, deliberately run the quota-consuming live smoke.
6. Start explicitly and verify fresh heartbeat and actual next stage.

Database initialization includes migrations. Keep the previous application version and backup together; do not assume an older version can read a migrated database.

## Logs and incidents

| Path/key | Purpose |
| --- | --- |
| factory.sqlite | Durable queue, questions, runs, quota, usage and metadata |
| workspaces/mission-* | Integrated output |
| workspaces/task-* | Partial and checkpointed task work |
| logs/RUN_ID.jsonl | Bounded raw Codex events |
| reports/ | Structured model results |
| supervisor/supervisor.log | Main worker and restart log |
| supervisor/launcher.log | Background launcher diagnostics |
| remote-supervisor/ | Optional bridge logs |
| stop / remote.stop | Persisted operator stop |
| meta heartbeat | Freshness, process owner and active tasks |
| meta quota | observedAt, checkedAt, blocked, until and errors |

Repeated failures retain recent history and require diagnosis with a changed approach. They do not permit weakening quality checks. With no available Codex quota, already-local verification and integration can still proceed. A failed quota read does not prove a limit reset.

## Local API

The console serves the token only to the trusted local browser. Protected API calls use X-Dark-Fabric-Token. Host and Origin checks remain enabled.

GET /api/state; POST /api/missions, /api/answers, /api/pause, /api/checks. POST /api/projects queues a new project with id, name, goal and priority; identical IDs replay the same request, changed payloads conflict. POST /api/projects/update changes project pause/priority. Existing repository registration and scripts remain available via CLI. API bodies are validated server-side. Never expose the local console through a public bind address or an unauthenticated tunnel.

## Portal-only operation

`npm run portal` owns service.lock but never creates an executor heartbeat, recovers stages or calls Codex. The UI labels saved state explicitly. `npm run down` also writes portal.stop and waits for portal exit. The original stop / remote.stop and queue pause are not cleared by portal startup. Close the portal before explicitly starting the factory. A running supervisor or bridge prevents portal-only startup. Binding errors release ownership so a corrected port can be retried.
