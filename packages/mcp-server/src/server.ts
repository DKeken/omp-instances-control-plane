import { chmod, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  cancelPendingReply,
  createCorrelationId,
  createPendingReply,
  getControlRoot,
  isProcessAlive,
  type ControlRequest,
  type ControlResponse,
  type InstanceRecord,
  readInstanceRecords,
  removeInstanceArtifacts,
  requestInstance,
  senderIdentity,
  waitForCorrelatedReply,
  writeCorrelatedReply,
} from "./protocol.ts";

interface DiscoveredInstance extends InstanceRecord {
  reachable: boolean;
  error?: string;
}

const server = new McpServer({ name: "omp-instances", version: "2.0.0" });

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
        let response: ControlResponse;
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

function resolveTarget(instances: DiscoveredInstance[], selector: string): DiscoveredInstance {
  const normalized = selector.toLocaleLowerCase();
  const exact = instances.filter(
    (record) =>
      record.instanceId === selector ||
      record.alias.toLocaleLowerCase() === normalized ||
      String(record.pid) === selector ||
      record.sessionId === selector,
  );
  const matches =
    exact.length > 0
      ? exact
      : instances.filter((record) => record.instanceId.startsWith(selector) || Boolean(record.sessionId?.startsWith(selector)));
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

function inferCaller(instances: DiscoveredInstance[]): DiscoveredInstance | undefined {
  return instances.find((record) => record.pid === process.ppid);
}

async function callTarget(target: DiscoveredInstance, request: ControlRequest) {
  const response = await requestInstance(target, request);
  if (!response.ok) throw new Error(response.error);
  return response;
}

server.registerTool(
  "list",
  {
    title: "List OMP instances",
    description: "List live OMP processes with alias, PID, session, model, cwd, and busy/idle state.",
    inputSchema: { include_unreachable: z.boolean().default(true) },
    annotations: { readOnlyHint: true },
  },
  async ({ include_unreachable }) => {
    const instances = await discoverInstances();
    const visible = include_unreachable ? instances : instances.filter((instance) => instance.reachable);
    return result({ count: visible.length, callerPid: process.ppid, instances: visible });
  },
);

server.registerTool(
  "inspect",
  {
    title: "Inspect OMP instance",
    description: "Read current metadata for one OMP process by alias, PID, instance ID, session ID, or unambiguous instance/session prefix.",
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
    description: "Send a correlated question to one OMP instance and block until it replies or timeout expires.",
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
      "Do not only answer in chat; caller is blocked waiting for tool reply.",
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
    description: "Complete a pending ask call using its exact correlation ID.",
    inputSchema: { correlation_id: z.string().uuid(), message: z.string().min(1).max(100_000) },
  },
  async ({ correlation_id, message }) => {
    const caller = inferCaller(await discoverInstances());
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
    description: "Send one message to every reachable OMP process, optionally excluding caller.",
    inputSchema: {
      message: z.string().min(1).max(100_000),
      delivery: z.enum(["auto", "steer", "followUp"]).default("auto"),
      exclude_self: z.boolean().default(true),
    },
  },
  async ({ message, delivery, exclude_self }) => {
    const instances = await discoverInstances();
    const caller = inferCaller(instances);
    const recipients = instances.filter((instance) => instance.reachable && !(exclude_self && caller?.instanceId === instance.instanceId));
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
  "rename",
  {
    title: "Rename OMP instance",
    description: "Assign a human-friendly alias. Omit target to rename caller process.",
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
    title: "Diagnose OMP instance registry",
    description: "Check user-only permissions, aliases, sockets, and stale reply files. fix repairs permissions and removes orphan artifacts.",
    inputSchema: { fix: z.boolean().default(false) },
  },
  async ({ fix }) => {
    const root = getControlRoot();
    const directories = [root, path.join(root, "instances"), path.join(root, "sockets"), path.join(root, "replies")];
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
    const instances = await discoverInstances();
    const aliases = new Map<string, string[]>();
    for (const instance of instances) {
      const normalized = instance.alias.toLocaleLowerCase();
      aliases.set(normalized, [...(aliases.get(normalized) ?? []), instance.instanceId]);
      if (!instance.reachable) issues.push({ kind: "unreachable_instance", instanceId: instance.instanceId, alias: instance.alias, error: instance.error });
      try {
        const mode = (await stat(instance.socketPath)).mode & 0o777;
        if (mode !== 0o600) {
          issues.push({ kind: "permission", path: instance.socketPath, expected: "0600", actual: mode.toString(8), fixed: fix });
          if (fix) await chmod(instance.socketPath, 0o600);
        }
      } catch (error) {
        issues.push({ kind: "missing_socket", path: instance.socketPath, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const [alias, ids] of aliases) if (ids.length > 1) issues.push({ kind: "duplicate_alias", alias, instanceIds: ids });
    const liveSockets = new Set(instances.map((instance) => instance.socketPath));
    for (const name of await readdir(path.join(root, "sockets"))) {
      const socketPath = path.join(root, "sockets", name);
      if (!liveSockets.has(socketPath)) {
        issues.push({ kind: "orphan_socket", path: socketPath, fixed: fix });
        if (fix) await rm(socketPath, { force: true });
      }
    }
    for (const name of await readdir(path.join(root, "replies"))) {
      const replyFile = path.join(root, "replies", name);
      if (Date.now() - (await stat(replyFile)).mtimeMs > 10 * 60_000) {
        issues.push({ kind: "stale_reply", path: replyFile, fixed: fix });
        if (fix) await rm(replyFile, { force: true });
      }
    }
    return result({ ok: issues.length === 0, fixed: fix, issues, instances: instances.length });
  },
);

server.registerTool(
  "interrupt",
  {
    title: "Interrupt OMP instance",
    description: "Abort current model/tool operation without exiting process.",
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
    description: "Gracefully terminate one running OMP process.",
    inputSchema: { target: z.string().min(1) },
    annotations: { destructiveHint: true },
  },
  async ({ target }) => {
    const response = await callTarget(resolveTarget(await discoverInstances(), target), { action: "shutdown" });
    return result({ instance: response.instance, ...response.result });
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
