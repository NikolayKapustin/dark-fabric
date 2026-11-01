# Optional remote access

The local console works without a remote service. This repository includes a **Sites bridge client**, not a preconfigured hosted account or shared portal. Every operator must provision their own private portal and credentials separately. The former installation's portal, hosting IDs and source history are not part of this distribution.

## Agent-assisted publication

The repository includes [$publish-dark-fabric](../.agents/skills/publish-dark-fabric/SKILL.md). In a ChatGPT/Codex environment with the Sites plugin, open this checkout and request:

```text
$publish-dark-fabric Publish a private portal for this installation with ChatGPT sign-in, connect the bridge, and preserve any user stop or pause.
```

The skill is explicitly invoked; there is no Git hook, install hook or automatic publication on startup. A natural-language publication request is routed by `AGENTS.md`; agents without skill discovery can read the linked file directly. The installed Sites plugin supplies the current hosting/authentication workflow. No Sites tools or account access means the agent can prepare local source, but cannot claim to publish it.

The skill includes a [hosted adapter contract](../.agents/skills/publish-dark-fabric/references/portal-contract.md). It instructs the agent to build the server and queue, adapt the existing UI, test identity/recovery, publish through native Sites tools, and securely configure the existing bridge helper. There is no prebuilt hosted server in the distribution. Per-installation source normally lives in ignored `sites/dark-fabric-portal/`, with its own Sites repository and `.openai/hosting.json`; it is not committed to the public factory repository. Non-secret retry progress belongs in the selected state's `sites-publication.json`.

New portals start owner-private. Browser access uses ChatGPT identity; the background bridge uses separate service credentials. Keep one factory per portal. Reusing a portal on another computer requires an intentional, verified migration of the same durable state, IDs, receipts and usable worktrees, after the old executor and bridge stop. Stopping the old bridge alone does not make it safe to connect a fresh database to its pending queue. The skill does not automate cross-machine state migration. A new independent installation gets a new portal.

Publication preserves pause and stop markers. If execution is stopped, the result is a published portal and saved connection settings; live synchronization remains deferred until the operator authorizes startup. Configuring a connection does not authorize a real task or an automatic resume.

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

## Local portal option

Use `npm run portal` for a standalone localhost portal without a bridge or hosted service. The ordinary `npm run up` already includes this interface alongside the executor. Portal-only mode preserves operator stops and does not synchronize or consume remote commands. See [getting started](getting-started.md#optional-portal-only-mode).
