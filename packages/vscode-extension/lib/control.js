"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const MAX_FRAME_BYTES = 256_000;
const uid = typeof process.getuid === "function" ? process.getuid() : "user";
const CONTROL_ROOT = process.env.OMP_CONTROL_DIR
  ? path.resolve(process.env.OMP_CONTROL_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join("/tmp", `omp-control-${uid}`);
const INSTANCE_DIR = path.join(CONTROL_ROOT, "instances");
const WINDOW_DIR = path.join(CONTROL_ROOT, "windows");
const WINDOW_SOCKET_DIR = path.join(CONTROL_ROOT, "window-sockets");
const SUPERVISOR_FILE = path.join(CONTROL_ROOT, "supervisor.json");
const SUPERVISOR_EVENT_FILE = path.join(CONTROL_ROOT, "supervisor-events.jsonl");

async function ensureDirectories() {
  await fs.mkdir(INSTANCE_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(WINDOW_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(WINDOW_SOCKET_DIR, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.chmod(CONTROL_ROOT, 0o700),
    fs.chmod(INSTANCE_DIR, 0o700),
    fs.chmod(WINDOW_DIR, 0o700),
    fs.chmod(WINDOW_SOCKET_DIR, 0o700),
  ]);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

async function readRecords(directory, validate) {
  await ensureDirectories();
  const names = await fs.readdir(directory);
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (validate(record)) records.push(record);
    } catch {
      // Concurrent atomic replacement or stale/corrupt record. Next heartbeat repairs it.
    }
  }
  return records;
}

function validInstance(record) {
  return Boolean(
    record &&
      record.protocolVersion === 1 &&
      typeof record.instanceId === "string" &&
      typeof record.alias === "string" &&
      Number.isInteger(record.pid) &&
      typeof record.socketPath === "string" &&
      typeof record.updatedAt === "string",
  );
}

function validWindow(record) {
  return Boolean(
    record &&
      record.protocolVersion === 1 &&
      typeof record.windowId === "string" &&
      typeof record.socketPath === "string" &&
      Number.isInteger(record.pid) &&
      Number.isInteger(record.appPid) &&
      typeof record.label === "string" &&
      Array.isArray(record.workspaceFolders) &&
      Array.isArray(record.terminals) &&
      Array.isArray(record.editorTabs) &&
      record.watchdog,
  );
}

async function readInstances({ includeStale = false } = {}) {
  const records = await readRecords(INSTANCE_DIR, validInstance);
  const live = [];
  for (const record of records) {
    if (!processAlive(record.pid)) {
      await fs.rm(path.join(INSTANCE_DIR, `${record.instanceId}.json`), { force: true });
      await fs.rm(record.socketPath, { force: true });
      continue;
    }
    if (includeStale || Date.now() - Date.parse(record.updatedAt) < 30_000) live.push(record);
  }
  return live.sort((left, right) => left.alias.localeCompare(right.alias) || left.pid - right.pid);
}

async function readWindows({ includeStale = false } = {}) {
  const records = await readRecords(WINDOW_DIR, validWindow);
  const live = [];
  for (const record of records) {
    if (!processAlive(record.pid)) {
      await fs.rm(path.join(WINDOW_DIR, `${record.windowId}.json`), { force: true });
      await fs.rm(record.socketPath, { force: true });
      continue;
    }
    if (includeStale || Date.now() - Date.parse(record.updatedAt) < 30_000) live.push(record);
  }
  return live.sort((left, right) => left.label.localeCompare(right.label) || left.windowId.localeCompare(right.windowId));
}

async function writeWindowRecord(record) {
  await ensureDirectories();
  const target = path.join(WINDOW_DIR, `${record.windowId}.json`);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

async function removeWindowArtifacts(windowId, socketPath) {
  await fs.rm(path.join(WINDOW_DIR, `${windowId}.json`), { force: true });
  await fs.rm(socketPath, { force: true });
}

function requestSocket(socketPath, request, timeoutMs = 3_000) {
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return Promise.reject(new Error("Control request exceeds 256 KB limit"));
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = net.createConnection(socketPath);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`Timed out contacting ${socketPath}`))), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        finish(() => reject(new Error("Control response exceeds 256 KB limit")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) finish(() => reject(new Error(response.error || "Control request failed")));
        else finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (!settled) finish(() => reject(new Error(`Empty response from ${socketPath}`)));
    });
  });
}

async function readSupervisorState() {
  try {
    const state = JSON.parse(await fs.readFile(SUPERVISOR_FILE, "utf8"));
    return state && Number.isInteger(state.pid) && typeof state.updatedAt === "string" ? state : undefined;
  } catch {
    return undefined;
  }
}

async function readSupervisorEvents(limit = 20) {
  try {
    const handle = await fs.open(SUPERVISOR_EVENT_FILE, "r");
    try {
      const size = (await handle.stat()).size;
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

async function registryMode() {
  try {
    return (await fs.stat(CONTROL_ROOT)).mode & 0o777;
  } catch {
    return undefined;
  }
}

module.exports = {
  CONTROL_ROOT,
  INSTANCE_DIR,
  MAX_FRAME_BYTES,
  SUPERVISOR_FILE,
  SUPERVISOR_EVENT_FILE,
  WINDOW_DIR,
  WINDOW_SOCKET_DIR,
  ensureDirectories,
  processAlive,
  readInstances,
  readWindows,
  removeWindowArtifacts,
  readSupervisorEvents,
  readSupervisorState,
  registryMode,
  requestSocket,
  writeWindowRecord,
};
