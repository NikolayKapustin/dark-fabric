# Hosted portal contract

Read this when implementing or updating the hosted adapter. The checked-out factory code is authoritative for protocol details: `src/remote.js`, `src/projects.js`, `src/inputs.js`, `src/store.js`, and `test/remote.test.js`. Paths in this reference are relative to the factory repository root. Do not extend the host's command allowlist to make a portal control work.

## Runtime and identity

The hosted component is a Sites server application with durable D1 storage, not the Node executor. It must not run Git, Codex, shell commands or local SQLite migrations. Use the installed Sites starter/build/source workflow; no hand-written deployment endpoint or bundled cloud account.

There are two different principals:

- Browser: Sites-authenticated visitor, authorized for this private portal. Reject missing or unauthorized identity on data and mutation routes. Never trust an email, user ID or owner flag sent in a JSON body. Identity headers are trusted only behind the Sites platform boundary. Local preview identity must use isolated fixtures and must not ship as an authentication fallback.
- Bridge: Sites platform service access plus a separate application bridge secret. It is not a signed-in browser visitor and cannot enqueue arbitrary user commands. Missing/wrong bridge secrets fail closed; an absent environment variable must not match an absent header.

Read the installed Sites identity/secrets reference for current helpers and supported service access. Keep authentication checks server-side; private API responses use `Cache-Control: no-store`. Require same-origin browser mutation requests (including Origin validation), reject cross-origin writes, and avoid wildcard CORS. Render project text as text, never executable HTML. Do not add public write routes to simplify a background client.

## Bridge endpoint

`POST /api/bridge/sync` must accept the existing client's request:

```text
Content-Type: application/json
OAI-Sites-Authorization: Bearer <Site service credential>
X-Dark-Fabric-Bridge: <application bridge secret>
```

The Sites dispatch layer consumes/validates the service credential. The application validates its own bridge secret; do not require browser identity on this service route. The client accepts only an HTTPS origin under `.chatgpt.site` and rejects redirects. Preserve that restriction.

Also expose `GET /api/bridge/health` with the same two layers of service authentication. Return only `{ok: true}` on success, with no-store caching. This endpoint must not write to D1, replace a snapshot, read/deliver pending commands, or accept receipts. It exists for safe production credential checks; there is no read-only mode of `/api/bridge/sync`.

Body: `{snapshot, receipts}`. The response is `{commands, storedAt}`, with a maximum of 30 pending command envelopes and server epoch milliseconds in `storedAt`. Keep the exact key names; do not wrap them in an additional `data` object.

Persist the bounded snapshot and matching acknowledgments transactionally before reporting success. Use a separate durable command table so snapshot replacement cannot erase pending user actions. Preserve pending commands until a matching receipt arrives; sending them once is not an acknowledgment. Return pending commands in a stable order and retry them unchanged after lost responses or restarts. Expiration may mark a command as expired, but must remain visible rather than pretending it was applied.

Bound request size, object depth and stored values. Size the snapshot storage for the current `remoteSnapshot()` projection (which compacts toward 1,100,000 UTF-8 bytes); do not truncate IDs, timestamps or command payloads. Store large snapshot sections/chunks in D1 within the platform's current value/row limits, with one transactional snapshot version and atomic read reconstruction. Do not assume that one unbounded JSON row or an in-memory variable is durable storage.

## Command envelopes and receipts

Each command has `{id, kind, payload, createdAt}`. Use UUIDs for IDs: the general host validator allows 16–80 alphanumeric/hyphen characters, while project creation requires a UUID-shaped ID. `createdAt` is server epoch milliseconds; the host rejects timestamps over five minutes in the future or over seven days old.

| kind | payload | Behavior |
| --- | --- | --- |
| `answer` | `{id, answer}` | Answer an existing human question. Validate against the current question/choice rules. |
| `input` | `{missionId, body}` | Add mission input; the envelope ID is the durable input ID. |
| `pause` | `{paused: boolean}` | Set the queue pause. It does not start a stopped process or clear stop markers. |
| `project.create` | `{name, goal, priority}` | Name up to 100 characters, goal up to 12000, priority integer 1–5. Provisioning happens in the local executor later. |
| `project.update` | `{id, priority?, paused?}` | Existing project; priority 1–5, paused boolean, at least one change. |
| `project.discover` | `{id}` | Queue discovery for an existing project. |

