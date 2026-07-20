"use strict";

const cp = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  CONTROL_ROOT,
  SUPERVISOR_FILE,
  ensureDirectories,
  processAlive,
  readInstances,
  readWindows,
  requestSocket,
} = require("./lib/control.js");

const LOCK_FILE = `${SUPERVISOR_FILE}.lock`;
const EVENT_FILE = path.join(CONTROL_ROOT, "supervisor-events.jsonl");
const DEFAULT_LIMIT_BYTES = 8 * 1024 ** 3;
const DEFAULT_SAMPLES = 3;
const DEFAULT_POLL_MS = 15_000;
const breachCounts = new Map();
const recovering = new Set();
const appRecoveryStages = new Map();
const cooldowns = new Map();
let shuttingDown = false;

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function claimSingleton() {
  await ensureDirectories();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(LOCK_FILE, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const current = JSON.parse(await fs.readFile(LOCK_FILE, "utf8"));
        if (processAlive(current.pid)) return false;
      } catch {
        // Stale or malformed lock.
      }
      await fs.rm(LOCK_FILE, { force: true });
    }
  }
  return false;
}

async function writeSupervisorState(extra = {}) {
  const record = {
    pid: process.pid,
    startedAt: globalThis.__OMP_SUPERVISOR_STARTED_AT,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  const temporary = `${SUPERVISOR_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await fs.rename(temporary, SUPERVISOR_FILE);
  await fs.chmod(SUPERVISOR_FILE, 0o600);
}

async function recordEvent(type, data = {}) {
  const event = `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`;
  try {
    const stat = await fs.stat(EVENT_FILE);
    if (stat.size > 2_000_000) await fs.rename(EVENT_FILE, `${EVENT_FILE}.previous`);
  } catch {
    // First event.
  }
  await fs.appendFile(EVENT_FILE, event, { encoding: "utf8", mode: 0o600 });
}

function processSnapshot() {
  const output = cp.execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", timeout: 5_000 });
  const processes = new Map();
  const children = new Map();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    processes.set(pid, { pid, ppid, rssBytes: Number(match[3]) * 1024, command: match[4] });
    const siblings = children.get(ppid) || [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  return { processes, children };
}

function processTree(snapshot, rootPid, excludedRoots = new Set()) {
  const pids = [];
  let rssBytes = 0;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || (pid !== rootPid && excludedRoots.has(pid))) continue;
    const processRecord = snapshot.processes.get(pid);
    if (!processRecord) continue;
    pids.push(pid);
    rssBytes += processRecord.rssBytes;
    stack.push(...(snapshot.children.get(pid) || []));
  }
  return { pids, rssBytes };
}

function policyForWindow(window) {
  return window?.watchdog || {
    enabled: true,
    autoRecover: true,
    memoryLimitBytes: DEFAULT_LIMIT_BYTES,
    consecutiveSamples: DEFAULT_SAMPLES,
    pollIntervalMs: DEFAULT_POLL_MS,
  };
}

function breachReady(key, rssBytes, policy) {
  if (!policy.enabled || Date.now() < (cooldowns.get(key) || 0)) {
    breachCounts.delete(key);
    return false;
  }
  if (rssBytes <= policy.memoryLimitBytes) {
    breachCounts.delete(key);
    return false;
  }
  const count = (breachCounts.get(key) || 0) + 1;
  breachCounts.set(key, count);
  return count >= policy.consecutiveSamples;
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(200);
  }
  return !processAlive(pid);
}

async function terminateProcessTree(pid, snapshot, excludedRoots = new Set()) {
  const tree = processTree(snapshot, pid, excludedRoots);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const processId of [...tree.pids].reverse()) {
      try {
        process.kill(processId, signal);
      } catch {
        // Process already exited.
      }
    }
    if (await waitForExit(pid, signal === "SIGTERM" ? 3_000 : 1_000)) return;
  }
}

async function notifyWindow(window, level, message) {
  if (!window) return;
  try {
    await requestSocket(window.socketPath, { action: "notify", level, message }, 2_000);
  } catch {
    // Recovery must continue when UI is unresponsive.
  }
}

async function recoverOmp(instance, window, rssBytes, snapshot, policy) {
  const key = `omp:${instance.instanceId}`;
  if (recovering.has(key)) return;
  recovering.add(key);
  breachCounts.delete(key);
  cooldowns.set(key, Date.now() + 120_000);
  const gib = (rssBytes / 1024 ** 3).toFixed(1);
  try {
    const ping = await requestSocket(instance.socketPath, { action: "inspect" }, 2_000);
    const current = ping.instance;
    await recordEvent("omp_memory_limit", { instanceId: current.instanceId, alias: current.alias, pid: current.pid, rssBytes, limitBytes: policy.memoryLimitBytes });
    await notifyWindow(window, "warning", `OMP ${current.alias} uses ${gib} GiB. Restarting and resuming its session.`);
    if (!policy.autoRecover) return;
    try {
      await requestSocket(current.socketPath, { action: "interrupt" }, 1_500);
    } catch {
      // Continue with shutdown.
    }
    try {
      await requestSocket(current.socketPath, { action: "shutdown" }, 2_000);
    } catch {
      // Unresponsive OMP is terminated below.
    }
    if (!(await waitForExit(current.pid, 5_000))) await terminateProcessTree(current.pid, snapshot);
    await readInstances({ includeStale: true });
    if (!current.sessionFile) {
      await notifyWindow(window, "error", `OMP ${current.alias} was stopped at ${gib} GiB but had no persisted session to resume.`);
      await recordEvent("omp_resume_unavailable", { instanceId: current.instanceId, alias: current.alias });
      return;
    }
    const owner = window || (await readWindows()).find((candidate) => candidate.workspaceFolders.some((folder) => current.cwd.startsWith(folder)));
    if (!owner) {
      await recordEvent("omp_resume_window_missing", { instanceId: current.instanceId, alias: current.alias, sessionFile: current.sessionFile });
      return;
    }
    const resumed = await requestSocket(
      owner.socketPath,
      {
        action: "resume_omp",
        sessionFile: current.sessionFile,
        alias: current.alias,
        cwd: current.cwd,
        terminalId: current.terminalId,
        reason: `memory recovery after ${gib} GiB`,
      },
      20_000,
    );
    await recordEvent("omp_resumed", { alias: current.alias, sessionFile: current.sessionFile, windowId: owner.windowId, result: resumed.result });
  } catch (error) {
    await recordEvent("omp_recovery_failed", { instanceId: instance.instanceId, alias: instance.alias, error: error.message });
    await notifyWindow(window, "error", `OMP recovery failed for ${instance.alias}: ${error.message}`);
  } finally {
    recovering.delete(key);
  }
}

function workspaceTarget(window) {
  return window.workspaceFile || window.workspaceFolders[0];
}

async function reopenWindows(windows) {
  const codiumPath = process.env.OMP_VSCODE_CLI || "/opt/homebrew/bin/codium";
  for (const window of windows) {
    const target = workspaceTarget(window);
    const args = ["--new-window"];
    if (target) args.push(target);
    const child = cp.spawn(codiumPath, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
}

async function waitForReplacementWindows(previousWindows, timeoutMs = 30_000) {
  const previousIds = new Set(previousWindows.map((window) => window.windowId));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = await readWindows();
    const replacements = windows.filter((window) => !previousIds.has(window.windowId));
    if (replacements.length >= previousWindows.length) return replacements;
    await sleep(500);
  }
  return await readWindows();
}

function matchingWindow(previous, replacements) {
  const target = workspaceTarget(previous);
  return replacements.find((window) => target && (window.workspaceFile === target || window.workspaceFolders.includes(target))) || replacements[0];
}

async function hardRestartApp(appPid, windows, instances, snapshot) {
  await recordEvent("vscode_hard_restart", { appPid, windows: windows.map((window) => window.windowId) });
  const excludedRoots = new Set([process.pid, ...instances.map((instance) => instance.pid)]);
  for (const window of windows) {
    try {
      await requestSocket(window.socketPath, { action: "close_window" }, 3_000);
    } catch {
      // Kill fallback below.
    }
  }
  if (!(await waitForExit(appPid, 5_000))) await terminateProcessTree(appPid, snapshot, excludedRoots);
  await reopenWindows(windows);
  const replacements = await waitForReplacementWindows(windows);
  await sleep(5_000);
  const liveInstances = await readInstances();
  for (const instance of instances) {
    if (!instance.sessionFile || liveInstances.some((candidate) => candidate.sessionFile === instance.sessionFile)) continue;
    const previousWindow = windows.find((window) => window.windowId === instance.windowId);
    const replacement = previousWindow ? matchingWindow(previousWindow, replacements) : replacements[0];
    if (!replacement) continue;
    try {
      await requestSocket(
        replacement.socketPath,
        {
          action: "resume_omp",
          sessionFile: instance.sessionFile,
          alias: instance.alias,
          cwd: instance.cwd,
          terminalId: instance.terminalId,
          reason: "VSCodium memory recovery",
        },
        20_000,
      );
    } catch (error) {
      await recordEvent("vscode_omp_resume_failed", { alias: instance.alias, sessionFile: instance.sessionFile, error: error.message });
    }
  }
}

async function recoverVscodeApp(appPid, windows, instances, rssBytes, snapshot, policy) {
  const key = `app:${appPid}`;
  if (recovering.has(key)) return;
  recovering.add(key);
  breachCounts.delete(key);
  cooldowns.set(key, Date.now() + 60_000);
  const stage = appRecoveryStages.get(appPid);
  const gib = (rssBytes / 1024 ** 3).toFixed(1);
  try {
    if (!policy.autoRecover) {
      for (const window of windows) await notifyWindow(window, "warning", `VSCodium uses ${gib} GiB; automatic recovery is disabled.`);
      return;
    }
    if (!stage || Date.now() - stage.at > 10 * 60_000) {
      await recordEvent("vscode_memory_limit_reload", { appPid, rssBytes, limitBytes: policy.memoryLimitBytes });
      appRecoveryStages.set(appPid, { phase: "reloaded", at: Date.now() });
      for (const window of windows) {
        try {
          await requestSocket(window.socketPath, { action: "reload_window", reason: `memory recovery at ${gib} GiB` }, 3_000);
        } catch {
          // A second breach escalates to hard restart.
        }
      }
      return;
    }
    await hardRestartApp(appPid, windows, instances, snapshot);
    appRecoveryStages.delete(appPid);
    cooldowns.set(key, Date.now() + 5 * 60_000);
  } catch (error) {
    await recordEvent("vscode_recovery_failed", { appPid, error: error.message });
  } finally {
    recovering.delete(key);
  }
}

async function sample() {
  const [windows, instances] = await Promise.all([readWindows(), readInstances()]);
  const snapshot = processSnapshot();
  const windowById = new Map(windows.map((window) => [window.windowId, window]));
  const summaries = [];

  for (const instance of instances) {
    const window = instance.windowId ? windowById.get(instance.windowId) : undefined;
    const policy = policyForWindow(window);
    const tree = processTree(snapshot, instance.pid);
    summaries.push({ kind: "omp", id: instance.instanceId, pid: instance.pid, rssBytes: tree.rssBytes, limitBytes: policy.memoryLimitBytes });
    if (breachReady(`omp:${instance.instanceId}`, tree.rssBytes, policy)) {
      void recoverOmp(instance, window, tree.rssBytes, snapshot, policy);
    }
  }

  const appPids = new Set(windows.map((window) => window.appPid));
  for (const appPid of appPids) {
    const appWindows = windows.filter((window) => window.appPid === appPid);
    const appTree = processTree(snapshot, appPid);
    const appPidSet = new Set(appTree.pids);
    const appInstances = instances.filter((instance) => appPidSet.has(instance.pid));
    const excludedOmpRoots = new Set([process.pid, ...appInstances.map((instance) => instance.pid)]);
    const tree = processTree(snapshot, appPid, excludedOmpRoots);
    const policy = appWindows.map(policyForWindow).sort((left, right) => left.memoryLimitBytes - right.memoryLimitBytes)[0] || policyForWindow();
    summaries.push({ kind: "vscode", id: String(appPid), pid: appPid, rssBytes: tree.rssBytes, limitBytes: policy.memoryLimitBytes });
    if (breachReady(`app:${appPid}`, tree.rssBytes, policy)) {
      void recoverVscodeApp(appPid, appWindows, appInstances, tree.rssBytes, snapshot, policy);
    }
  }

  await writeSupervisorState({ summaries, windows: windows.length, instances: instances.length });
  return windows.map((window) => window.watchdog.pollIntervalMs).sort((left, right) => left - right)[0] || DEFAULT_POLL_MS;
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([fs.rm(SUPERVISOR_FILE, { force: true }), fs.rm(LOCK_FILE, { force: true })]);
}

async function main() {
  globalThis.__OMP_SUPERVISOR_STARTED_AT = new Date().toISOString();
  if (!(await claimSingleton())) return;
  process.once("SIGINT", () => void cleanup().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void cleanup().finally(() => process.exit(0)));
  await recordEvent("supervisor_started", { pid: process.pid });
  while (!shuttingDown) {
    let pollMs = DEFAULT_POLL_MS;
    try {
      pollMs = await sample();
    } catch (error) {
      await recordEvent("sample_failed", { error: error.message });
    }
    await sleep(pollMs);
  }
}

void main();
