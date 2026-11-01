# Security

Dark Fabric operates on trusted local repositories. It can execute operator-defined quality commands and, when explicitly configured, give Codex full host access. It is not a safe execution boundary for hostile projects.

The console binds to 127.0.0.1 and checks Host, Origin and an operator token. Do not expose it directly to the internet. Keep optional portal access private and separately authenticated.

Never commit state directories, database backups, operator tokens, remote connection files, .env files, logs or source snapshots from private projects. Codex credentials remain managed by the official CLI. Dark Fabric must not read or copy them.

For a vulnerability, use GitHub's private vulnerability reporting if enabled, or contact the repository maintainer privately. Do not place secrets or exploit details in public issues before coordination.

There is no automatic external publication, deployment, purchasing or messaging. Approval of a mission is not blanket approval for these actions.
