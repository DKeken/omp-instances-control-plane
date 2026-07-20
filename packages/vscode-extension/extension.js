"use strict";

const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const vscode = require("vscode");
const {
  CONTROL_ROOT,
  MAX_FRAME_BYTES,
  SUPERVISOR_EVENT_FILE,
  SUPERVISOR_FILE,
  WINDOW_SOCKET_DIR,
  ensureDirectories,
  processAlive,
  readInstances,
  readSupervisorEvents,
  readSupervisorState,
  readWindows,
  registryMode,
  removeWindowArtifacts,
  requestSocket,
  writeWindowRecord,
} = require("./lib/control.js");
const { restartAndResumeInstance } = require("./lib/recovery.js");

const WINDOW_PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 2_000;
const WINDOW_ID = crypto.randomUUID();
const SOCKET_PATH = path.join(WINDOW_SOCKET_DIR, `${WINDOW_ID}.sock`);
const STARTED_AT = new Date().toISOString();
const terminalsById = new Map();
const adoptedTerminalIds = new Map();
let controlServer;
let heartbeat;
let focused = true;
let treeProvider;
let statusBar;
let healthProvider;
let dashboardRefresh;
let heartbeatWrite;
let refreshTimer;
let dashboardTimer;
let dashboardSnapshot = { windows: [], instances: [], supervisor: undefined, events: [], registryMode: undefined, digest: "" };
let extensionContext;

function configuration() {
  const config = vscode.workspace.getConfiguration("ompOrchestrator");
  const memoryLimitGiB = Math.min(10, Math.max(5, config.get("memoryLimitGiB", 8)));
  return {
    ompPath: config.get("ompPath", "omp"),
    bunPath: config.get("bunPath", "bun"),
    watchdog: {
      enabled: true,
      autoRecover: config.get("autoRecover", true),
      memoryLimitBytes: Math.round(memoryLimitGiB * 1024 ** 3),
      consecutiveSamples: Math.min(10, Math.max(2, config.get("memoryConsecutiveSamples", 3))),
      pollIntervalMs: Math.min(60, Math.max(5, config.get("memoryPollSeconds", 15))) * 1_000,
    },
  };
}

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function windowLabel() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (vscode.workspace.name) return vscode.workspace.name;
  if (folders.length === 1) return folders[0].name;
  if (folders.length > 1) return `${folders[0].name} +${folders.length - 1}`;
  return "Empty window";
}

function ownedTerminalId(terminal) {
  const options = terminal.creationOptions;
  if (options && "env" in options && options.env) {
    const value = options.env.OMP_TERMINAL_ID;
    if (typeof value === "string" && value) return value;
  }
  return adoptedTerminalIds.get(terminal);
}

async function terminalRecords() {
  return await Promise.all(
    vscode.window.terminals.map(async (terminal) => {
      const terminalId = ownedTerminalId(terminal);
      const options = terminal.creationOptions;
      let pid;
      try {
        pid = await terminal.processId;
      } catch {
        pid = undefined;
      }
      return {
        terminalId: terminalId || `external:${pid || terminal.name}`,
        name: terminal.name,
        pid,
        cwd: options && "cwd" in options && typeof options.cwd === "string" ? options.cwd : undefined,
        owned: Boolean(terminalId),
      };
    }),
  );
}

function editorTabs() {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.map((tab) => {
      const input = tab.input;
      const resource = input && typeof input === "object" && "uri" in input && input.uri instanceof vscode.Uri ? input.uri.fsPath : undefined;
      return {
        group: group.viewColumn,
        label: tab.label,
        resource,
        active: tab.isActive,
        dirty: tab.isDirty,
      };
    }),
  );
}

async function buildWindowRecord() {
  const { watchdog } = configuration();
  return {
    protocolVersion: WINDOW_PROTOCOL_VERSION,
    windowId: WINDOW_ID,
    socketPath: SOCKET_PATH,
    pid: process.pid,
    editorSessionId: vscode.env.sessionId,
    appPid: process.ppid,
    label: windowLabel(),
    workspaceFolders: workspaceFolders(),
    workspaceFile: vscode.workspace.workspaceFile?.fsPath,
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    remoteName: vscode.env.remoteName,
    startedAt: STARTED_AT,
    updatedAt: new Date().toISOString(),
    terminals: await terminalRecords(),
    focused,
    activeEditor: vscode.window.activeTextEditor?.document.uri.fsPath,
    editorTabs: editorTabs(),
    watchdog,
  };
}

async function writeHeartbeat() {
  if (heartbeatWrite) return await heartbeatWrite;
  heartbeatWrite = (async () => {
    const record = await buildWindowRecord();
    await writeWindowRecord(record);
    return record;
  })();
  try {
    return await heartbeatWrite;
  } finally {
    heartbeatWrite = undefined;
  }
}

