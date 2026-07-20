import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createConnection } from "node:net";

export const CONTROL_PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 100_000;
const MAX_FRAME_BYTES = 1_000_000;

export type Delivery = "auto" | "steer" | "followUp";
export type InstanceStatus = "idle" | "busy" | "shutting_down";

export interface SenderIdentity {
  instanceId: string;
  alias: string;
  pid: number;
  sessionId?: string;
  cwd: string;
}

export interface CorrelatedReply {
  correlationId: string;
  message: string;
  responder?: SenderIdentity;
  repliedAt: string;
}

export interface InstanceRecord extends SenderIdentity {
  protocolVersion: number;
  socketPath: string;
  sessionName?: string;
  sessionFile?: string;
  model?: string;
  status: InstanceStatus;
  startedAt: string;
  updatedAt: string;
  profile?: string;
  windowId?: string;
  terminalId?: string;
}

export type ControlRequest =
  | { action: "ping" | "inspect" }
  | { action: "send"; message: string; delivery?: Delivery; sender?: SenderIdentity }
  | { action: "rename"; alias: string }
  | { action: "relink"; windowId: string; terminalId: string }
  | { action: "interrupt" }
  | { action: "shutdown" };

export type ControlResponse =
  | { ok: true; instance: InstanceRecord; result?: Record<string, unknown> }
  | { ok: false; error: string };

export function getControlRoot(): string {
  const configured = process.env.OMP_CONTROL_DIR?.trim();
  if (configured) return path.resolve(configured.replace(/^~(?=$|\/)/, homedir()));
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join("/tmp", `omp-control-${uid}`);
}

export function createInstanceId(): string {
  return randomUUID();
}

export function instanceRecordPath(instanceId: string): string {
  return path.join(getControlRoot(), "instances", `${instanceId}.json`);
}

export function instanceSocketPath(instanceId: string): string {
  const socketPath = path.join(getControlRoot(), "sockets", `${instanceId}.sock`);
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error(`OMP control socket path is too long: ${socketPath}`);
  }
  return socketPath;
}

export async function ensureControlDirectories(): Promise<void> {
  const root = getControlRoot();
  await mkdir(path.join(root, "instances"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "sockets"), { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(root, 0o700),
    chmod(path.join(root, "instances"), 0o700),
    chmod(path.join(root, "sockets"), 0o700),
  ]);
  await mkdir(path.join(root, "replies"), { recursive: true, mode: 0o700 });
  await chmod(path.join(root, "replies"), 0o700);
}

export async function writeInstanceRecord(record: InstanceRecord): Promise<void> {
  await ensureControlDirectories();
  const target = instanceRecordPath(record.instanceId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function removeInstanceArtifacts(record: Pick<InstanceRecord, "instanceId" | "socketPath">, removeSocket = true): Promise<void> {
  await rm(instanceRecordPath(record.instanceId), { force: true });
  if (removeSocket) await rm(record.socketPath, { force: true });
}

function isInstanceRecord(value: unknown): value is InstanceRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InstanceRecord>;
  return (
    candidate.protocolVersion === CONTROL_PROTOCOL_VERSION &&
    typeof candidate.instanceId === "string" &&
    typeof candidate.alias === "string" &&
    typeof candidate.pid === "number" &&
    typeof candidate.cwd === "string" &&
    typeof candidate.socketPath === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export async function readInstanceRecords(): Promise<InstanceRecord[]> {
  await ensureControlDirectories();
  const directory = path.join(getControlRoot(), "instances");
  const names = await readdir(directory);
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const parsed: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
          return isInstanceRecord(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  return records.filter((record): record is InstanceRecord => record !== undefined);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function requestInstance(
  instance: InstanceRecord,
  request: ControlRequest,
  timeoutMs = 3_000,
): Promise<ControlResponse> {
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) throw new Error("OMP control request exceeds frame limit");

  return await new Promise<ControlResponse>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = createConnection(instance.socketPath);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out contacting ${instance.alias} (${instance.instanceId})`))),
      timeoutMs,
    );

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        finish(() => reject(new Error("OMP control response exceeds frame limit")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as ControlResponse;
        finish(() => resolve(parsed));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (!settled) finish(() => reject(new Error(`Empty response from ${instance.alias}`)));
    });
  });
}

export function createCorrelationId(): string {
  return randomUUID();
}

function replyPath(correlationId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(correlationId)) throw new Error("Invalid correlation ID");
  return path.join(getControlRoot(), "replies", `${correlationId}.json`);
}

function pendingReplyPath(correlationId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(correlationId)) throw new Error("Invalid correlation ID");
  return path.join(getControlRoot(), "replies", `${correlationId}.pending`);
}

export async function createPendingReply(correlationId: string): Promise<void> {
  await ensureControlDirectories();
  await writeFile(pendingReplyPath(correlationId), `${Date.now()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export async function cancelPendingReply(correlationId: string): Promise<void> {
  await Promise.all([rm(pendingReplyPath(correlationId), { force: true }), rm(replyPath(correlationId), { force: true })]);
}

export async function writeCorrelatedReply(reply: CorrelatedReply): Promise<void> {
  await ensureControlDirectories();
  await readFile(pendingReplyPath(reply.correlationId), "utf8");
  const target = replyPath(reply.correlationId);
  await writeFile(target, `${JSON.stringify(reply)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(target, 0o600);
}

export async function waitForCorrelatedReply(correlationId: string, timeoutMs: number): Promise<CorrelatedReply> {
  await ensureControlDirectories();
  const target = replyPath(correlationId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const reply = JSON.parse(await readFile(target, "utf8")) as CorrelatedReply;
      await Promise.all([rm(target, { force: true }), rm(pendingReplyPath(correlationId), { force: true })]);
      if (reply.correlationId !== correlationId || typeof reply.message !== "string") throw new Error("Invalid correlated reply");
      return reply;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(100);
  }
  await cancelPendingReply(correlationId);
  throw new Error(`Timed out waiting for reply ${correlationId}`);
}

export function senderIdentity(record: InstanceRecord): SenderIdentity {
  return {
    instanceId: record.instanceId,
    alias: record.alias,
    pid: record.pid,
    sessionId: record.sessionId,
    cwd: record.cwd,
  };
}
