#!/bin/sh
set -eu

REPOSITORY="DKeken/omp-instances-control-plane"
REF="${OMP_INSTANCES_REF:-main}"
INSTALL_ROOT="${OMP_INSTANCES_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-instances-control-plane}"
OMP_HOME="${OMP_HOME:-$HOME/.omp/agent}"
MCP_CONFIG="${OMP_MCP_CONFIG:-$OMP_HOME/mcp.json}"
ARCHIVE_URL="https://github.com/$REPOSITORY/archive/refs/heads/$REF.tar.gz"

log() {
  printf '%s\n' "[omp-instances] $*"
}

fail() {
  printf '%s\n' "[omp-instances] error: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v bun >/dev/null 2>&1 || fail "Bun 1.3+ is required: https://bun.sh/docs/installation"
command -v omp >/dev/null 2>&1 || fail "Oh My Pi must be installed first: https://omp.sh/"

BUN_BIN="$(command -v bun)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/omp-instances-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

log "downloading $REPOSITORY@$REF"
curl -fsSL "$ARCHIVE_URL" -o "$TMP_ROOT/source.tar.gz"
mkdir -p "$TMP_ROOT/source"
tar -xzf "$TMP_ROOT/source.tar.gz" -C "$TMP_ROOT/source" --strip-components=1

log "installing dependencies"
(
  cd "$TMP_ROOT/source"
  bun install --frozen-lockfile
)

EDITOR_CLI=""
if command -v codium >/dev/null 2>&1; then
  EDITOR_CLI="$(command -v codium)"
elif command -v code >/dev/null 2>&1; then
  EDITOR_CLI="$(command -v code)"
fi

log "building OMP extension"
(
  cd "$TMP_ROOT/source"
  bun run build:omp-extension
)

if [ -n "$EDITOR_CLI" ]; then
  log "packaging editor extension"
  (
    cd "$TMP_ROOT/source"
    bun run --cwd packages/vscode-extension package
  )
fi

mkdir -p "$(dirname "$INSTALL_ROOT")"
PREVIOUS_ROOT=""
if [ -e "$INSTALL_ROOT" ]; then
  PREVIOUS_ROOT="$INSTALL_ROOT.previous.$(date +%Y%m%d%H%M%S)"
  mv "$INSTALL_ROOT" "$PREVIOUS_ROOT"
fi
if ! mv "$TMP_ROOT/source" "$INSTALL_ROOT"; then
  if [ -n "$PREVIOUS_ROOT" ] && [ -e "$PREVIOUS_ROOT" ]; then
    mv "$PREVIOUS_ROOT" "$INSTALL_ROOT"
  fi
  fail "could not activate installation"
fi
rm -rf "$PREVIOUS_ROOT"

mkdir -p "$OMP_HOME/extensions" "$OMP_HOME/backups"
EXTENSION_TARGET="$OMP_HOME/extensions/omp-control.js"
if [ -e "$EXTENSION_TARGET" ]; then
  cp "$EXTENSION_TARGET" "$OMP_HOME/backups/omp-control.js.$(date +%Y%m%d%H%M%S).bak"
fi
cp "$INSTALL_ROOT/dist/omp-control.js" "$EXTENSION_TARGET"
chmod 600 "$EXTENSION_TARGET"

mkdir -p "$(dirname "$MCP_CONFIG")"
if [ -e "$MCP_CONFIG" ]; then
  MCP_BACKUP="$OMP_HOME/backups/mcp.json.$(date +%Y%m%d%H%M%S).bak"
  cp "$MCP_CONFIG" "$MCP_BACKUP"
  log "backed up MCP config to $MCP_BACKUP"
else
  printf '%s\n' '{"mcpServers":{}}' > "$MCP_CONFIG"
  chmod 600 "$MCP_CONFIG"
fi

MERGE_SCRIPT="$TMP_ROOT/merge-mcp.js"
cat > "$MERGE_SCRIPT" <<'MERGE'

const [configPath, bunPath, installRoot] = process.argv.slice(2);
const source = await Bun.file(configPath).text();
let config;
try {
  config = JSON.parse(source);
} catch (error) {
  throw new Error(`Cannot parse ${configPath}: ${error.message}`);
}
if (!config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error(`${configPath} must contain a JSON object`);
}
if (config.mcpServers === undefined) config.mcpServers = {};
if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
  throw new Error(`${configPath}#mcpServers must contain a JSON object`);
}
config.mcpServers["omp-instances"] = {
  type: "stdio",
  command: bunPath,
  args: [`${installRoot}/packages/mcp-server/src/server.ts`],
  cwd: `${installRoot}/packages/mcp-server`,
  timeout: 180000,
};
const temporary = `${configPath}.${process.pid}.tmp`;
await Bun.write(temporary, `${JSON.stringify(config, null, 2)}\n`);
await Bun.$`chmod 600 ${temporary}`;
await Bun.$`mv ${temporary} ${configPath}`;
MERGE

log "merging omp-instances into MCP configuration"
bun "$MERGE_SCRIPT" "$MCP_CONFIG" "$BUN_BIN" "$INSTALL_ROOT"

if [ -n "$EDITOR_CLI" ]; then
  VSIX="$INSTALL_ROOT/packages/vscode-extension/omp-instances-orchestrator-1.0.0.vsix"
  log "installing editor extension with $EDITOR_CLI"
  "$EDITOR_CLI" --install-extension "$VSIX" --force
else
  log "code/codium not found; skipped optional editor extension"
fi

log "installation complete"
printf '%s\n' "Restart OMP and reload editor windows to activate the control plane."
printf '%s\n' "Installed at: $INSTALL_ROOT"
printf '%s\n' "MCP config:   $MCP_CONFIG"
