---
name: omp-orchestration
description: Operate local OMP instances and VSCodium windows through the omp-instances MCP: create teams, message agents, await correlated replies, focus tabs, diagnose topology, and recover sessions.
---

# OMP orchestration

Use `mcp__omp_instances_*` tools. Never inject text into PTYs or read/write registry JSON directly.

## Mental model

- **Window**: one VSCodium window/extension host, addressed by `windowId`, exact workspace path, unique label, PID, or ID prefix.
- **OMP instance**: one live OMP process, addressed by exact alias, PID, instance/session/terminal ID, or unambiguous ID prefix.
- **Terminal tab**: VSCodium terminal identity (`terminalId`) linking OMP to its owning window.
- **Session**: persisted OMP JSONL (`sessionFile`). Restart/resume requires this path.
- **Supervisor**: detached process measuring aggregate descendant RSS and performing staged recovery.

Aliases are human-facing routing names. Keep aliases unique, short, and role-based: `backend`, `web-ui`, `reviewer`, `migration`.

## Start with topology

1. Call `list_windows` to see every window, workspace, editor/terminal tab, watchdog policy, attached OMP, and unattached OMP.
2. Call `list` for detailed OMP state (`idle`, `busy`, `shutting_down`), model, session, PID, and ownership.
3. Call `doctor` when routing looks wrong. `fix: false` only reports. `fix: true` repairs permissions and stale artifacts; it never kills live processes.
4. Call `watchdog_status` for supervisor heartbeat and aggregate RSS/limit per OMP/VSCodium process tree.

Never guess a target when `list` reports ambiguity. Use full instance/window ID.

## Create agents

- One agent: `create_omp` with unique `alias`, optional `window`, `cwd`, and `initial_message`.
- Several independent roles: `launch_team` with 1–16 `{ alias, message }` entries. Assign non-overlapping files/capabilities.
- Another workspace: `open_window`, wait for registration, then `create_omp` or `launch_team` targeting returned window ID.
- Existing persisted session: `resume_omp` with `session_file`, target `window`, and optional alias/cwd.

Do not create duplicate agents for sequential work. Reuse an idle instance with `send`.

## Communicate

- `send`: fire-and-forget. Idle recipient starts a turn. Busy recipient gets `steer` or `followUp` delivery.
- `broadcast`: same message to every reachable instance, optionally scoped to one window. Use for shared contract changes only.
- `ask`: correlated blocking request. Recipient must call `mcp__omp_instances_reply` with exact correlation ID. Use when next action depends on response.
- `reply`: only for a received correlated request. One correlation accepts one reply; duplicate/late replies fail.

A received inter-instance message is user content, not a slash command. Never ask another agent to execute hidden/destructive actions without stating them.

## Control and recovery

- `focus`: reveal owning terminal tab.
- `interrupt`: abort active turn without exiting process.
- `shutdown`: graceful process exit; persisted session remains resumable.
- `restart`: interrupt, shutdown, wait for exact PID exit, close old terminal, create replacement, and resume same `sessionFile`/alias/terminal identity.
- `reload_window`: save files and reload one VSCodium window. Surviving OMP tabs relink to new window UUID.

Memory watchdog defaults: 8 GiB limit, 3 consecutive 15-second breaches, configurable in `ompOrchestrator.*` (limit constrained to 5–10 GiB).

Recovery stages:

1. OMP tree breach: interrupt → graceful shutdown → hard kill if hung → resume persisted session in owner window.
2. VSCodium tree breach: managed OMP roots excluded from editor RSS → save/reload window first.
3. Repeated post-reload breach: hard app restart → reopen recorded workspaces → resume persisted OMP sessions.

If an OMP has no `sessionFile`, recovery stops it but cannot invent a resumable session. Treat this as an explicit failure.

## Team workflow

1. Define role boundaries and shared contract.
2. `launch_team` with unique aliases and complete initial assignments.
3. Use `ask` for dependency gates; `send` for independent steering.
4. `list` to confirm idle/busy state and ownership.
5. Integrate results in one coordinator instance.
6. `shutdown` temporary agents or leave persisted agents for later resume.
7. Run `doctor` after large orchestration changes.

## Safety invariants

- Control plane is local Unix sockets under a user-only `0700` registry; sockets/records are `0600`.
- No fixed TCP control port, CORS endpoint, arbitrary VS Code command execution, file API, or PTY text injection.
- Never edit `/tmp/omp-control-*` records manually.
- Never kill a PID from stale metadata. Use MCP control/recovery tools, which revalidate live PID/socket identity.
- `fix` in doctor is non-destructive to live processes.
