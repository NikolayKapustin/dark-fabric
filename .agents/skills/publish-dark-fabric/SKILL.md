---
name: publish-dark-fabric
description: Create or update a private Dark Fabric portal in OpenAI Sites with ChatGPT sign-in, and connect the selected local installation through its existing bridge. Use for an explicit request to publish the factory portal; not for GitHub publishing, localhost startup, or routine monitoring.
---

# Publish the Dark Fabric portal

Deliver a working private `https://…chatgpt.site` portal for this installation. The executor, repositories, Codex login and task worktrees stay on the operator's computer. The hosted portal stores a bounded snapshot and a durable command queue.

This repository supplies the local UI and bridge, not a prebuilt hosted server. Build the compatible hosted adapter described below when it is absent. Do not claim that `npm run up`, cloning the repository, or installing this skill deploys a Site.

## Scope and prerequisites

- An explicit request such as “Publish my factory portal with ChatGPT sign-in” authorizes that publication and connection to the selected installation. A request to explain, prepare without deployment, or edit this skill does not authorize publication.
- Use the available Sites plugin and its current `sites` skill, including its identity/secrets, storage, source preparation and deployment guidance. Discover the installed skill/tool names; do not assume another computer has this machine's plugin paths or versions. If Sites is unavailable, finish any useful local preparation and explain that the operator must enable Sites in their ChatGPT/Codex environment. Do not invent a Sites CLI, scrape browser cookies or substitute an unrelated hosting provider.
- Read the repository's `AGENTS.md`, [remote access](../../../docs/remote-access.md), [portal contract](references/portal-contract.md), and the current `src/remote.js`. Resolve repository-relative paths from the Git root.
- Identify the actual local state directory: explicit `--home`, then `DARK_FABRIC_HOME`, otherwise this checkout's `.darkfabric`. Read only relevant configuration, process ownership and pause/stop state. Do not open Codex authentication files.
- Preserve user pauses and `stop` / `remote.stop` markers. Publication does not authorize starting the executor, consuming queued commands, or changing execution access, limits, trusted checks or budgets.

## Select the Site and source checkout

Use a separate hosted-source checkout, normally the ignored `sites/dark-fabric-portal/` directory. Do not build inside an active task worktree or upload the factory repository/runtime wholesale. Keep the factory and Site Git remotes separate.

For a new installation with no selected Site, create a new owner-private Site using the native Sites workflow. For an update, first read the hosted checkout's `.openai/hosting.json` and resolve its exact `project_id` with `get_site`. Confirm account, ownership, URL and current audience. Use the source workflow from the installed Sites skill to open missing source.

If only a configured `remote.json` or an explicit Site URL is available, resolve the exact Site through native discovery before creating anything. Never infer an ID from a URL, copy a previous operator's Site identity, or replace a configured portal just because its source checkout is absent.

A new computer must not share one command queue with another active factory. Reusing a Site during a requested migration requires a normal stop of the old executor and bridge, verified process exit, and verified transfer of the same durable installation state, including IDs, remote receipts, project data and usable worktrees/paths. A stopped old bridge alone is insufficient: a fresh database could apply an unacknowledged command again. This skill does not supply a cross-machine state/worktree migration tool. If state migration is incomplete, leave the old connection inactive and report that prerequisite; do not attach a fresh store to its queue, discard pending commands, or copy Codex authentication files. A new independent factory should use its own new private Site when that is the user's intent.

Persist non-secret progress in the selected state's `sites-publication.json`: source checkout, project ID, URL, source commit, saved version/deployment IDs and last completed step, as those values become available. Preserve it across failures. Reconcile an uncertain create/save/deploy result before retrying; do not create duplicate Sites or rotate credentials as a connectivity test.

This workflow targets an owner-private portal. Preserve an existing Site's audience. If it is public or shared more broadly, do not upload local project data under the private-owner assumption; resolve the intended access and per-user authorization with the operator first.

## Build the hosted portal

