# Security policy

## Supported versions

Latest release and default branch receive security fixes.

## Reporting

Do not open a public issue for an undisclosed vulnerability. Report privately through GitHub Security Advisories for this repository.

Include affected component, reproduction steps, impact, and proposed mitigation when known.

## Security boundary

Control plane trusts processes running as same operating-system user. Unix socket permissions prevent cross-user access but do not isolate hostile same-user processes.

Installer runs with `umask 077`. Backup directories use mode `0700`; MCP configuration backups, repository archives, and copied extension backups use mode `0600` because they may contain credentials or private local configuration.

Custom installation paths are canonicalized before download or mutation. Installer rejects filesystem root, home/config ancestors, locations inside `OMP_HOME`, symlink installation roots, existing directories without expected package identity, and MCP configuration paths inside installation root.

Security-sensitive changes include network listeners, process spawning, generic shell execution, raw PTY injection, broader filesystem access, weaker registry/socket permissions, or accepting stale PID/record identity without live socket response. These changes require explicit security review.
