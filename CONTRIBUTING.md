# Contributing

## Setup

```sh
bun install
bun run check
```

Use Bun only. Keep MCP methods and socket actions typed and size-bounded.

## Design constraints

- Keep one canonical protocol owner in `packages/mcp-server/src/protocol.ts`.
- Keep control transport on user-only Unix sockets.
- Do not add HTTP listeners, permissive CORS, generic command execution, file APIs, clipboard APIs, process spawning, or raw PTY injection.
- Treat registry JSON as discovery metadata. Revalidate process liveness and socket identity before control actions.
- Keep runtime extension and MCP server protocol-compatible in same change.
- Update both `README.md` and `README.ru.md` when public tools, settings, or installation steps change.

## Pull requests

Describe observable behavior, protocol/security impact, compatibility implications, and exact verification performed. Keep unrelated refactors separate.
