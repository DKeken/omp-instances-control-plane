#!/bin/sh
set -eu
umask 077

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
PATH_VALIDATOR="$TMP_ROOT/validate-paths.js"
cat > "$PATH_VALIDATOR" <<'VALIDATE'
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

async function metadata(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function canonicalize(candidate) {
  const absolute = path.resolve(candidate.replace(/^~(?=$|\/)/, homedir()));
  const suffix = [];
  let ancestor = absolute;
  let current = await metadata(ancestor);
  while (!current) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve existing ancestor for ${absolute}`);
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
    current = await metadata(ancestor);
  }
  if (!current.isDirectory()) throw new Error(`Existing ancestor is not a directory: ${ancestor}`);
  return path.join(await realpath(ancestor), ...suffix);
}

const [rawInstallRoot, rawOmpHome, rawMcpConfig] = process.argv.slice(2);
const rawInstallAbsolute = path.resolve(rawInstallRoot.replace(/^~(?=$|\/)/, homedir()));
const rawInstallMetadata = await metadata(rawInstallAbsolute);
if (rawInstallMetadata?.isSymbolicLink()) {
  throw new Error(`Existing installation root cannot be a symlink: ${rawInstallAbsolute}`);
}

const [installRoot, ompHome, mcpConfig, home] = await Promise.all([
  canonicalize(rawInstallRoot),
  canonicalize(rawOmpHome),
  canonicalize(rawMcpConfig),
  realpath(homedir()),
]);
const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

if (installRoot === path.parse(installRoot).root) throw new Error("Installation root cannot be filesystem root");
if (contains(installRoot, home)) throw new Error("Installation root cannot be HOME or its ancestor");
if (contains(installRoot, ompHome)) throw new Error("Installation root cannot be OMP_HOME or its ancestor");
if (contains(ompHome, installRoot)) throw new Error("Installation root cannot be inside OMP_HOME");
if (contains(installRoot, mcpConfig)) throw new Error("MCP config cannot be inside installation root");

const target = await metadata(installRoot);
if (target) {
  if (!target.isDirectory()) throw new Error(`Existing installation root is not a directory: ${installRoot}`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(installRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`Existing directory is not an OMP Instances installation: ${installRoot} (${error.message})`);
  }
  if (manifest?.name !== "omp-instances-control-plane") {
    throw new Error(`Existing directory has unexpected package identity: ${installRoot}`);
  }
}

process.stdout.write(`${installRoot}\n${ompHome}\n${mcpConfig}\n`);
VALIDATE

VALIDATED_PATHS="$(bun "$PATH_VALIDATOR" "$INSTALL_ROOT" "$OMP_HOME" "$MCP_CONFIG")" || fail "unsafe installation path"
INSTALL_ROOT="$(printf '%s\n' "$VALIDATED_PATHS" | sed -n '1p')"
OMP_HOME="$(printf '%s\n' "$VALIDATED_PATHS" | sed -n '2p')"
MCP_CONFIG="$(printf '%s\n' "$VALIDATED_PATHS" | sed -n '3p')"
log "validated installation root: $INSTALL_ROOT"
INSTALL_STAMP="$(date +%Y%m%d%H%M%S)"
PREVIOUS_ROOT=""
ACTIVATING=0
HAD_MCP_CONFIG=0
HAD_TS_EXTENSION=0
HAD_JS_EXTENSION=0
EXTENSION_BACKUP_DIR="$OMP_HOME/backups/omp-control.$INSTALL_STAMP"
MCP_BACKUP="$OMP_HOME/backups/mcp.json.$INSTALL_STAMP.bak"
ROOT_BACKUP="$OMP_HOME/backups/omp-instances-control-plane.$INSTALL_STAMP.tar.gz"

rollback() {
  status=$?
  if [ "$ACTIVATING" -eq 1 ]; then
    printf '%s\n' "[omp-instances] activation failed; restoring previous installation" >&2
    rm -rf "$INSTALL_ROOT"
    if [ -n "$PREVIOUS_ROOT" ] && [ -e "$PREVIOUS_ROOT" ]; then
      mv "$PREVIOUS_ROOT" "$INSTALL_ROOT"
    fi

    rm -f "$OMP_HOME/extensions/omp-control.ts" "$OMP_HOME/extensions/omp-control.js"
    if [ "$HAD_TS_EXTENSION" -eq 1 ]; then
      cp -P "$EXTENSION_BACKUP_DIR/omp-control.ts" "$OMP_HOME/extensions/omp-control.ts"
    fi
    if [ "$HAD_JS_EXTENSION" -eq 1 ]; then
      cp -P "$EXTENSION_BACKUP_DIR/omp-control.js" "$OMP_HOME/extensions/omp-control.js"
    fi

    if [ "$HAD_MCP_CONFIG" -eq 1 ]; then
      cp "$MCP_BACKUP" "$MCP_CONFIG"
      chmod 600 "$MCP_CONFIG"
    else
      rm -f "$MCP_CONFIG"
    fi
  fi
  rm -rf "$TMP_ROOT"
  exit "$status"
}
trap rollback EXIT HUP INT TERM

log "downloading $REPOSITORY@$REF"
curl -fsSL "$ARCHIVE_URL" -o "$TMP_ROOT/source.tar.gz"
mkdir -p "$TMP_ROOT/source"
tar -xzf "$TMP_ROOT/source.tar.gz" -C "$TMP_ROOT/source" --strip-components=1

log "installing locked dependencies"
(
  cd "$TMP_ROOT/source"
  bun install --frozen-lockfile
)

mkdir -p "$OMP_HOME/extensions" "$OMP_HOME/backups" "$(dirname "$MCP_CONFIG")" "$(dirname "$INSTALL_ROOT")"
chmod 700 "$OMP_HOME/backups"

if [ -e "$MCP_CONFIG" ]; then
  HAD_MCP_CONFIG=1
  cp "$MCP_CONFIG" "$MCP_BACKUP"
  chmod 600 "$MCP_BACKUP"
else
  printf '%s\n' '{"mcpServers":{}}' > "$TMP_ROOT/mcp.original.json"
fi

MCP_SOURCE="$TMP_ROOT/mcp.original.json"
if [ "$HAD_MCP_CONFIG" -eq 1 ]; then
  MCP_SOURCE="$MCP_BACKUP"
fi

MERGE_SCRIPT="$TMP_ROOT/merge-mcp.js"
cat > "$MERGE_SCRIPT" <<'MERGE'
const [sourcePath, outputPath, bunPath, installRoot] = process.argv.slice(2);
const source = await Bun.file(sourcePath).text();
let config;
try {
  config = JSON.parse(source);
} catch (error) {
  throw new Error(`Cannot parse ${sourcePath}: ${error.message}`);
}
if (!config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error(`${sourcePath} must contain a JSON object`);
}
if (config.mcpServers === undefined) config.mcpServers = {};
if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
  throw new Error(`${sourcePath}#mcpServers must contain a JSON object`);
}
config.mcpServers["omp-instances"] = {
  type: "stdio",
  command: bunPath,
  args: [`${installRoot}/packages/mcp-server/src/server.ts`],
  cwd: `${installRoot}/packages/mcp-server`,
  timeout: 180000,
};
await Bun.write(outputPath, `${JSON.stringify(config, null, 2)}\n`);
MERGE

log "validating and staging MCP configuration"
bun "$MERGE_SCRIPT" "$MCP_SOURCE" "$TMP_ROOT/mcp.merged.json" "$BUN_BIN" "$INSTALL_ROOT"
chmod 600 "$TMP_ROOT/mcp.merged.json"

mkdir -p "$EXTENSION_BACKUP_DIR"
chmod 700 "$EXTENSION_BACKUP_DIR"
if [ -e "$OMP_HOME/extensions/omp-control.ts" ] || [ -L "$OMP_HOME/extensions/omp-control.ts" ]; then
  HAD_TS_EXTENSION=1
  cp -P "$OMP_HOME/extensions/omp-control.ts" "$EXTENSION_BACKUP_DIR/omp-control.ts"
  if [ ! -L "$EXTENSION_BACKUP_DIR/omp-control.ts" ]; then
    chmod 600 "$EXTENSION_BACKUP_DIR/omp-control.ts"
  fi
fi
if [ -e "$OMP_HOME/extensions/omp-control.js" ] || [ -L "$OMP_HOME/extensions/omp-control.js" ]; then
  HAD_JS_EXTENSION=1
  cp -P "$OMP_HOME/extensions/omp-control.js" "$EXTENSION_BACKUP_DIR/omp-control.js"
  if [ ! -L "$EXTENSION_BACKUP_DIR/omp-control.js" ]; then
    chmod 600 "$EXTENSION_BACKUP_DIR/omp-control.js"
  fi
fi
if [ "$HAD_TS_EXTENSION" -eq 0 ] && [ "$HAD_JS_EXTENSION" -eq 0 ]; then
  rmdir "$EXTENSION_BACKUP_DIR"
fi

if [ -e "$INSTALL_ROOT" ]; then
  log "archiving previous installation to $ROOT_BACKUP"
  tar -czf "$ROOT_BACKUP" -C "$(dirname "$INSTALL_ROOT")" "$(basename "$INSTALL_ROOT")"
  chmod 600 "$ROOT_BACKUP"
fi

log "activating installation"
ACTIVATING=1
if [ -e "$INSTALL_ROOT" ]; then
  PREVIOUS_ROOT="$INSTALL_ROOT.previous.$INSTALL_STAMP"
  mv "$INSTALL_ROOT" "$PREVIOUS_ROOT"
fi
mv "$TMP_ROOT/source" "$INSTALL_ROOT"

rm -f "$OMP_HOME/extensions/omp-control.ts" "$OMP_HOME/extensions/omp-control.js"
EXTENSION_TEMP="$OMP_HOME/extensions/.omp-control.ts.$$.tmp"
ln -s "$INSTALL_ROOT/packages/omp-extension/omp-control.ts" "$EXTENSION_TEMP"
mv "$EXTENSION_TEMP" "$OMP_HOME/extensions/omp-control.ts"

MCP_TEMP="$MCP_CONFIG.$$.tmp"
cp "$TMP_ROOT/mcp.merged.json" "$MCP_TEMP"
chmod 600 "$MCP_TEMP"
mv "$MCP_TEMP" "$MCP_CONFIG"

ACTIVATING=0
rm -rf "$PREVIOUS_ROOT"
trap - EXIT HUP INT TERM
rm -rf "$TMP_ROOT"

log "installation complete"
printf '%s\n' "Restart OMP processes to activate instance orchestration."
printf '%s\n' "Installed at: $INSTALL_ROOT"
printf '%s\n' "MCP config:   $MCP_CONFIG"
if [ -e "$ROOT_BACKUP" ]; then
  printf '%s\n' "Previous installation: $ROOT_BACKUP"
fi
