import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  createInstanceId,
  ensureControlDirectories,
  instanceSocketPath,
  removeInstanceArtifacts,
  type ControlRequest,
  type ControlResponse,
  type InstanceRecord,
  type SenderIdentity,
  writeInstanceRecord,
} from "../mcp-server/src/protocol.ts";

const MAX_FRAME_BYTES = 1_000_000;
const HEARTBEAT_MS = 5_000;
const GLOBAL_KEY = Symbol.for("omp.control.extension");

interface ProcessControlService {
  attach(token: symbol, pi: ExtensionAPI, context: ExtensionContext): Promise<boolean>;
  update(token: symbol, context: ExtensionContext): Promise<void>;
  detach(token: symbol): Promise<void>;
}

type GlobalWithControl = typeof globalThis & { [GLOBAL_KEY]?: ProcessControlService };

function validateAlias(value: string): string {
  const alias = value.trim();
  const hasControlCharacter = Array.from(alias).some((character) => character < " " || character === "\u007f");
  if (!alias || alias.length > 64 || hasControlCharacter) {
    throw new Error("Alias must contain 1-64 printable characters");
  }
  return alias;
}

function formatRemoteMessage(message: string, sender?: SenderIdentity): string {
  const source = sender
    ? `${sender.alias} (instance ${sender.instanceId}, pid ${sender.pid})`
    : "external OMP control client";
  const reply = sender
    ? `Reply with MCP tool mcp__omp_instances_send using target ${JSON.stringify(sender.instanceId)} when a response is needed.`
    : "No reply address was supplied.";
  return `[OMP inter-instance message from ${source}]\n${reply}\n\n${message}`;
}

function parseControlRequest(value: unknown): ControlRequest {
  if (!value || typeof value !== "object") throw new Error("Control request must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.action === "ping" || candidate.action === "inspect" || candidate.action === "interrupt" || candidate.action === "shutdown") {
    return { action: candidate.action };
  }
  if (candidate.action === "rename") {
    if (typeof candidate.alias !== "string") throw new Error("rename requires alias");
    return { action: "rename", alias: candidate.alias };
  }
  if (candidate.action === "relink") {
    if (typeof candidate.windowId !== "string" || typeof candidate.terminalId !== "string") {
      throw new Error("relink requires windowId and terminalId");
    }
    return { action: "relink", windowId: candidate.windowId, terminalId: candidate.terminalId };
  }
  if (candidate.action === "send") {
    if (typeof candidate.message !== "string") throw new Error("send requires message");
    const delivery = candidate.delivery;
    if (delivery !== undefined && delivery !== "auto" && delivery !== "steer" && delivery !== "followUp") {
      throw new Error("Invalid delivery mode");
    }
    const sender = candidate.sender;
    if (sender !== undefined) {
      if (!sender || typeof sender !== "object") throw new Error("Invalid sender identity");
      const identity = sender as Record<string, unknown>;
      if (
        typeof identity.instanceId !== "string" ||
        typeof identity.alias !== "string" ||
        typeof identity.pid !== "number" ||
        typeof identity.cwd !== "string" ||
        (identity.sessionId !== undefined && typeof identity.sessionId !== "string")
      ) {
        throw new Error("Invalid sender identity");
      }
      return {
        action: "send",
        message: candidate.message,
        delivery,
        sender: {
          instanceId: identity.instanceId,
          alias: identity.alias,
          pid: identity.pid,
          cwd: identity.cwd,
          sessionId: identity.sessionId as string | undefined,
        },
      };
    }
    return { action: "send", message: candidate.message, delivery };
  }
  throw new Error("Unknown control action");
}

