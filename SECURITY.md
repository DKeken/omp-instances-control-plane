# Security policy

## Supported versions

Latest release and default branch receive security fixes.

## Reporting

Do not open a public issue for an undisclosed vulnerability. Report privately through GitHub Security Advisories for this repository.

Include affected component, reproduction steps, impact, and proposed mitigation when known.

## Security boundary

Control plane trusts processes running as same operating-system user. Unix socket permissions prevent cross-user access but do not isolate hostile same-user processes.

Security-sensitive changes include network listeners, process spawning, generic shell execution, raw PTY injection, broader filesystem access, weaker registry/socket permissions, or accepting stale PID/record identity without live socket response. These changes require explicit security review.
