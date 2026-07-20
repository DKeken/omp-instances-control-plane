# OMP Instances Control Plane

Local orchestration for multiple [Oh My Pi](https://omp.sh/) processes and VS Code-compatible windows.

Repository contains three cooperating parts:

- **OMP extension** registers each live OMP process, status, model, session, and owning terminal.
- **MCP server** exposes instance and window operations as `omp_instances_*` tools.
- **VS Code / VSCodium extension** owns terminal tabs, shows fleet and recovery views, and runs local memory watchdog.

All control traffic uses user-only Unix sockets. No TCP listener, browser endpoint, CORS bridge, arbitrary editor command endpoint, or PTY text injection exists.

## Capabilities

### OMP instances

| MCP tool | Purpose |
| --- | --- |
| `list` | List live instances, status, model, session, cwd, and ownership. |
| `inspect` | Resolve target by alias, PID, UUID, session, or terminal identity. |
| `send` / `broadcast` | Deliver user messages to idle or busy OMP processes. |
| `ask` / `reply` | Correlated request/reply between OMP processes. |
| `rename` | Assign stable human-readable alias. |
| `interrupt` / `shutdown` | Abort turn or stop process gracefully. |
| `restart` | Resume persisted session in its terminal identity. |

### Editor windows

| MCP tool | Purpose |
| --- | --- |
| `list_windows` | List windows, workspaces, editor tabs, terminal tabs, and attached OMP instances. |
| `open_window` | Open workspace and wait for extension registration. |
| `create_omp` / `launch_team` | Start one OMP tab or team of independent tabs. |
| `resume_omp` | Resume persisted OMP JSONL session. |
| `focus` | Reveal owning terminal tab. |
| `reload_window` | Save files and reload registered editor window. |
| `show_dashboard` | Reveal Fleet and Health & Recovery views. |
| `doctor` | Report or repair stale artifacts and unsafe permissions. |
| `watchdog_status` | Read supervisor heartbeat and aggregate process-tree memory. |

## Requirements

- macOS or Linux. Control transport uses Unix domain sockets.
- [Bun](https://bun.sh/) 1.3 or newer.
- [Oh My Pi](https://omp.sh/) with extension and MCP support.
- VS Code or VSCodium 1.126+ for window/terminal orchestration. Instance-only MCP operation does not require editor extension.

## Install

### 1. Clone and install

```sh
git clone https://github.com/DKeken/omp-instances-control-plane.git
cd omp-instances-control-plane
bun install
```

### 2. Install OMP extension

Build self-contained extension, then link or copy generated file into OMP extension directory. Generated bundle has no repository-relative runtime imports.

```sh
bun run build:omp-extension
ln -s "$PWD/dist/omp-control.js" ~/.omp/agent/extensions/omp-control.js
```

Copying works too:

```sh
cp dist/omp-control.js ~/.omp/agent/extensions/omp-control.js
```

### 3. Configure MCP

Merge server entry into OMP MCP configuration. Replace absolute paths:

```json
{
  "mcpServers": {
    "omp-instances": {
      "type": "stdio",
      "command": "/absolute/path/to/bun",
      "args": [
        "/absolute/path/omp-instances-control-plane/packages/mcp-server/src/server.ts"
      ],
      "cwd": "/absolute/path/omp-instances-control-plane/packages/mcp-server",
      "timeout": 180000
    }
  }
}
```

Configuration root can differ between MCP hosts. Merge entry; do not overwrite unrelated servers.

### 4. Install editor extension

```sh
bun run package
```

Install generated `.vsix` using editor UI or CLI:

```sh
codium --install-extension packages/vscode-extension/omp-instances-orchestrator-1.0.0.vsix
# or
code --install-extension packages/vscode-extension/omp-instances-orchestrator-1.0.0.vsix
```

Reload editor window. Fleet view appears in Activity Bar.

## Configuration

### Shared control directory

Default: `/tmp/omp-control-<uid>`.

Set `OMP_CONTROL_DIR` for every OMP process, MCP server, and editor extension host when custom location is required. Socket paths must remain short; Unix socket path length is platform-limited.

### Editor settings

Extension contributes `ompOrchestrator.*` settings for executable path, default working directory, watchdog enablement, recovery policy, memory limit, breach samples, and polling interval. Memory limit is constrained to 5-10 GiB.

## Architecture

```mermaid
flowchart LR
  O[OMP extension] -->|0600 instance record + Unix socket| R[(0700 local registry)]
  M[MCP server] --> R
  V[VS Code extension] -->|0600 window record + Unix socket| R
  S[Detached watchdog] --> R
  M -->|typed requests| O
  M -->|window and terminal requests| V
  S -->|staged recovery| O
  S -->|reload or reopen| V
```

Registry records are discovery metadata, not authority. Each operation contacts target socket and revalidates live process identity before action.

## Security model

- Registry directories use mode `0700`; records and sockets use `0600`.
- No network listener. Access remains local to same OS user.
- Message and frame sizes are bounded.
- Stale PIDs are never trusted alone. Socket response and process liveness are checked.
- `doctor` with `fix: true` only repairs permissions and removes stale artifacts. It does not kill live processes.
- Editor extension exposes fixed typed actions only. It has no general file, shell, editor-command, clipboard, or HTTP control API.

Threat boundary: another process running as same OS user can access user-owned sockets and files. Project does not provide hostile same-user isolation.

## Recovery behavior

Default watchdog policy: 8 GiB aggregate descendant RSS, three consecutive breaches, 15-second sampling.

1. OMP breach: interrupt, graceful shutdown, hard kill only if hung, resume persisted session.
2. Editor breach: save and reload window first.
3. Repeated editor breach: reopen app/workspaces and resume persisted OMP sessions.

No `sessionFile` means no safe resume. Recovery reports failure rather than inventing state.

## Development

```sh
bun install
bun run build:omp-extension
bun run check
bun run package
```

Source packages:

- `packages/mcp-server`: Bun TypeScript MCP server and shared protocol.
- `packages/omp-extension`: modular OMP runtime extension source.
- `dist/omp-control.js`: generated self-contained OMP extension.
- `packages/vscode-extension`: CommonJS editor extension and watchdog.
- `skills/omp-orchestration`: optional operator reference; copy it into your OMP skills directory when wanted.

## Troubleshooting

- **No instances:** confirm OMP extension loaded and all processes share `OMP_CONTROL_DIR`.
- **Instances but no windows:** editor extension is absent, disabled, or window has not reloaded.
- **Ambiguous target:** use full instance/window UUID returned by list tools.
- **Permission mismatch:** run MCP `doctor` with `fix: true`.
- **Cannot open editor:** set `OMP_VSCODE_CLI` or editor setting to valid `code` / `codium` binary.
- **Socket path too long:** use shorter `OMP_CONTROL_DIR`, such as `/tmp/oc`.

## License

No open-source license has been granted yet. All rights reserved.