function dashboardDigest(windows, instances, supervisor, events, mode) {
  return JSON.stringify({
    windows: windows.map((window) => ({
      id: window.windowId,
      pid: window.pid,
      focused: window.focused,
      tabs: window.terminals.map((terminal) => [terminal.terminalId, terminal.pid]),
    })),
    instances: instances.map((instance) => [instance.instanceId, instance.pid, instance.status, instance.alias, instance.windowId, instance.terminalId]),
    supervisor: supervisor ? [supervisor.pid, supervisor.summaries] : undefined,
    events: events.map((event) => [event.at, event.type]),
    mode,
  });
}

async function refreshDashboard(force = false) {
  if (dashboardRefresh) return await dashboardRefresh;
  dashboardRefresh = (async () => {
    const [windows, instances, supervisor, events, mode] = await Promise.all([
      readWindows(),
      readInstances(),
      readSupervisorState(),
      readSupervisorEvents(12),
      registryMode(),
    ]);
    const digest = dashboardDigest(windows, instances, supervisor, events, mode);
    dashboardSnapshot = { windows, instances, supervisor, events, registryMode: mode, digest };
    const local = windows.find((window) => window.windowId === WINDOW_ID);
    const localInstances = instances.filter((instance) => instance.windowId === WINDOW_ID);
    if (statusBar && local) {
      const busy = localInstances.filter((instance) => instance.status === "busy").length;
      const appMemory = supervisor?.summaries?.find((summary) => summary.kind === "vscode" && summary.pid === local.appPid);
      const memory = appMemory ? ` · ${(appMemory.rssBytes / 1024 ** 3).toFixed(1)}G` : "";
      const memoryRatio = appMemory ? appMemory.rssBytes / appMemory.limitBytes : 0;
      const supervisorOnline = Boolean(supervisor && processAlive(supervisor.pid) && Date.now() - Date.parse(supervisor.updatedAt) < 90_000);
      const warning = !supervisorOnline || memoryRatio >= 0.8;
      statusBar.text = `$(${warning ? "warning" : "server-process"}) OMP ${localInstances.length}${busy ? ` · ${busy} busy` : ""}${memory}`;
      statusBar.tooltip = `${local.label}\nWindow ${WINDOW_ID}\nWatchdog ${(local.watchdog.memoryLimitBytes / 1024 ** 3).toFixed(0)} GiB\nSupervisor ${supervisorOnline ? "online" : "unavailable"}`;
      statusBar.backgroundColor = warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    }
    if (force || digest !== treeProvider?.digest) {
      treeProvider?.setSnapshot(dashboardSnapshot);
      healthProvider?.setSnapshot(dashboardSnapshot);
    }
    return dashboardSnapshot;
  })();
  try {
    return await dashboardRefresh;
  } finally {
    dashboardRefresh = undefined;
  }
}

function scheduleDashboardRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshDashboard(), 100);
}

async function refreshState(force = false) {
  const record = await writeHeartbeat();
  await refreshDashboard(force);
  return record;
}

function validateAlias(value) {
  const alias = String(value || "").trim();
  const hasControl = Array.from(alias).some((character) => character < " " || character === "\u007f");
  if (!alias || alias.length > 64 || hasControl) throw new Error("OMP alias must contain 1-64 printable characters");
  return alias;
}

function validateWindowRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request must be an object");
  const action = value.action;
  if (action === "ping" || action === "state" || action === "show_dashboard" || action === "close_window") return { action };
  if (action === "create_omp") {
    return {
      action,
      alias: value.alias === undefined ? undefined : validateAlias(value.alias),
      cwd: value.cwd === undefined ? undefined : String(value.cwd),
      initialMessage: value.initialMessage === undefined ? undefined : String(value.initialMessage),
    };
  }
  if (action === "resume_omp") {
    if (typeof value.sessionFile !== "string" || !value.sessionFile) throw new Error("resume_omp requires sessionFile");
    return {
      action,
      sessionFile: value.sessionFile,
      alias: value.alias === undefined ? undefined : validateAlias(value.alias),
      cwd: value.cwd === undefined ? undefined : String(value.cwd),
      terminalId: value.terminalId === undefined ? undefined : String(value.terminalId),
      reason: value.reason === undefined ? undefined : String(value.reason),
    };
  }
  if (action === "focus_omp") {
    if (typeof value.terminalId !== "string" || !value.terminalId) throw new Error("focus_omp requires terminalId");
    return { action, terminalId: value.terminalId };
  }
  if (action === "reload_window") {
    return { action, reason: value.reason === undefined ? undefined : String(value.reason) };
  }
  if (action === "notify") {
    if (typeof value.message !== "string" || !value.message) throw new Error("notify requires message");
    if (value.level !== undefined && !["info", "warning", "error"].includes(value.level)) throw new Error("Invalid notification level");
    return { action, level: value.level, message: value.message };
  }
  throw new Error("Unknown window action");
}

