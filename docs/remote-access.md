# Optional remote access

The local console works without a remote service. This repository includes a **Sites bridge client**, not a preconfigured hosted account or shared portal. Every operator must provision their own private portal and credentials separately. The former installation's portal, hosting IDs and source history are not part of this distribution.

## Contract

A compatible private Sites deployment exposes POST /api/bridge/sync over HTTPS. The client only accepts an HTTPS origin under .chatgpt.site, with no userinfo, path, query or fragment; redirects are rejected. This host restriction is retained.

Headers:
- Content-Type: application/json
- OAI-Sites-Authorization: Bearer serviceToken
- X-Dark-Fabric-Bridge: bridgeToken

Request: `{ snapshot, receipts }`. Snapshot is the bounded projection in src/remote.js; it includes project/task content, questions, usage and limited roadmap text, not authentication files or raw tool logs. Treat it as private project data.

Response: `{ commands: [], storedAt: 0 }`, where storedAt is server epoch milliseconds and commands contains at most 30 entries. Each command has `id` (16–80 alphanumeric/hyphen characters), `kind`, `payload`, `createdAt` (epoch ms). Supported kinds are answer, input, pause, project.create, project.update and project.discover. No shell command, trusted check, access-policy or budget update is accepted.

The server must enforce owner authentication, authorization and Origin, persist commands before acknowledging them, and remove/acknowledge them only after a matching receipt. Browser clients must never receive service credentials. Receipt status is applied or rejected; the local change and receipt commit in one SQLite transaction. Duplicate IDs with changed payload are rejected. Commands older than seven days are rejected.

## Configure

After separately deploying and reviewing a compatible portal, run:

```sh
node scripts/configure-remote.js "/absolute/path/to/state"
```

Enter a **single-line JSON** object with url, serviceToken and bridgeToken at its hidden input prompt; each token must contain at least 32 characters. Do not put secrets in command arguments or Git. The file is protected with owner permissions (and SYSTEM on Windows).

`npm run up` starts the bridge only when remote.json exists. `npm run down` stops both. The client uses outbound requests; no router port forwarding is required.

The bridge sends a heartbeat after each synchronization attempt, has bounded backoff and supervisor recovery. Disconnection does not block local work. A stopped factory does not apply queued remote commands. The remote page may retain its last snapshot after shutdown; it must show freshness rather than imply live progress.

Implementing or publishing a new hosted portal is a separate deployment task. Do not connect a fresh install to another operator's existing portal.