Use the current Sites server-capable starter and D1 for snapshots, command envelopes and receipts. Follow [portal contract](references/portal-contract.md) for the hosted API, authorization, replay semantics and acceptance checks. Adapt the current `public/` UI to that API; localhost handlers and the local operator token are not a hosted authentication scheme.

Provide project/task views, human questions and answers, mission inputs, project creation/priority/pause/discovery, factory pause, usage/quota and a clear synchronization timestamp. Show pending/applied/rejected commands. Render disconnected or intentionally stopped factories honestly; the Site staying online does not imply that execution is running. Resource settings unsupported by the current bridge remain read-only with a local-settings explanation.

Use Sites-provided ChatGPT identity for browser access and server-side authorization. Follow the installed identity helper for sign-in/sign-out; do not build a separate password flow or register fake OAuth endpoints. The factory's local `codex login` is separate from portal visitor authentication.

Keep all Site identity, database contents, snapshots, service credentials and generated deployment artifacts out of the distributable factory Git history. The hosted checkout's own manifest belongs to its separate Sites source repository, as required by Sites. Never seed a new portal with another operator's projects, emails, saved snapshots or deployment archives.

## Validate and publish

Run the hosted project's checks and the contract's failure/recovery tests using synthetic data before publication. If factory source changes are needed, implement them in an isolated worktree, add relevant regressions, obtain independent review, and run `npm test`, `npm run check`, and `npm run release:check`; keep trusted pins intact.

Package/push the exact hosted source and deploy through the installed Sites workflow. Reuse saved version/deployment IDs on retry and wait for the native terminal deployment result. Start private and retain private access. A GitHub push, successful build or allocated URL alone is not a deployed portal.

## Connect the selected installation

Only after a successful private deployment and access checks:

1. Obtain that Site's supported service credential through native Sites tools. Generate a separate random bridge secret (at least 32 random bytes) for a new connection and configure its hosted value through the native environment-secret tool. Reuse a valid existing pair for an unchanged connection; coordinate any required rotation on both ends.
2. Prepare `{url, serviceToken, bridgeToken}` using the returned Site origin and matching secrets. Keep secret values in memory; never print them, embed them in shell arguments, source, browser code, reports or chat. Send the JSON through hidden stdin to `node scripts/configure-remote.js "ABSOLUTE_STATE_DIRECTORY"`. This helper writes the protected `remote.json`; do not replace it with a plaintext shell redirect.
3. Preserve an existing working connection until the new endpoint has passed checks. Do not replace its configuration while a bridge is using it. If a live service needs a restart, use the normal `npm run down -- --home "ABSOLUTE_STATE_DIRECTORY"` lifecycle and verify old PIDs have exited; never kill unrelated Node/Codex processes. Restart only if it was running before this maintenance, the task permits it, and no intervening user stop was received. A pre-existing user stop stays in place.
4. Verify hosted sign-in, rejection of unauthenticated/unauthorized calls, and bridge credential acceptance without sending browser credentials. Use the contract's read-only `GET /api/bridge/health` for production credential checks; it must not store snapshots or deliver/acknowledge commands. For a legacy portal lacking that endpoint, add and test it in the hosted source before checking, or report the credential check as deferred. Synthetic round trips must isolate both ends: a temporary local store and a local/mock/test hosted backend with its own storage. Never point a fixture's `RemoteBridge.sync()` at the production Site: even a temporary local database can overwrite its snapshot or acknowledge real commands. Never call production `RemoteBridge.sync()` as a supposedly read-only probe either.
5. If the factory remains stopped, report “portal published; connection configured; executor remains stopped” and identify live synchronization as deferred. Do not clear stop markers for a smoke test. If execution is already authorized to run, use the normal single-owner lifecycle, then confirm a fresh `remote.status` and matching hosted snapshot timestamp without injecting test tasks or decisions into real projects.

If connection setup fails after deployment, preserve the Site and the previous working local configuration, and report the remaining step. Do not report the factory as synchronized until verified.

Return the literal deployed URL, current audience, local connection state, and whether the executor is running or intentionally stopped. Never include credentials. For a prepare-only request, return the local source and remaining publication steps instead.
