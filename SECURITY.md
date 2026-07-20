# Security policy

## Supported versions

Latest release and default branch receive security fixes.

## Reporting

Do not open a public issue for an undisclosed vulnerability. Report privately through GitHub Security Advisories for this repository.

Include affected component, reproduction steps, impact, and proposed mitigation when known.

## Security boundary

Control plane trusts processes running as same operating-system user. Unix socket permissions prevent cross-user access but do not isolate hostile same-user processes.

Changes that add network listeners, generic shell/editor execution, raw PTY injection, or broader filesystem access require explicit security review.