Validate browser command inputs with strict per-kind schemas, including unknown fields. Derive allowed project, mission and question references from the current authorized snapshot. Never accept shell commands, local paths for repository import, arbitrary settings, trusted checks, execution access or budget changes through this queue.

Client-side submission must preserve one immutable envelope ID/payload across a lost response and page reload. Persist a pending draft before sending. Server-side duplicate ID plus identical content returns the original record; changed content returns conflict, without overwriting or enqueuing again. Do not regenerate IDs on network retry. Preserve JSON payload field order in the saved envelope because the existing receipt fingerprint hashes the JSON serialization.

Receipts are `{id, fingerprint, status, message, at}` where status is `applied` or `rejected`. The host fingerprint is lowercase SHA-256 of UTF-8 `JSON.stringify([command.kind, command.payload])`. Match both ID and fingerprint to the original stored command before marking it terminal. A duplicate receipt is harmless; a conflicting, unknown or mismatched receipt must not delete another pending command. Keep rejected messages visible. A bridge response means delivery; only a matching `applied` receipt means application.

The local bridge commits host effects and their receipts together and refuses to apply commands if the executor heartbeat is missing, stopped or stale. Preserve this behavior. Keep one local factory connection per portal; the current protocol does not identify independent installations or isolate their queues. Reusing a portal on another computer requires a verified migration of the same durable IDs and host receipts as well as stopping the old executor/bridge. A new empty database must not receive the old queue: lost acknowledgments could cause duplicate effects or destructive rejection of valid pending work.

## Snapshot and operator UI

Adapt `public/` to a hosted read endpoint plus a durable command-submission endpoint; do not copy localhost token bootstrapping or mutate the local database from the Site.

Use the actual `remoteSnapshot()` fields, including `projects`, `missions`, `tasks`, `questions`, `inputs`, `intakes`, `activity`, `taskCounts`, `events`, `runs`, `usage`, `quota`, `quotaReserve`, `settings`, `heartbeat`, `paused`, and `generatedAt`. Handle an empty installation and a portal that has never synchronized. Do not fill missing data with invented projects, progress or quota.

Show both snapshot receipt time and executor heartbeat age. Distinguish running, quota waiting, paused, explicitly stopped and disconnected/stale. Do not call an old quota snapshot current; display `observedAt`, `checkedAt` and freshness relative to `quotaPollMs`. The portal does not poll the Codex account itself or restart execution when quota appears available.

Show full totals separately from bounded lists. Honor `excerpt`, `compact` and omitted-node indicators; the cloud projection is not the full local history. Settings and token-analysis summaries may be shown, but editing settings is local-only until the host explicitly supports a corresponding remote command. Hide/disable unsupported controls with a useful local-settings hint.

## Required observable checks

Test the generated server against an isolated synthetic fixture using this version's `RemoteBridge` / `applyRemoteCommand` where possible. Isolate both the local store and the hosted backend/storage: use a local/mock/test server, never the live portal endpoint or its D1. A temporary local store alone does not protect the live queue or snapshot. Do not use real project data or a running task worktree.

- Anonymous and unauthorized browser access fails; wrong/missing bridge credentials fail; bridge service access does not grant command-submission access. Foreign-Origin browser writes fail.
- Repeated authenticated `/api/bridge/health` requests leave snapshot, commands and receipts unchanged; anonymous requests reveal no private state.
- First sync stores a snapshot; an empty portal renders correctly; quota/heartbeat timestamps remain visible when stale or stopped. A near-limit UTF-8 snapshot survives storage and reload without corrupting identifiers.
- Enqueue, sync, receipt and browser reload display the actual pending/applied/rejected lifecycle. A restart retains pending commands and the latest complete snapshot.
- Lost submit response, duplicate submit, changed-payload conflict, lost sync response, repeated receipt, mismatched fingerprint and expired command do not duplicate effects or silently drop unrelated pending work.
- A transaction failure cannot commit a partial snapshot or erase the queue. Concurrent sync/submission preserves a command submitted during the update.
- A stopped/stale executor applies no commands. Test this with a synthetic paused/stopped store; do not resume the operator's installation to satisfy a test.
- Build/source artifacts contain no real credentials, machine paths, old Site identities, project data or local databases. Inspect the final hosted bundle for server secrets accidentally included in client assets.

Verify hosted visitor behavior after deployment when browser access is available. If signed-out or other-user testing is unavailable, report that specific verification limit; never fabricate a second identity or claim an access test that did not run.
