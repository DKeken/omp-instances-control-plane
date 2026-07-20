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

log "installing locked dependencies"
(
  cd "$TMP_ROOT/source"
  bun install --frozen-lockfile
)


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
INSTALL_STAMP="$(date +%Y%m%d%H%M%S)"
for extension_path in "$OMP_HOME/extensions/omp-control.ts" "$OMP_HOME/extensions/omp-control.js"; do
  if [ -e "$extension_path" ] || [ -L "$extension_path" ]; then
    extension_name="$(basename "$extension_path")"
    if [ -L "$extension_path" ]; then
      readlink "$extension_path" > "$OMP_HOME/backups/$extension_name.$INSTALL_STAMP.symlink.bak" || true
    else
      cp "$extension_path" "$OMP_HOME/backups/$extension_name.$INSTALL_STAMP.bak"
    fi
    rm -f "$extension_path"
  fi
done
EXTENSION_TARGET="$OMP_HOME/extensions/omp-control.ts"
EXTENSION_TEMP="$OMP_HOME/extensions/.omp-control.ts.$$.tmp"
ln -s "$INSTALL_ROOT/packages/omp-extension/omp-control.ts" "$EXTENSION_TEMP"
mv "$EXTENSION_TEMP" "$EXTENSION_TARGET"

mkdir -p "$(dirname "$MCP_CONFIG")"
if [ -e "$MCP_CONFIG" ]; then
  MCP_BACKUP="$OMP_HOME/backups/mcp.json.$INSTALL_STAMP.bak"
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

log "installation complete"
printf '%s\n' "Restart OMP processes to activate instance orchestration."
printf '%s\n' "Installed at: $INSTALL_ROOT"
printf '%s\n' "MCP config:   $MCP_CONFIG"
