import { chmod, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  cancelPendingReply,
  createPendingReply,
  createCorrelationId,
  getControlRoot,
  isProcessAlive,
  type InstanceRecord,
  readInstanceRecords,
  removeInstanceArtifacts,
  requestInstance,
  senderIdentity,
  waitForCorrelatedReply,
  writeCorrelatedReply,
  type ControlRequest,
} from "./protocol.ts";
import { defaultCodiumPath, expandHome, readSupervisorState, readWindowRecords, requestWindow, type WindowRecord } from "./windows.ts";

interface DiscoveredInstance extends InstanceRecord {
  reachable: boolean;
  error?: string;
}

interface DiscoveredWindow extends WindowRecord {
  reachable: boolean;
  error?: string;
}

const server = new McpServer({ name: "omp-instances", version: "1.1.0" });

function result(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

async function discoverInstances(): Promise<DiscoveredInstance[]> {
  const records = await readInstanceRecords();
  const discovered = await Promise.all(
    records.map(async (record): Promise<DiscoveredInstance | undefined> => {
      try {
        let response;
        try {
          response = await requestInstance(record, { action: "ping" }, 1_500);
        } catch {
          await Bun.sleep(150);
          response = await requestInstance(record, { action: "ping" }, 3_000);
        }
        if (!response.ok) return { ...record, reachable: false, error: response.error };
        return { ...response.instance, reachable: true };
      } catch (error) {
        if (!isProcessAlive(record.pid)) {
          await removeInstanceArtifacts(record);
          return undefined;
        }
        return { ...record, reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return discovered
    .filter((record): record is DiscoveredInstance => record !== undefined)
    .sort((left, right) => left.alias.localeCompare(right.alias) || left.pid - right.pid);
}

async function discoverWindows(): Promise<DiscoveredWindow[]> {
  const records = await readWindowRecords();
  return await Promise.all(
    records.map(async (record): Promise<DiscoveredWindow> => {
      try {
        let response;
        try {
          response = await requestWindow(record, { action: "ping" }, 1_500);
        } catch {
          await Bun.sleep(150);
          response = await requestWindow(record, { action: "ping" }, 3_000);
        }
        if (!response.ok) return { ...record, reachable: false, error: response.error };
        return { ...response.window, reachable: true };
      } catch (error) {
        return { ...record, reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

function resolveTarget(instances: DiscoveredInstance[], selector: string): DiscoveredInstance {
  const normalized = selector.toLocaleLowerCase();
  const exact = instances.filter(
    (record) =>
      record.instanceId === selector ||
      record.alias.toLocaleLowerCase() === normalized ||
      String(record.pid) === selector ||
      record.sessionId === selector ||
      record.terminalId === selector,
  );
  const matches =
    exact.length > 0
      ? exact
      : instances.filter(
          (record) => record.instanceId.startsWith(selector) || Boolean(record.sessionId?.startsWith(selector)) || Boolean(record.terminalId?.startsWith(selector)),
        );
  if (matches.length === 0) throw new Error(`No running OMP instance matches ${JSON.stringify(selector)}`);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous OMP instance ${JSON.stringify(selector)}; candidates: ${matches.map((record) => `${record.alias} (${record.instanceId})`).join(", ")}`,
    );
  }
  const target = matches[0];
  if (!target) throw new Error(`No running OMP instance matches ${JSON.stringify(selector)}`);
  if (!target.reachable) throw new Error(`OMP instance ${target.alias} is unreachable: ${target.error ?? "unknown error"}`);
  return target;
}

function resolveWindow(windows: DiscoveredWindow[], selector: string): DiscoveredWindow {
  const normalized = selector.toLocaleLowerCase();
  const exact = windows.filter(
    (record) =>
      record.windowId === selector ||
      record.label.toLocaleLowerCase() === normalized ||
      String(record.pid) === selector ||
      String(record.appPid) === selector ||
      record.workspaceFolders.some((folder) => folder === expandHome(selector)),
  );
  const matches = exact.length > 0 ? exact : windows.filter((record) => record.windowId.startsWith(selector));
  if (matches.length === 0) throw new Error(`No VS Code window matches ${JSON.stringify(selector)}`);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous VS Code window ${JSON.stringify(selector)}; candidates: ${matches.map((record) => `${record.label} (${record.windowId})`).join(", ")}`,
    );
  }
  const target = matches[0];
  if (!target) throw new Error(`No VS Code window matches ${JSON.stringify(selector)}`);
  if (!target.reachable) throw new Error(`VS Code window ${target.label} is unreachable: ${target.error ?? "unknown error"}`);
  return target;
}

function inferCaller(instances: DiscoveredInstance[]): DiscoveredInstance | undefined {
  return instances.find((record) => record.pid === process.ppid);
}

function callerWindow(windows: DiscoveredWindow[], caller: DiscoveredInstance | undefined): DiscoveredWindow | undefined {
  return caller?.windowId ? windows.find((record) => record.windowId === caller.windowId && record.reachable) : undefined;
}

async function callTarget(target: DiscoveredInstance, request: ControlRequest) {
  const response = await requestInstance(target, request);
  if (!response.ok) throw new Error(response.error);
  return response;
}

async function callWindow(target: DiscoveredWindow, request: Parameters<typeof requestWindow>[1]) {
  const response = await requestWindow(target, request, 30_000);
  if (!response.ok) throw new Error(response.error);
  return response;
}

server.registerTool(
  "list",
  {
    title: "List OMP instances",
    description: "List every live OMP process, its owning VS Code window/terminal, session, model, cwd, and busy/idle state.",
    inputSchema: { include_unreachable: z.boolean().default(true) },
    annotations: { readOnlyHint: true },
  },
  async ({ include_unreachable }) => {
    const [instances, windows] = await Promise.all([discoverInstances(), discoverWindows()]);
    const visible = include_unreachable ? instances : instances.filter((instance) => instance.reachable);
    const enriched = visible.map((instance) => ({
      ...instance,
      window: windows.find((window) => window.windowId === instance.windowId),
    }));
    return result({ count: enriched.length, callerPid: process.ppid, instances: enriched });
  },
);

server.registerTool(
  "list_windows",
  {
    title: "List VS Code windows",
    description: "List every OMP Instances-managed VS Code/VSCodium window, workspace, terminal tab, watchdog policy, and attached OMP process.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const [windows, instances] = await Promise.all([discoverWindows(), discoverInstances()]);
    return result({
      count: windows.length,
      windows: windows.map((window) => ({
        ...window,
        instances: instances.filter((instance) => instance.windowId === window.windowId),
      })),
      unattachedInstances: instances.filter((instance) => !instance.windowId || !windows.some((window) => window.windowId === instance.windowId)),
    });
  },
);

server.registerTool(
  "inspect",
  {
    title: "Inspect OMP instance",
    description: "Read current metadata for one OMP process. Target accepts alias, PID, instance/session/terminal ID or prefix.",
    inputSchema: { target: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ target }) => {
    const response = await callTarget(resolveTarget(await discoverInstances(), target), { action: "inspect" });
    return result({ instance: response.instance });
  },
);

server.registerTool(
  "send",
  {
    title: "Send message to OMP instance",
    description: "Send an inter-instance message. Idle recipient starts a turn; busy recipient receives steer or follow-up delivery.",
    inputSchema: {
      target: z.string().min(1),
      message: z.string().min(1).max(100_000),
      delivery: z.enum(["auto", "steer", "followUp"]).default("auto"),
    },
  },
  async ({ target, message, delivery }) => {
    const instances = await discoverInstances();
    const recipient = resolveTarget(instances, target);
    const caller = inferCaller(instances);
    const response = await callTarget(recipient, {
      action: "send",
      message,
      delivery,
      sender: caller ? senderIdentity(caller) : undefined,
    });
    return result({ delivered: true, recipient: response.instance, sender: caller ? senderIdentity(caller) : undefined });
  },
);

server.registerTool(
  "ask",
  {
    title: "Ask OMP and await reply",
    description: "Send a correlated question to one OMP instance and block until it replies through the reply tool or timeout.",
    inputSchema: {
      target: z.string().min(1),
      question: z.string().min(1).max(100_000),
      timeout_seconds: z.number().int().min(1).max(600).default(120),
      delivery: z.enum(["auto", "steer", "followUp"]).default("auto"),
    },
  },
  async ({ target, question, timeout_seconds, delivery }) => {
    const instances = await discoverInstances();
    const recipient = resolveTarget(instances, target);
    const caller = inferCaller(instances);
    const correlationId = createCorrelationId();
    await createPendingReply(correlationId);
    const prompt = [
      "[OMP correlated request]",
      `Correlation ID: ${correlationId}`,
      "Answer by calling MCP tool mcp__omp_instances_reply with this exact correlation_id and your final response in message.",
      "Do not only answer in chat; caller is blocked waiting for the tool reply.",
      "",
      question,
    ].join("\n");
    try {
      await callTarget(recipient, {
        action: "send",
        message: prompt,
        delivery,
        sender: caller ? senderIdentity(caller) : undefined,
      });
      const reply = await waitForCorrelatedReply(correlationId, timeout_seconds * 1_000);
      return result({ correlationId, recipient: senderIdentity(recipient), reply });
    } catch (error) {
      await cancelPendingReply(correlationId);
      throw error;
    }
  },
);

server.registerTool(
  "reply",
  {
    title: "Reply to correlated OMP request",
    description: "Complete a pending ask call using the exact correlation ID included in the received request.",
    inputSchema: {
      correlation_id: z.string().uuid(),
      message: z.string().min(1).max(100_000),
    },
  },
  async ({ correlation_id, message }) => {
    const instances = await discoverInstances();
    const caller = inferCaller(instances);
    await writeCorrelatedReply({
      correlationId: correlation_id,
      message,
      responder: caller ? senderIdentity(caller) : undefined,
      repliedAt: new Date().toISOString(),
    });
    return result({ delivered: true, correlationId: correlation_id });
  },
);

server.registerTool(
  "broadcast",
  {
    title: "Broadcast to OMP instances",
    description: "Send one message to every reachable OMP process, optionally excluding caller or restricting to one VS Code window.",
    inputSchema: {
      message: z.string().min(1).max(100_000),
      delivery: z.enum(["auto", "steer", "followUp"]).default("auto"),
      exclude_self: z.boolean().default(true),
      window: z.string().min(1).optional(),
    },
  },
  async ({ message, delivery, exclude_self, window }) => {
    const [instances, windows] = await Promise.all([discoverInstances(), discoverWindows()]);
    const caller = inferCaller(instances);
    const windowId = window ? resolveWindow(windows, window).windowId : undefined;
    const recipients = instances.filter(
      (instance) => instance.reachable && !(exclude_self && caller?.instanceId === instance.instanceId) && (!windowId || instance.windowId === windowId),
    );
    const deliveries = await Promise.all(
      recipients.map(async (recipient) => {
        try {
          await callTarget(recipient, {
            action: "send",
            message,
            delivery,
            sender: caller ? senderIdentity(caller) : undefined,
          });
          return { instanceId: recipient.instanceId, alias: recipient.alias, delivered: true };
        } catch (error) {
          return { instanceId: recipient.instanceId, alias: recipient.alias, delivered: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    return result({ recipients: deliveries.length, deliveries });
  },
);

server.registerTool(
  "open_window",
  {
    title: "Open VS Code window",
    description: "Open a new VSCodium window for a workspace and wait for OMP Instances registration.",
    inputSchema: { workspace: z.string().min(1), timeout_seconds: z.number().int().min(1).max(30).default(15) },
  },
  async ({ workspace, timeout_seconds }) => {
    const resolvedWorkspace = expandHome(workspace);
    const before = new Set((await readWindowRecords()).map((window) => window.windowId));
    Bun.spawn([defaultCodiumPath(), "--new-window", resolvedWorkspace], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    const deadline = Date.now() + timeout_seconds * 1_000;
    while (Date.now() < deadline) {
      await Bun.sleep(250);
      const created = (await discoverWindows()).find(
        (window) => !before.has(window.windowId) && window.reachable && window.workspaceFolders.includes(resolvedWorkspace),
      );
      if (created) return result({ opened: true, window: created });
    }
    return result({ opened: true, registered: false, workspace: resolvedWorkspace });
  },
);

server.registerTool(
  "create_omp",
  {
    title: "Create OMP terminal tab",
    description: "Create a named OMP terminal tab in a specific VS Code window. Omit window to use caller's window when known.",
    inputSchema: {
      alias: z.string().min(1).max(64),
      window: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
      initial_message: z.string().min(1).max(100_000).optional(),
    },
  },
  async ({ alias, window, cwd, initial_message }) => {
    const [windows, instances] = await Promise.all([discoverWindows(), discoverInstances()]);
    const owner = window ? resolveWindow(windows, window) : callerWindow(windows, inferCaller(instances));
    if (!owner) throw new Error("Caller VS Code window is unknown; pass window explicitly from list_windows");
    const response = await callWindow(owner, { action: "create_omp", alias, cwd: cwd ? expandHome(cwd) : undefined, initialMessage: initial_message });
    return result({ created: true, window: response.window, ...response.result });
  },
);

server.registerTool(
  "launch_team",
  {
    title: "Launch OMP team",
    description: "Create several independent OMP terminal tabs in one VS Code window, each with its own alias and initial assignment.",
    inputSchema: {
      window: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
      agents: z.array(z.object({ alias: z.string().min(1).max(64), message: z.string().min(1).max(100_000) })).min(1).max(16),
    },
  },
  async ({ window, cwd, agents }) => {
    const [windows, instances] = await Promise.all([discoverWindows(), discoverInstances()]);
    const owner = window ? resolveWindow(windows, window) : callerWindow(windows, inferCaller(instances));
    if (!owner) throw new Error("Caller VS Code window is unknown; pass window explicitly from list_windows");
    const created = [];
    for (const agent of agents) {
      const response = await callWindow(owner, {
        action: "create_omp",
        alias: agent.alias,
        cwd: cwd ? expandHome(cwd) : undefined,
        initialMessage: agent.message,
      });
      created.push(response.result);
    }
    return result({ count: created.length, windowId: owner.windowId, created });
  },
);

server.registerTool(
  "resume_omp",
  {
    title: "Resume OMP session",
    description: "Open a terminal tab that resumes a persisted OMP session file in a selected VS Code window.",
    inputSchema: {
      session_file: z.string().min(1),
      alias: z.string().min(1).max(64).optional(),
      window: z.string().min(1),
      cwd: z.string().min(1).optional(),
    },
  },
  async ({ session_file, alias, window, cwd }) => {
    const owner = resolveWindow(await discoverWindows(), window);
    const response = await callWindow(owner, {
      action: "resume_omp",
      sessionFile: expandHome(session_file),
      alias,
      cwd: cwd ? expandHome(cwd) : undefined,
    });
    return result({ resumed: true, window: response.window, ...response.result });
  },
);

server.registerTool(
  "focus",
  {
    title: "Focus OMP terminal tab",
    description: "Reveal the terminal tab that owns one OMP instance, including tabs in another VS Code window.",
    inputSchema: { target: z.string().min(1) },
  },
  async ({ target }) => {
    const [instances, windows] = await Promise.all([discoverInstances(), discoverWindows()]);
    const instance = resolveTarget(instances, target);
    if (!instance.windowId || !instance.terminalId) throw new Error(`OMP instance ${instance.alias} is not attached to a VS Code terminal`);
    const owner = resolveWindow(windows, instance.windowId);
    const response = await callWindow(owner, { action: "focus_omp", terminalId: instance.terminalId });
    return result({ focused: true, instance, window: response.window });
  },
);

server.registerTool(
  "rename",
  {
    title: "Rename OMP instance",
    description: "Assign a human-friendly alias to an OMP process. Omit target to rename caller process.",
    inputSchema: { alias: z.string().min(1).max(64), target: z.string().min(1).optional() },
  },
  async ({ alias, target }) => {
    const instances = await discoverInstances();
    const recipient = target ? resolveTarget(instances, target) : inferCaller(instances);
    if (!recipient) throw new Error("Caller OMP process could not be identified; pass target explicitly");
    const response = await callTarget(recipient, { action: "rename", alias });
    return result({ renamed: true, instance: response.instance });
  },
);

server.registerTool(
  "doctor",
  {
    title: "Diagnose OMP orchestration",
    description: "Check registry permissions, sockets, aliases, window ownership, supervisor freshness, and orphan artifacts. fix only repairs permissions and stale files.",
    inputSchema: { fix: z.boolean().default(false) },
  },
  async ({ fix }) => {
    const root = getControlRoot();
    const directories = [root, path.join(root, "instances"), path.join(root, "sockets"), path.join(root, "windows"), path.join(root, "window-sockets"), path.join(root, "replies")];
    const issues: Array<Record<string, unknown>> = [];
    for (const directory of directories) {
      try {
        const mode = (await stat(directory)).mode & 0o777;
        if (mode !== 0o700) {
          issues.push({ kind: "permission", path: directory, expected: "0700", actual: mode.toString(8), fixed: fix });
          if (fix) await chmod(directory, 0o700);
        }
      } catch (error) {
        issues.push({ kind: "missing_directory", path: directory, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const [instances, windows, supervisor] = await Promise.all([discoverInstances(), discoverWindows(), readSupervisorState()]);
    const aliases = new Map<string, string[]>();
    const terminalOwners = new Map<string, string[]>();
    for (const instance of instances) {
      const normalized = instance.alias.toLocaleLowerCase();
      aliases.set(normalized, [...(aliases.get(normalized) ?? []), instance.instanceId]);
      if (instance.terminalId) terminalOwners.set(instance.terminalId, [...(terminalOwners.get(instance.terminalId) ?? []), instance.instanceId]);
      if (!instance.reachable) issues.push({ kind: "unreachable_instance", instanceId: instance.instanceId, alias: instance.alias, error: instance.error });
      if (instance.windowId && !windows.some((window) => window.windowId === instance.windowId)) {
        issues.push({ kind: "missing_owner_window", instanceId: instance.instanceId, alias: instance.alias, windowId: instance.windowId });
      }
      const mode = (await stat(instance.socketPath)).mode & 0o777;
      if (mode !== 0o600) {
        issues.push({ kind: "permission", path: instance.socketPath, expected: "0600", actual: mode.toString(8), fixed: fix });
        if (fix) await chmod(instance.socketPath, 0o600);
      }
    }
    for (const [alias, ids] of aliases) if (ids.length > 1) issues.push({ kind: "duplicate_alias", alias, instanceIds: ids });
    for (const [terminalId, ids] of terminalOwners) if (ids.length > 1) issues.push({ kind: "duplicate_terminal_id", terminalId, instanceIds: ids });
    for (const window of windows) {
      if (!window.reachable) issues.push({ kind: "unreachable_window", windowId: window.windowId, label: window.label, error: window.error });
      const mode = (await stat(window.socketPath)).mode & 0o777;
      if (mode !== 0o600) {
        issues.push({ kind: "permission", path: window.socketPath, expected: "0600", actual: mode.toString(8), fixed: fix });
        if (fix) await chmod(window.socketPath, 0o600);
      }
    }
    if (!supervisor || !isProcessAlive(supervisor.pid)) issues.push({ kind: "supervisor_down" });
    else if (Date.now() - Date.parse(supervisor.updatedAt) > 90_000) issues.push({ kind: "supervisor_stale", pid: supervisor.pid, updatedAt: supervisor.updatedAt });

    const liveSockets = new Set([...instances.map((instance) => instance.socketPath), ...windows.map((window) => window.socketPath)]);
    for (const directory of [path.join(root, "sockets"), path.join(root, "window-sockets")]) {
      for (const name of await readdir(directory)) {
        const socketPath = path.join(directory, name);
        if (!liveSockets.has(socketPath)) {
          issues.push({ kind: "orphan_socket", path: socketPath, fixed: fix });
          if (fix) await rm(socketPath, { force: true });
        }
      }
    }
    for (const name of await readdir(path.join(root, "replies"))) {
      const replyFile = path.join(root, "replies", name);
      if (Date.now() - (await stat(replyFile)).mtimeMs > 10 * 60_000) {
        issues.push({ kind: "stale_reply", path: replyFile, fixed: fix });
        if (fix) await rm(replyFile, { force: true });
      }
    }
    return result({ ok: issues.length === 0, fixed: fix, issues, instances: instances.length, windows: windows.length, supervisor });
  },
);

server.registerTool(
  "watchdog_status",
  {
    title: "Read memory watchdog status",
    description: "Read detached supervisor heartbeat and aggregate RSS/limit for every OMP and VSCodium process tree.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const state = await readSupervisorState();
    return result({ running: Boolean(state && isProcessAlive(state.pid)), state });
  },
);

server.registerTool(
  "restart",
  {
    title: "Restart and resume OMP instance",
    description: "Gracefully stop one OMP process and resume its persisted session in the same VS Code terminal identity.",
    inputSchema: { target: z.string().min(1), reason: z.string().max(500).default("manual MCP restart") },
    annotations: { destructiveHint: true },
  },
  async ({ target, reason }) => {
    const [instances, windows] = await Promise.all([discoverInstances(), discoverWindows()]);
    const instance = resolveTarget(instances, target);
    if (!instance.sessionFile) throw new Error(`OMP instance ${instance.alias} has no persisted session to resume`);
    if (!instance.windowId) throw new Error(`OMP instance ${instance.alias} is not attached to a VS Code window`);
    const owner = resolveWindow(windows, instance.windowId);
    try {
      await callTarget(instance, { action: "interrupt" });
    } catch {
      // Continue with shutdown.
    }
    try {
      await callTarget(instance, { action: "shutdown" });
    } catch {
      // VS Code resume will start a replacement even if the old process is unresponsive.
    }
    let deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isProcessAlive(instance.pid)) await Bun.sleep(200);
    if (isProcessAlive(instance.pid)) process.kill(instance.pid, "SIGTERM");
    deadline = Date.now() + 3_000;
    while (Date.now() < deadline && isProcessAlive(instance.pid)) await Bun.sleep(200);
    if (isProcessAlive(instance.pid)) process.kill(instance.pid, "SIGKILL");
    deadline = Date.now() + 1_000;
    while (Date.now() < deadline && isProcessAlive(instance.pid)) await Bun.sleep(100);
    if (isProcessAlive(instance.pid)) throw new Error(`OMP instance ${instance.alias} did not exit`);
    const response = await callWindow(owner, {
      action: "resume_omp",
      sessionFile: instance.sessionFile,
      alias: instance.alias,
      cwd: instance.cwd,
      terminalId: instance.terminalId,
      reason,
    });
    return result({ restarted: true, previousInstance: instance, window: response.window, ...response.result });
  },
);

server.registerTool(
  "interrupt",
  {
    title: "Interrupt OMP instance",
    description: "Abort current model/tool operation in one OMP process without exiting it.",
    inputSchema: { target: z.string().min(1) },
    annotations: { destructiveHint: true },
  },
  async ({ target }) => {
    const response = await callTarget(resolveTarget(await discoverInstances(), target), { action: "interrupt" });
    return result({ instance: response.instance, ...response.result });
  },
);

server.registerTool(
  "shutdown",
  {
    title: "Shut down OMP instance",
    description: "Gracefully terminate one running OMP process. Its persisted session can be resumed later.",
    inputSchema: { target: z.string().min(1) },
    annotations: { destructiveHint: true },
  },
  async ({ target }) => {
    const response = await callTarget(resolveTarget(await discoverInstances(), target), { action: "shutdown" });
    return result({ instance: response.instance, ...response.result });
  },
);

server.registerTool(
  "show_dashboard",
  {
    title: "Show OMP Orchestrator dashboard",
    description: "Reveal Fleet and Health & Recovery views in a selected VS Code window.",
    inputSchema: { window: z.string().min(1) },
  },
  async ({ window }) => {
    const response = await callWindow(resolveWindow(await discoverWindows(), window), { action: "show_dashboard" });
    return result({ shown: true, window: response.window });
  },
);

server.registerTool(
  "reload_window",
  {
    title: "Reload VS Code window",
    description: "Save files and reload one VS Code window. OMP Instances relinks surviving OMP terminal processes after reload.",
    inputSchema: { window: z.string().min(1), reason: z.string().max(500).optional() },
    annotations: { destructiveHint: true },
  },
  async ({ window, reason }) => {
    const response = await callWindow(resolveWindow(await discoverWindows(), window), { action: "reload_window", reason });
    return result({ reloading: true, window: response.window });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

const close = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
