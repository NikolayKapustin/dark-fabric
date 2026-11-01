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
| unknownQuotaBackoffMs | 900000 | Backoff for quota errors without reset time |
| maxPlanTasks | 40 | Maximum tasks in a plan |
| maxImprovementTasks | 3 | Maximum tasks in a retrospective |
| retrospectiveEvery | 5 | Delivery interval for retrospectives |
| networkAccess | true | Network in the configured Codex sandbox |
| autoIntegrate | true | Integrate accepted commits into mission branch |
| autoImprove | true | Generate bounded, reviewed project improvement tasks |
| executionAccess | workspace | workspace sandbox or explicitly authorized full host access |
| technicalRecovery | true | Diagnose/retry technical faults without turning them into product decisions |

Numeric values must be positive safe integers. Boolean flags must be JSON booleans. Model routing prefers suitable available models by stage and complexity; unavailable preferences fall back to the visible default catalog entry. It never switches accounts. Full access is not granted by a project document or an agent result.

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