async function waitForInstance(terminalId, pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await readInstances()).find(
      (candidate) => candidate.terminalId === terminalId && candidate.pid === pid && candidate.status !== "shutting_down",
    );
    if (instance) return instance;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

/**
 * @param {{ alias?: string, cwd?: string, initialMessage?: string, sessionFile?: string, terminalId?: string }} options
 */
async function createOmpTerminal({ alias, cwd, initialMessage, sessionFile, terminalId }) {
  const effectiveAlias = validateAlias(alias || `omp-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`);
  const duplicate = (await readInstances()).find((instance) => instance.alias.toLocaleLowerCase() === effectiveAlias.toLocaleLowerCase());
  if (duplicate && (!terminalId || duplicate.terminalId !== terminalId)) throw new Error(`OMP alias already exists: ${effectiveAlias}`);
  const effectiveCwd = cwd || workspaceFolders()[0] || process.env.HOME;
  const id = terminalId || crypto.randomUUID();
  if (sessionFile && terminalId) {
    const previousTerminal = terminalsById.get(terminalId) || vscode.window.terminals.find((candidate) => ownedTerminalId(candidate) === terminalId);
    if (previousTerminal) {
      previousTerminal.dispose();
      terminalsById.delete(terminalId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  const config = configuration();
  const shellArgs = sessionFile ? ["--resume", sessionFile, "--cwd", effectiveCwd] : ["--cwd", effectiveCwd];
  const terminal = vscode.window.createTerminal({
    name: `OMP: ${effectiveAlias}`,
    shellPath: config.ompPath,
    shellArgs,
    cwd: effectiveCwd,
    env: {
      OMP_WINDOW_ID: WINDOW_ID,
      OMP_TERMINAL_ID: id,
      OMP_INSTANCE_NAME: effectiveAlias,
    },
    iconPath: new vscode.ThemeIcon("server-process"),
    isTransient: false,
  });
  terminalsById.set(id, terminal);
  terminal.show(true);
  const pid = await terminal.processId;
  const instance = pid ? await waitForInstance(id, pid) : undefined;
  if (initialMessage && instance) {
    await requestSocket(instance.socketPath, { action: "send", message: initialMessage, delivery: "auto" }, 5_000);
  }
  if (initialMessage && !instance) {
    vscode.window.showWarningMessage(`OMP ${effectiveAlias} started, but control socket was not ready; initial message was not sent.`);
  }
  return { terminalId: id, pid, alias: effectiveAlias, cwd: effectiveCwd, instance };
}

function processParents() {
  const output = cp.execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
  const parents = new Map();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

function descendsFrom(pid, ancestorPid, parents) {
  let current = pid;
  for (let depth = 0; depth < 64 && current > 0; depth += 1) {
    if (current === ancestorPid) return true;
    current = parents.get(current) || 0;
  }
  return false;
}

async function relinkSurvivingTerminals() {
  for (const terminal of vscode.window.terminals) {
    const terminalId = ownedTerminalId(terminal);
    if (terminalId) terminalsById.set(terminalId, terminal);
  }
  await adoptExistingOmpTerminals();
}

async function adoptExistingOmpTerminals() {
  const saved = extensionContext.globalState.get("ompOrchestrator.adoptedTerminals", {});
  const terminalPids = await Promise.all(
    vscode.window.terminals.map(async (terminal) => ({ terminal, pid: await terminal.processId })),
  );
  for (const entry of terminalPids) {
    if (!entry.pid || ownedTerminalId(entry.terminal)) continue;
    const savedId = saved[String(entry.pid)];
    if (typeof savedId === "string") adoptedTerminalIds.set(entry.terminal, savedId);
  }
  const parents = processParents();
  const instances = await readInstances({ includeStale: true });
  for (const instance of instances) {
    const candidates = terminalPids.filter((entry) => entry.pid && descendsFrom(instance.pid, entry.pid, parents));
    if (candidates.length !== 1) continue;
    const terminal = candidates[0].terminal;
    const terminalPid = candidates[0].pid;
    const terminalId = ownedTerminalId(terminal) || instance.terminalId || crypto.randomUUID();
    adoptedTerminalIds.set(terminal, terminalId);
    terminalsById.set(terminalId, terminal);
    if (terminalPid) saved[String(terminalPid)] = terminalId;
    if (instance.windowId !== WINDOW_ID || instance.terminalId !== terminalId) {
      try {
        await requestSocket(instance.socketPath, { action: "relink", windowId: WINDOW_ID, terminalId }, 2_000);
      } catch (error) {
        console.warn("[OMP Orchestrator] failed to adopt terminal", instance.alias, error.message);
      }
    }
  }
  await extensionContext.globalState.update("ompOrchestrator.adoptedTerminals", saved);
}

async function relinkSurvivingTerminals() {
  for (const terminal of vscode.window.terminals) {
    const terminalId = ownedTerminalId(terminal);
    if (!terminalId) continue;
    terminalsById.set(terminalId, terminal);
  }
  const instances = await readInstances({ includeStale: true });
  for (const instance of instances) {
    if (!instance.terminalId || !terminalsById.has(instance.terminalId) || instance.windowId === WINDOW_ID) continue;
    try {
      await requestSocket(instance.socketPath, { action: "relink", windowId: WINDOW_ID, terminalId: instance.terminalId }, 2_000);
    } catch (error) {
      console.warn("[OMP Orchestrator] failed to relink terminal", instance.alias, error.message);
    }
  }
}

async function executeWindowRequest(request) {
  if (request.action === "ping" || request.action === "state") return { ok: true, window: await refreshState() };
  if (request.action === "show_dashboard") {
    await vscode.commands.executeCommand("workbench.view.extension.ompOrchestrator");
    await refreshDashboard(true);
    return { ok: true, window: await writeHeartbeat(), result: { shown: true } };
  }
  if (request.action === "create_omp") {
    const created = await createOmpTerminal(request);
    return { ok: true, window: await refreshState(), result: created };
  }
  if (request.action === "resume_omp") {
    await fs.access(request.sessionFile);
    const created = await createOmpTerminal({
      alias: request.alias || `resumed-${path.basename(request.sessionFile, ".jsonl").slice(-8)}`,
      cwd: request.cwd,
      sessionFile: request.sessionFile,
      terminalId: request.terminalId,
    });
    if (request.reason) vscode.window.showWarningMessage(`Resumed ${created.alias}: ${request.reason}`);
    return { ok: true, window: await refreshState(), result: created };
  }
  if (request.action === "focus_omp") {
    let terminal = terminalsById.get(request.terminalId);
    if (!terminal) terminal = vscode.window.terminals.find((candidate) => ownedTerminalId(candidate) === request.terminalId);
    if (!terminal) throw new Error(`OMP terminal not found: ${request.terminalId}`);
    terminal.show(false);
    return { ok: true, window: await refreshState(), result: { focused: true } };
  }
  if (request.action === "reload_window") {
    await vscode.workspace.saveAll(false);
    const windowRecord = await refreshState();
    setTimeout(() => void vscode.commands.executeCommand("workbench.action.reloadWindow"), 100);
    return { ok: true, window: windowRecord, result: { reloading: true, reason: request.reason } };
  }
  if (request.action === "close_window") {
    await vscode.workspace.saveAll(false);
    const windowRecord = await refreshState();
    setTimeout(() => void vscode.commands.executeCommand("workbench.action.closeWindow"), 100);
    return { ok: true, window: windowRecord, result: { closing: true } };
  }
  if (request.action === "notify") {
    if (request.level === "error") vscode.window.showErrorMessage(request.message);
    else if (request.level === "warning") vscode.window.showWarningMessage(request.message);
    else vscode.window.showInformationMessage(request.message);
    return { ok: true, window: await refreshState(), result: { notified: true } };
  }
  throw new Error("Unsupported window action");
}

function handleSocket(socket) {
  let buffer = "";
  let handled = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
      handled = true;
      socket.end(`${JSON.stringify({ ok: false, error: "Request exceeds 256 KB limit" })}\n`);
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    socket.pause();
    void (async () => {
      try {
        const request = validateWindowRequest(JSON.parse(buffer.slice(0, newline)));
        socket.end(`${JSON.stringify(await executeWindowRequest(request))}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    })();
  });
  socket.on("error", () => {});
}

async function startControlServer() {
  await ensureDirectories();
  await fs.rm(SOCKET_PATH, { force: true });
  const server = net.createServer(handleSocket);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await fs.chmod(SOCKET_PATH, 0o600);
  controlServer = server;
}

async function ensureSupervisor() {
  try {
    const current = JSON.parse(await fs.readFile(SUPERVISOR_FILE, "utf8"));
    if (processAlive(current.pid)) return;
  } catch {
    // Missing or stale supervisor record.
  }
  const config = configuration();
  const script = path.join(extensionContext.extensionPath, "supervisor.js");
  const child = cp.spawn(config.bunPath, [script], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

class OrchestratorNode {
  constructor(kind, label, data, collapsibleState = vscode.TreeItemCollapsibleState.None) {
    this.kind = kind;
    this.label = label;
    this.data = data;
    this.collapsibleState = collapsibleState;
  }
}

class OrchestratorProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.snapshot = dashboardSnapshot;
    this.digest = "";
  }

  setSnapshot(snapshot) {
    if (snapshot.digest === this.digest) return;
    this.snapshot = snapshot;
    this.digest = snapshot.digest;
    this.emitter.fire(undefined);
  }

  memorySummary(kind, id, pid) {
    return this.snapshot.supervisor?.summaries?.find(
      (summary) => summary.kind === kind && (summary.id === id || summary.pid === pid),
    );
  }

  async getChildren(element) {
    if (!element) {
      const roots = this.snapshot.windows.map(
        (window) => new OrchestratorNode("window", window.label, window, vscode.TreeItemCollapsibleState.Expanded),
      );
      const unattached = this.snapshot.instances.filter(
        (instance) => !instance.windowId || !this.snapshot.windows.some((window) => window.windowId === instance.windowId),
      );
      if (unattached.length) roots.push(new OrchestratorNode("unattached", `Unattached OMP (${unattached.length})`, unattached, vscode.TreeItemCollapsibleState.Expanded));
      return roots;
    }
    if (element.kind === "window") {
      const attached = this.snapshot.instances.filter((instance) => instance.windowId === element.data.windowId);
      const children = attached.map((instance) => new OrchestratorNode("instance", instance.alias, instance));
      if (element.data.editorTabs.length) children.push(new OrchestratorNode("editors", `Editor tabs (${element.data.editorTabs.length})`, element.data.editorTabs, vscode.TreeItemCollapsibleState.Collapsed));
      if (element.data.terminals.length) children.push(new OrchestratorNode("terminals", `Terminal tabs (${element.data.terminals.length})`, element.data.terminals, vscode.TreeItemCollapsibleState.Collapsed));
      return children;
    }
    if (element.kind === "unattached") return element.data.map((instance) => new OrchestratorNode("instance", instance.alias, instance));
    if (element.kind === "editors") return element.data.map((tab) => new OrchestratorNode("editor", tab.label, tab));
    if (element.kind === "terminals") return element.data.map((terminal) => new OrchestratorNode("terminal", terminal.name, terminal));
    return [];
  }

  getTreeItem(element) {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    if (element.kind === "window") {
      const memory = this.memorySummary("vscode", String(element.data.appPid), element.data.appPid);
      const memoryText = memory ? `${(memory.rssBytes / 1024 ** 3).toFixed(1)}G` : "memory pending";
      const attached = this.snapshot.instances.filter((instance) => instance.windowId === element.data.windowId);
      item.contextValue = "vscodeWindow";
      item.iconPath = new vscode.ThemeIcon(element.data.focused ? "window" : "window-inactive");
      item.description = `${attached.length} OMP · ${memoryText}`;
      item.tooltip = `${element.data.appName}\n${element.data.workspaceFolders.join("\n") || "No workspace"}\nWindow ${element.data.windowId}\nExtension host ${element.data.pid}\nApp ${element.data.appPid}`;
    } else if (element.kind === "instance") {
      const memory = this.memorySummary("omp", element.data.instanceId, element.data.pid);
      const memoryText = memory ? `${(memory.rssBytes / 1024 ** 2).toFixed(0)}M` : "memory pending";
      item.contextValue = "ompInstance";
      item.iconPath = new vscode.ThemeIcon(element.data.status === "busy" ? "sync~spin" : element.data.status === "shutting_down" ? "debug-stop" : "circle-filled");
      item.description = `${element.data.status} · ${memoryText}`;
      item.tooltip = `${element.data.model || "model unknown"}\n${element.data.cwd}\nPID ${element.data.pid}\nSession ${element.data.sessionId || "not persisted"}\n${element.data.sessionFile || "No session file"}`;
      item.command = { command: "ompInstances.focusOmp", title: "Focus OMP", arguments: [element] };
    } else if (element.kind === "editor") {
      item.iconPath = new vscode.ThemeIcon(element.data.dirty ? "circle-filled" : "file-code");
      item.description = element.data.active ? "active" : element.data.resource || "";
    } else if (element.kind === "terminal") {
      item.iconPath = new vscode.ThemeIcon(element.data.owned ? "server-process" : "terminal");
      item.description = `${element.data.owned ? "managed" : "external"}${element.data.pid ? ` · pid ${element.data.pid}` : " · starting"}`;
    } else {
      item.iconPath = new vscode.ThemeIcon("list-tree");
    }
    return item;
  }
}

class HealthProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.snapshot = dashboardSnapshot;
    this.digest = "";
  }

  setSnapshot(snapshot) {
    if (snapshot.digest === this.digest) return;
    this.snapshot = snapshot;
    this.digest = snapshot.digest;
    this.emitter.fire(undefined);
  }

  async getChildren(element) {
    if (!element) {
      const nodes = [];
      const supervisor = this.snapshot.supervisor;
      const ageMs = supervisor ? Date.now() - Date.parse(supervisor.updatedAt) : Infinity;
      nodes.push(new OrchestratorNode("health", supervisor && processAlive(supervisor.pid) && ageMs < 90_000 ? "Supervisor online" : "Supervisor unavailable", { severity: supervisor && ageMs < 90_000 ? "ok" : "error", detail: supervisor ? `pid ${supervisor.pid} · ${Math.round(ageMs / 1000)}s ago` : "not registered" }));
      nodes.push(new OrchestratorNode("health", `Registry ${this.snapshot.registryMode === 0o700 ? "secure" : "permission mismatch"}`, { severity: this.snapshot.registryMode === 0o700 ? "ok" : "error", detail: `${CONTROL_ROOT} · ${this.snapshot.registryMode?.toString(8) || "missing"}` }));
      const attached = this.snapshot.instances.filter((instance) => this.snapshot.windows.some((window) => window.windowId === instance.windowId)).length;
      const unattached = this.snapshot.instances.length - attached;
      const busy = this.snapshot.instances.filter((instance) => instance.status === "busy").length;
      nodes.push(new OrchestratorNode("health", `${this.snapshot.instances.length} OMP · ${busy} busy · ${unattached} unattached`, { severity: unattached ? "warning" : "ok", detail: `${attached} linked to ${this.snapshot.windows.length} window(s)` }));
      nodes.push(new OrchestratorNode("memoryGroup", `Memory (${this.snapshot.supervisor?.summaries?.length || 0})`, this.snapshot.supervisor?.summaries || [], vscode.TreeItemCollapsibleState.Expanded));
      nodes.push(new OrchestratorNode("eventGroup", `Recovery events (${this.snapshot.events.length})`, this.snapshot.events, vscode.TreeItemCollapsibleState.Collapsed));
      return nodes;
    }
    if (element.kind === "memoryGroup") return element.data.map((summary) => new OrchestratorNode("memory", `${summary.kind === "vscode" ? "VSCodium" : "OMP"} ${summary.id}`, summary));
    if (element.kind === "eventGroup") return [...element.data].reverse().map((event) => new OrchestratorNode("event", event.type.replaceAll("_", " "), event));
    return [];
  }

  getTreeItem(element) {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    if (element.kind === "health") {
      item.iconPath = new vscode.ThemeIcon(element.data.severity === "ok" ? "pass-filled" : element.data.severity === "warning" ? "warning" : "error");
      item.description = element.data.detail;
    } else if (element.kind === "memory") {
      const percent = element.data.limitBytes ? Math.round((element.data.rssBytes / element.data.limitBytes) * 100) : 0;
      item.iconPath = new vscode.ThemeIcon(percent >= 90 ? "warning" : "pulse");
      item.description = `${(element.data.rssBytes / 1024 ** 3).toFixed(2)} / ${(element.data.limitBytes / 1024 ** 3).toFixed(0)} GiB · ${percent}%`;
      item.tooltip = `PID ${element.data.pid}\nAggregate descendant RSS`;
    } else if (element.kind === "event") {
      item.iconPath = new vscode.ThemeIcon(element.data.type.includes("failed") ? "error" : element.data.type.includes("started") ? "play" : "history");
      item.description = element.data.at ? new Date(element.data.at).toLocaleTimeString() : "";
      item.tooltip = JSON.stringify(element.data, null, 2);
    } else {
      item.iconPath = new vscode.ThemeIcon("list-tree");
    }
    return item;
  }
}

async function selectWindow(prompt) {
  const windows = await readWindows();
  if (windows.length === 0) throw new Error("No managed VS Code windows are running");
  if (windows.length === 1) return windows[0];
  const selected = await vscode.window.showQuickPick(
    windows.map((window) => ({ label: window.label, description: window.workspaceFolders.join(", "), window })),
    { placeHolder: prompt },
  );
  return selected?.window;
}

async function selectInstance(prompt) {
  const instances = await readInstances();
  if (instances.length === 0) throw new Error("No OMP instances are running");
  const selected = await vscode.window.showQuickPick(
    instances.map((instance) => ({ label: instance.alias, description: `${instance.status} · ${instance.cwd}`, instance })),
    { placeHolder: prompt },
  );
  return selected?.instance;
}

function instanceFromArgument(argument) {
  return argument?.kind === "instance" ? argument.data : undefined;
}

function windowFromArgument(argument) {
  return argument?.kind === "window" ? argument.data : undefined;
}

async function activate(context) {
  extensionContext = context;
  treeProvider = new OrchestratorProvider();
  healthProvider = new HealthProvider();
  const tree = vscode.window.createTreeView("ompInstances.instances", { treeDataProvider: treeProvider, showCollapseAll: true });
  const healthTree = vscode.window.createTreeView("ompInstances.health", { treeDataProvider: healthProvider, showCollapseAll: true });
  statusBar = vscode.window.createStatusBarItem("ompOrchestrator.status", vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "ompInstances.refresh";
  statusBar.name = "OMP Orchestrator";
  statusBar.show();
  await startControlServer();
  await relinkSurvivingTerminals();
  await ensureSupervisor();
  await refreshState(true);

  const createOmp = vscode.commands.registerCommand("ompInstances.createOmp", async (argument) => {
    const owner = windowFromArgument(argument) || (await selectWindow("Create OMP in which window?"));
    if (!owner) return;
    const alias = await vscode.window.showInputBox({
      prompt: "OMP alias",
      validateInput: (value) => {
        try { validateAlias(value); return undefined; } catch (error) { return error.message; }
      },
    });
    if (!alias) return;
    if (owner.windowId === WINDOW_ID) await createOmpTerminal({ alias });
    else await requestSocket(owner.socketPath, { action: "create_omp", alias }, 30_000);
    await refreshState(true);
  });

  const resumeOmp = vscode.commands.registerCommand("ompInstances.resumeOmp", async () => {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "OMP sessions": ["jsonl"] }, title: "Select OMP session" });
    if (!files?.[0]) return;
    const owner = await selectWindow("Resume OMP in which window?");
    if (!owner) return;
    const alias = await vscode.window.showInputBox({ prompt: "Alias for resumed OMP", value: `resumed-${path.basename(files[0].fsPath, ".jsonl").slice(-8)}` });
    if (!alias) return;
    await requestSocket(owner.socketPath, { action: "resume_omp", sessionFile: files[0].fsPath, alias }, 30_000);
    await refreshDashboard(true);
  });

  const launchTeam = vscode.commands.registerCommand("ompInstances.launchTeam", async () => {
    const owner = await selectWindow("Launch team in which window?");
    if (!owner) return;
    const countItem = await vscode.window.showQuickPick([2, 3, 4, 5, 6, 7, 8].map((count) => ({ label: String(count), count })), { placeHolder: "Number of OMP agents" });
    if (!countItem) return;
    for (let index = 0; index < countItem.count; index += 1) {
      const alias = await vscode.window.showInputBox({ prompt: `Alias for agent ${index + 1}` });
      if (!alias) return;
      const initialMessage = await vscode.window.showInputBox({ prompt: `Initial assignment for ${alias}` });
      if (!initialMessage) return;
      await requestSocket(owner.socketPath, { action: "create_omp", alias: validateAlias(alias), initialMessage }, 30_000);
    }
    await refreshDashboard(true);
  });

  const sendMessage = vscode.commands.registerCommand("ompInstances.sendMessage", async (argument) => {
    const instance = instanceFromArgument(argument) || (await selectInstance("Send message to which OMP?"));
    if (!instance) return;
    const message = await vscode.window.showInputBox({ prompt: `Message to ${instance.alias}` });
    if (message) await requestSocket(instance.socketPath, { action: "send", message, delivery: "auto" });
  });

  const broadcastMessage = vscode.commands.registerCommand("ompInstances.broadcastMessage", async () => {
    const message = await vscode.window.showInputBox({ prompt: "Broadcast message to every OMP" });
    if (!message) return;
    const outcomes = await Promise.allSettled((await readInstances()).map((instance) => requestSocket(instance.socketPath, { action: "send", message, delivery: "auto" })));
    const failed = outcomes.filter((outcome) => outcome.status === "rejected").length;
    vscode.window.showInformationMessage(`Broadcast sent to ${outcomes.length - failed}/${outcomes.length} OMP instances.`);
  });

  const focusOmp = vscode.commands.registerCommand("ompInstances.focusOmp", async (argument) => {
    const instance = instanceFromArgument(argument) || (await selectInstance("Focus which OMP?"));
    if (!instance?.windowId || !instance.terminalId) return;
    const owner = (await readWindows()).find((window) => window.windowId === instance.windowId);
    if (!owner) throw new Error(`Owning VS Code window is unavailable: ${instance.windowId}`);
    await requestSocket(owner.socketPath, { action: "focus_omp", terminalId: instance.terminalId });
  });

  const renameOmp = vscode.commands.registerCommand("ompInstances.renameOmp", async (argument) => {
    const instance = instanceFromArgument(argument) || (await selectInstance("Rename which OMP?"));
    if (!instance) return;
    const alias = await vscode.window.showInputBox({ prompt: "New OMP alias", value: instance.alias, validateInput: (value) => { try { validateAlias(value); return undefined; } catch (error) { return error.message; } } });
    if (!alias || alias === instance.alias) return;
    await requestSocket(instance.socketPath, { action: "rename", alias });
    await refreshDashboard(true);
  });

  const openSession = vscode.commands.registerCommand("ompInstances.openSession", async (argument) => {
    const instance = instanceFromArgument(argument) || (await selectInstance("Open session for which OMP?"));
    if (!instance?.sessionFile) {
      vscode.window.showWarningMessage("Selected OMP has no persisted session file.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(instance.sessionFile);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  });

  const copyId = vscode.commands.registerCommand("ompInstances.copyId", async (argument) => {
    const value = instanceFromArgument(argument)?.instanceId || windowFromArgument(argument)?.windowId;
    if (value) await vscode.env.clipboard.writeText(value);
  });

  const interruptOmp = vscode.commands.registerCommand("ompInstances.interruptOmp", async (argument) => {
    const instance = instanceFromArgument(argument) || (await selectInstance("Interrupt which OMP?"));
    if (instance) await requestSocket(instance.socketPath, { action: "interrupt" });
  });

  const restartOmp = vscode.commands.registerCommand("ompInstances.restartOmp", async (argument) => {
    const instance = instanceFromArgument(argument) || (await selectInstance("Restart and resume which OMP?"));
    if (!instance) return;
    const confirmation = await vscode.window.showWarningMessage(`Restart ${instance.alias} and resume its persisted session?`, { modal: true }, "Restart");
    if (confirmation === "Restart") {
      await restartAndResumeInstance(instance);
      await refreshDashboard(true);
    }
  });

  const shutdownOmp = vscode.commands.registerCommand("ompInstances.shutdownOmp", async (argument) => {
    const instance = instanceFromArgument(argument) || (await selectInstance("Shut down which OMP?"));
    if (!instance) return;
    const confirmation = await vscode.window.showWarningMessage(`Shut down ${instance.alias}? Persisted session can be resumed later.`, { modal: true }, "Shut down");
    if (confirmation === "Shut down") await requestSocket(instance.socketPath, { action: "shutdown" });
  });

  const openWindow = vscode.commands.registerCommand("ompInstances.openWindow", async () => {
    const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: "Open workspace in new window" });
    if (folders?.[0]) await vscode.commands.executeCommand("vscode.openFolder", folders[0], true);
  });

  const reloadWindow = vscode.commands.registerCommand("ompInstances.reloadWindow", async (argument) => {
    const owner = windowFromArgument(argument) || (await selectWindow("Reload which window?"));
    if (owner) await requestSocket(owner.socketPath, { action: "reload_window", reason: "Requested from OMP Orchestrator" });
  });

  const openRecoveryLog = vscode.commands.registerCommand("ompInstances.openRecoveryLog", async () => {
    try {
      const document = await vscode.workspace.openTextDocument(SUPERVISOR_EVENT_FILE);
      await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    } catch {
      vscode.window.showInformationMessage("No recovery events recorded yet.");
    }
  });

  const refreshCommand = vscode.commands.registerCommand("ompInstances.refresh", async () => refreshState(true));
  const stateChanged = () => {
    void writeHeartbeat();
    scheduleDashboardRefresh();
  };
  const stateListener = vscode.window.onDidChangeWindowState((state) => { focused = state.focused; stateChanged(); });
  const terminalOpened = vscode.window.onDidOpenTerminal(stateChanged);
  const terminalClosed = vscode.window.onDidCloseTerminal((terminal) => {
    const id = ownedTerminalId(terminal);
    if (id) terminalsById.delete(id);
    adoptedTerminalIds.delete(terminal);
    stateChanged();
  });
  const tabsChanged = vscode.window.tabGroups.onDidChangeTabs(stateChanged);
  const groupsChanged = vscode.window.tabGroups.onDidChangeTabGroups(stateChanged);
  const configChanged = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("ompOrchestrator")) {
      stateChanged();
      void ensureSupervisor();
    }
  });
  heartbeat = setInterval(() => void writeHeartbeat(), HEARTBEAT_MS);
  heartbeat.unref();
  dashboardTimer = setInterval(() => void refreshDashboard(), 5_000);
  dashboardTimer.unref();

  context.subscriptions.push(
    tree,
    healthTree,
    statusBar,
    createOmp,
    resumeOmp,
    launchTeam,
    sendMessage,
    broadcastMessage,
    focusOmp,
    renameOmp,
    openSession,
    copyId,
    interruptOmp,
    shutdownOmp,
    restartOmp,
    openWindow,
    reloadWindow,
    openRecoveryLog,
    refreshCommand,
    stateListener,
    terminalOpened,
    terminalClosed,
    tabsChanged,
    groupsChanged,
    configChanged,
    { dispose: () => { clearInterval(heartbeat); clearInterval(dashboardTimer); clearTimeout(refreshTimer); } },
  );
}

async function deactivate() {
  clearInterval(heartbeat);
  if (controlServer) await new Promise((resolve) => controlServer.close(() => resolve()));
  await removeWindowArtifacts(WINDOW_ID, SOCKET_PATH);
}

module.exports = { activate, deactivate };
