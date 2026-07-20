# Contributing

## Setup

```sh
bun install
bun run check
```

Use Bun only. Keep MCP methods and socket actions typed and bounded.

## Design constraints

- Keep control transport on user-only Unix sockets.
- Do not add HTTP listeners, permissive CORS, generic command execution, file APIs, clipboard APIs, or raw PTY injection.
- Treat registry JSON as discovery metadata. Revalidate PID and socket identity before control actions.
- Preserve graceful shutdown and persisted-session recovery before any hard process termination.
- Update README when public tools, settings, or installation steps change.

## Pull requests

Describe observable behavior, security impact, and exact verification performed. Keep unrelated refactors separate.
