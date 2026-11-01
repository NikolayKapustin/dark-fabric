# Configuration

All CLI commands accept `--home PATH` before the subcommand. State resolution is: explicit `--home`, then `DARK_FABRIC_HOME`, then `.darkfabric` in the current directory. npm commands run in the repository root.

```sh
node src/cli.js --home "/absolute/path/to/state" init
node scripts/service.js start --home "/absolute/path/to/state"
node scripts/service.js stop --home "/absolute/path/to/state"
```

Use the same absolute state path for every command. Each installation needs its own state directory and port. Do not share a live state directory between machines.

`init` creates config.json, SQLite and a local operator token. Edit config.json while stopped, then restart. CODEX_BIN supplies the initial codexPath default; an existing config takes precedence.

| Setting | Default | Meaning |
| --- | --- | --- |
| port | 4317 | Localhost console, 1–65535 |
| codexPath | codex / CODEX_BIN | Native executable or supported official npm shim |
| model | null | Automatic selection from official model/list; explicit value pins a model |
| workers | 1 | Concurrent slots, maximum 8; one writer per project still applies |
| pollMs | 3000 | Scheduler interval, ms |
| turnTimeoutMs | 1800000 | Model stage timeout |
| rpcTimeoutMs | 30000 | Individual app-server RPC timeout |
| retryBaseMs | 30000 | Initial technical retry delay |
| maxAttempts | 4 | Ordinary attempt limit before recovery policy |
| maxRepairCycles | 4 | Ordinary repair limit before recovery policy |
| dailyTurnLimit | 100 | Model turns per UTC day, including retries |
| quotaPollMs | 300000 | Official account quota polling interval |
| quotaReservePercent | 10 | Pause Codex at or below this remaining percentage in either account window; 0 disables the reserve, maximum 99 |
| tokenAnalysisEnabled | true | Periodic session-usage reports and bounded optimization tasks |
| tokenAnalysisIntervalHours | 24 | Analysis cadence, integer hours from 1 to 168 |
| unknownQuotaBackoffMs | 900000 | Backoff for quota errors without reset time |
| maxPlanTasks | 40 | Maximum tasks in a plan |
| maxImprovementTasks | 3 | Maximum tasks in a retrospective |
| retrospectiveEvery | 5 | Delivery interval for retrospectives |
| networkAccess | true | Network in the configured Codex sandbox |
| autoIntegrate | true | Integrate accepted commits into mission branch |
| autoImprove | true | Generate bounded, reviewed project improvement tasks |
| executionAccess | workspace | workspace sandbox or explicitly authorized full host access |
| technicalRecovery | true | Diagnose/retry technical faults without turning them into product decisions |

Numeric values must be positive safe integers, except quotaReservePercent which also accepts zero. Boolean flags must be JSON booleans. Model routing prefers suitable available models by stage and complexity; unavailable preferences fall back to the visible default catalog entry. It never switches accounts. Full access is not granted by a project document or an agent result.

## Resource settings in the console

Open **Настройки** in the local console to edit the quota reserve, enable periodic analysis, or change its interval. These three settings are stored transactionally in SQLite and override their config.json defaults across restarts. They take effect on the next scheduler tick without restarting. No other host policy can be changed through this endpoint.

At 10% remaining or less in either official quota window, the factory stops starting Codex turns and requests interruption of active turns. Partial work and session IDs remain available for replay, without consuming retry attempts. Local verification and integration may continue. This is a quota wait, not an operator stop: the service keeps polling account/rateLimits/read. A reset timestamp alone, a failed read, or incomplete telemetry cannot release a confirmed reserve wait. A complete official response above the threshold permits work again; an operator pause or stop still takes precedence. Account usage is shared and telemetry arrives with delay, so this cannot guarantee an exact 10% balance at interruption.

The first analysis runs on the next active scheduler tick, then every configured interval. Each pass summarizes at most 100 previously unanalyzed completed model runs with usage telemetry. It records totals, cache share, costly sessions and unsuccessful runs without sending raw logs to a model. Paused projects and unfinished runs wait for a later pass. Missing telemetry is not treated as zero usage or as evidence of savings.

For each active mission with new evidence, the report queues one read-only analysis stage. It may propose at most one project workflow/harness optimization with comparable before/after evidence. Proposed changes go through ordinary implementation, pinned checks and independent review, under the same quota reserve and daily turn limit. Analysis and improvement runs do not trigger more analysis of themselves. Completed missions receive a local report only. Disabling periodic analysis prevents new reports/tasks; existing queued tasks are retained. Reports and task results appear under **Настройки**.

## Quality commands

```json
[
  {
    "name": "Regression",
    "command": ["node", "--test", "test/regression.test.js"],
    "timeoutMs": 300000,
    "protectedFiles": ["test/regression.test.js"]
  }
]
```

Commands are argument arrays executed on the host without shell concatenation. Use a native executable path or the supported npm command. A Windows-only PowerShell check remains Windows-only; cross-platform factory support does not port your project's tools.

protectedFiles hashes are pinned when the operator installs the checks. Changes require an operator decision; agents cannot repin them to pass. A review failure returns work to implementation and reruns all host checks.

## Roadmaps and time

Every project uses the same roadmap: reviewed discovery milestones plus headings from ROADMAP.md, docs/roadmap.md and STATUS.md, and the live task queue. Markdown is treated as text. Only these files are read, with real-path containment, byte and node limits. Documentation statements never mark a task delivered.

New installations aggregate token days in UTC, matching the daily turn budget. The zone is returned in usage.timeZone and displayed in the console. Upgrades preserve the zone of historical daily buckets instead of silently relabeling them.

## Local portal

`npm run portal` selects the portal-only launch mode; `npm run up` selects the executor plus local portal (and an optional configured bridge). Both use `port` (default 4317) and bind only to `127.0.0.1`; `http://localhost:4317` is accepted. Launch mode is explicit rather than a persisted switch that could unexpectedly resume work. Resource settings remain editable in portal-only mode; quota polling and periodic analysis resume only with the executor.
