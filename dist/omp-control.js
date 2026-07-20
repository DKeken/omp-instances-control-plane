// @bun
// packages/omp-extension/omp-control.ts
import { chmod as chmod2, rm as rm2 } from "fs/promises";
import path2 from "path";
import { createServer } from "net";

// packages/mcp-server/src/protocol.ts
import { randomUUID } from "crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
var CONTROL_PROTOCOL_VERSION = 1;
var MAX_MESSAGE_BYTES = 1e5;
function getControlRoot() {
  const configured = process.env.OMP_CONTROL_DIR?.trim();
  if (configured)
    return path.resolve(configured.replace(/^~(?=$|\/)/, homedir()));
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join("/tmp", `omp-control-${uid}`);
}
function createInstanceId() {
  return randomUUID();
}
function instanceRecordPath(instanceId) {
  return path.join(getControlRoot(), "instances", `${instanceId}.json`);
}
function instanceSocketPath(instanceId) {
  const socketPath = path.join(getControlRoot(), "sockets", `${instanceId}.sock`);
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error(`OMP control socket path is too long: ${socketPath}`);
  }
  return socketPath;
}
async function ensureControlDirectories() {
  const root = getControlRoot();
  await mkdir(path.join(root, "instances"), { recursive: true, mode: 448 });
  await mkdir(path.join(root, "sockets"), { recursive: true, mode: 448 });
  await Promise.all([
    chmod(root, 448),
    chmod(path.join(root, "instances"), 448),
    chmod(path.join(root, "sockets"), 448)
  ]);
  await mkdir(path.join(root, "replies"), { recursive: true, mode: 448 });
  await chmod(path.join(root, "replies"), 448);
}
async function writeInstanceRecord(record) {
  await ensureControlDirectories();
  const target = instanceRecordPath(record.instanceId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}
`, { encoding: "utf8", mode: 384 });
  await rename(temporary, target);
  await chmod(target, 384);
}
async function removeInstanceArtifacts(record, removeSocket = true) {
  await rm(instanceRecordPath(record.instanceId), { force: true });
  if (removeSocket)
    await rm(record.socketPath, { force: true });
}

// packages/omp-extension/omp-control.ts
var MAX_FRAME_BYTES = 1e6;
var HEARTBEAT_MS = 5000;
var GLOBAL_KEY = Symbol.for("omp.control.extension");
function validateAlias(value) {
  const alias = value.trim();
  const hasControlCharacter = Array.from(alias).some((character) => character < " " || character === "\x7F");
  if (!alias || alias.length > 64 || hasControlCharacter) {
    throw new Error("Alias must contain 1-64 printable characters");
  }
  return alias;
}
function formatRemoteMessage(message, sender) {
  const source = sender ? `${sender.alias} (instance ${sender.instanceId}, pid ${sender.pid})` : "external OMP control client";
  const reply = sender ? `Reply with MCP tool mcp__omp_instances_send using target ${JSON.stringify(sender.instanceId)} when a response is needed.` : "No reply address was supplied.";
  return `[OMP inter-instance message from ${source}]
${reply}

${message}`;
}
function parseControlRequest(value) {
  if (!value || typeof value !== "object")
    throw new Error("Control request must be an object");
  const candidate = value;
  if (candidate.action === "ping" || candidate.action === "inspect" || candidate.action === "interrupt" || candidate.action === "shutdown") {
    return { action: candidate.action };
  }
  if (candidate.action === "rename") {
    if (typeof candidate.alias !== "string")
      throw new Error("rename requires alias");
    return { action: "rename", alias: candidate.alias };
  }
  if (candidate.action === "relink") {
    if (typeof candidate.windowId !== "string" || typeof candidate.terminalId !== "string") {
      throw new Error("relink requires windowId and terminalId");
    }
    return { action: "relink", windowId: candidate.windowId, terminalId: candidate.terminalId };
  }
  if (candidate.action === "send") {
    if (typeof candidate.message !== "string")
      throw new Error("send requires message");
    const delivery = candidate.delivery;
    if (delivery !== undefined && delivery !== "auto" && delivery !== "steer" && delivery !== "followUp") {
      throw new Error("Invalid delivery mode");
    }
    const sender = candidate.sender;
    if (sender !== undefined) {
      if (!sender || typeof sender !== "object")
        throw new Error("Invalid sender identity");
      const identity = sender;
      if (typeof identity.instanceId !== "string" || typeof identity.alias !== "string" || typeof identity.pid !== "number" || typeof identity.cwd !== "string" || identity.sessionId !== undefined && typeof identity.sessionId !== "string") {
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
          sessionId: identity.sessionId
        }
      };
    }
    return { action: "send", message: candidate.message, delivery };
  }
  throw new Error("Unknown control action");
}
function createProcessControlService() {
  const instanceId = createInstanceId();
  const socketPath = instanceSocketPath(instanceId);
  const startedAt = new Date().toISOString();
  let ownerToken;
  let ownerSessionId;
  let currentContext;
  let currentApi;
  let alias;
  let server;
  let starting;
  let heartbeat;
  let shuttingDown = false;
  let closing;
  const buildRecord = (context) => {
    alias ??= validateAlias(process.env.OMP_INSTANCE_NAME || `${path2.basename(context.cwd) || "omp"}-${process.pid}`);
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
      terminalId: process.env.OMP_TERMINAL_ID
    };
  };
  const refresh = async () => {
    if (!currentContext)
      throw new Error("OMP root session is not attached");
    const record = buildRecord(currentContext);
    await writeInstanceRecord(record);
    return record;
  };
  const respond = async (request) => {
    const context = currentContext;
    const pi = currentApi;
    if (!context || !pi)
      return { ok: false, error: "OMP root session is not attached" };
    try {
      if (request.action === "send") {
        if (!request.message.trim())
          throw new Error("Message cannot be empty");
        if (Buffer.byteLength(request.message) > MAX_MESSAGE_BYTES)
          throw new Error("Message exceeds 100 KB limit");
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
        if (!wasIdle)
          context.abort();
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
  const handleSocket = (socket) => {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (handled)
        return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: "Request exceeds frame limit" })}
`);
        return;
      }
      const newline = buffer.indexOf(`
`);
      if (newline < 0)
        return;
      handled = true;
      socket.pause();
      (async () => {
        let response;
        try {
          response = await respond(parseControlRequest(JSON.parse(buffer.slice(0, newline))));
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        socket.end(`${JSON.stringify(response)}
`);
      })();
    });
    socket.on("error", () => {});
  };
  const start = () => {
    starting ??= (async () => {
      await ensureControlDirectories();
      await rm2(socketPath, { force: true });
      const controlServer = createServer(handleSocket);
      server = controlServer;
      await new Promise((resolve, reject) => {
        controlServer.once("error", reject);
        controlServer.listen(socketPath, () => {
          controlServer.off("error", reject);
          resolve();
        });
      });
      await chmod2(socketPath, 384);
      await refresh();
      heartbeat = setInterval(() => {
        refresh().catch((error) => currentApi?.logger.warn("OMP control heartbeat failed", { error }));
      }, HEARTBEAT_MS);
      heartbeat.unref();
      currentApi?.logger.debug("OMP control instance registered", { instanceId, socketPath });
    })();
    return starting;
  };
  const close = () => {
    closing ??= (async () => {
      clearInterval(heartbeat);
      heartbeat = undefined;
      const activeServer = server;
      server = undefined;
      if (activeServer)
        await new Promise((resolve) => activeServer.close(() => resolve()));
      await removeInstanceArtifacts({ instanceId, socketPath });
      const globalControl = globalThis;
      if (globalControl[GLOBAL_KEY] === service)
        delete globalControl[GLOBAL_KEY];
    })();
    return closing;
  };
  const service = {
    async attach(token, pi, context) {
      const sessionId = context.sessionManager.getSessionId();
      if (ownerToken !== undefined && ownerSessionId !== sessionId)
        return false;
      ownerToken = token;
      ownerSessionId = sessionId;
      currentApi = pi;
      currentContext = context;
      await start();
      await refresh();
      return true;
    },
    async update(token, context) {
      if (token !== ownerToken)
        return;
      currentContext = context;
      ownerSessionId = context.sessionManager.getSessionId();
      await refresh();
    },
    async detach(token) {
      if (token !== ownerToken)
        return;
      shuttingDown = true;
      await close();
    }
  };
  return service;
}
function ompControlExtension(pi) {
  const token = Symbol("omp-control-owner");
  const globalControl = globalThis;
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
export {
  ompControlExtension as default
};