function createProcessControlService(): ProcessControlService {
  const instanceId = createInstanceId();
  const socketPath = instanceSocketPath(instanceId);
  const startedAt = new Date().toISOString();
  let ownerToken: symbol | undefined;
  let ownerSessionId: string | undefined;
  let currentContext: ExtensionContext | undefined;
  let currentApi: ExtensionAPI | undefined;
  let alias: string | undefined;
  let server: Server | undefined;
  let starting: Promise<void> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let closing: Promise<void> | undefined;

  const buildRecord = (context: ExtensionContext): InstanceRecord => {
    alias ??= validateAlias(process.env.OMP_INSTANCE_NAME || `${path.basename(context.cwd) || "omp"}-${process.pid}`);
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      instanceId,
      alias,
      pid: process.pid,
      cwd: context.cwd,
      sessionId: context.sessionManager.getSessionId(),
      sessionName: context.sessionManager.getSessionName(),
      sessionFile: context.sessionManager.getSessionFile(),
      model: context.model ? `${context.model.provider}/${context.model.id}` : undefined,
      socketPath,
      status: shuttingDown ? "shutting_down" : context.isIdle() ? "idle" : "busy",
      startedAt,
      updatedAt: new Date().toISOString(),
      profile: process.env.OMP_PROFILE,
      windowId: process.env.OMP_WINDOW_ID,
      terminalId: process.env.OMP_TERMINAL_ID,
    };
  };

  const refresh = async (): Promise<InstanceRecord> => {
    if (!currentContext) throw new Error("OMP root session is not attached");
    const record = buildRecord(currentContext);
    await writeInstanceRecord(record);
    return record;
  };

  const respond = async (request: ControlRequest): Promise<ControlResponse> => {
    const context = currentContext;
    const pi = currentApi;
    if (!context || !pi) return { ok: false, error: "OMP root session is not attached" };
    try {
      if (request.action === "send") {
        if (!request.message.trim()) throw new Error("Message cannot be empty");
        if (Buffer.byteLength(request.message) > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 100 KB limit");
        const options = request.delivery && request.delivery !== "auto" ? { deliverAs: request.delivery } : undefined;
        pi.sendUserMessage(formatRemoteMessage(request.message, request.sender), options);
        return { ok: true, instance: await refresh(), result: { accepted: true, delivery: request.delivery ?? "auto" } };
      }
      if (request.action === "rename") {
        alias = validateAlias(request.alias);
        return { ok: true, instance: await refresh(), result: { renamed: true } };
      }
      if (request.action === "relink") {
        process.env.OMP_WINDOW_ID = request.windowId;
        process.env.OMP_TERMINAL_ID = request.terminalId;
        return { ok: true, instance: await refresh(), result: { relinked: true } };
      }
      if (request.action === "interrupt") {
        const wasIdle = context.isIdle();
        if (!wasIdle) context.abort();
        return { ok: true, instance: await refresh(), result: { interrupted: !wasIdle } };
      }
      if (request.action === "shutdown") {
        shuttingDown = true;
        const instance = await refresh();
        setTimeout(() => context.shutdown(), 25);
        return { ok: true, instance, result: { shuttingDown: true } };
      }
      return { ok: true, instance: await refresh() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const handleSocket = (socket: Socket) => {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: "Request exceeds frame limit" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      socket.pause();
      void (async () => {
        let response: ControlResponse;
        try {
          response = await respond(parseControlRequest(JSON.parse(buffer.slice(0, newline))));
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
    socket.on("error", () => {});
  };

  const start = (): Promise<void> => {
    starting ??= (async () => {
      await ensureControlDirectories();
      await rm(socketPath, { force: true });
      const controlServer = createServer(handleSocket);
      server = controlServer;
      await new Promise<void>((resolve, reject) => {
        controlServer.once("error", reject);
        controlServer.listen(socketPath, () => {
          controlServer.off("error", reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o600);
      await refresh();
      heartbeat = setInterval(() => {
        void refresh().catch((error) => currentApi?.logger.warn("OMP control heartbeat failed", { error }));
      }, HEARTBEAT_MS);
      heartbeat.unref();
      currentApi?.logger.debug("OMP control instance registered", { instanceId, socketPath });
    })();
    return starting;
  };

  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearInterval(heartbeat);
      heartbeat = undefined;
      const activeServer = server;
      server = undefined;
      if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      await removeInstanceArtifacts({ instanceId, socketPath });
      const globalControl = globalThis as GlobalWithControl;
      if (globalControl[GLOBAL_KEY] === service) delete globalControl[GLOBAL_KEY];
    })();
    return closing;
  };

  const service: ProcessControlService = {
    async attach(token, pi, context) {
      const sessionId = context.sessionManager.getSessionId();
      if (ownerToken !== undefined && ownerSessionId !== sessionId) return false;
      ownerToken = token;
      ownerSessionId = sessionId;
      currentApi = pi;
      currentContext = context;
      await start();
      await refresh();
      return true;
    },
    async update(token, context) {
      if (token !== ownerToken) return;
      currentContext = context;
      ownerSessionId = context.sessionManager.getSessionId();
      await refresh();
    },
    async detach(token) {
      if (token !== ownerToken) return;
      shuttingDown = true;
      await close();
    },
  };
  return service;
}

export default function ompControlExtension(pi: ExtensionAPI) {
  const token = Symbol("omp-control-owner");
  const globalControl = globalThis as GlobalWithControl;
  let control = globalControl[GLOBAL_KEY];
  if (!control) {
    control = createProcessControlService();
    globalControl[GLOBAL_KEY] = control;
  }

  pi.on("session_start", async (_event, context) => {
    await control.attach(token, pi, context);
  });
  pi.on("session_switch", async (_event, context) => control.update(token, context));
  pi.on("session_branch", async (_event, context) => control.update(token, context));
  pi.on("session_tree", async (_event, context) => control.update(token, context));
  pi.on("agent_start", async (_event, context) => control.update(token, context));
  pi.on("agent_end", async (_event, context) => control.update(token, context));
  pi.on("turn_start", async (_event, context) => control.update(token, context));
  pi.on("turn_end", async (_event, context) => control.update(token, context));
  pi.on("session_shutdown", async () => {
    await control.detach(token);
  });
}
