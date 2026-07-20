import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { getControlRoot, isProcessAlive } from "./protocol.ts";

export const WINDOW_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 256_000;

export interface WindowTerminalRecord {
  terminalId: string;
  name: string;
  pid?: number;
  cwd?: string;
  owned: boolean;
}

export interface WindowEditorTabRecord {
  group: number;
  label: string;
  resource?: string;
  active: boolean;
  dirty: boolean;
}

export interface WindowWatchdogPolicy {
  enabled: boolean;
  autoRecover: boolean;
  memoryLimitBytes: number;
  consecutiveSamples: number;
  pollIntervalMs: number;
}

export interface WindowRecord {
  protocolVersion: number;
  windowId: string;
  socketPath: string;
  pid: number;
  appPid: number;
  label: string;
  workspaceFolders: string[];
  workspaceFile?: string;
  appName: string;
  appHost: string;
  editorSessionId?: string;
  remoteName?: string;
  startedAt: string;
  updatedAt: string;
  terminals: WindowTerminalRecord[];
  focused: boolean;
  activeEditor?: string;
  editorTabs: WindowEditorTabRecord[];
  watchdog: WindowWatchdogPolicy;
}

export type WindowRequest =
  | { action: "ping" | "state" | "show_dashboard" }
  | { action: "create_omp"; alias?: string; cwd?: string; initialMessage?: string }
  | { action: "resume_omp"; sessionFile: string; alias?: string; cwd?: string; terminalId?: string; reason?: string }
  | { action: "focus_omp"; terminalId: string }
  | { action: "reload_window"; reason?: string }
  | { action: "close_window" }
  | { action: "notify"; level?: "info" | "warning" | "error"; message: string };

export type WindowResponse =
  | { ok: true; window: WindowRecord; result?: Record<string, unknown> }
  | { ok: false; error: string };

export function getWindowRegistryDir(): string {
  return path.join(getControlRoot(), "windows");
}

export function getWindowSocketDir(): string {
  return path.join(getControlRoot(), "window-sockets");
}

export function windowRecordPath(windowId: string): string {
  return path.join(getWindowRegistryDir(), `${windowId}.json`);
}

export function windowSocketPath(windowId: string): string {
  const socketPath = path.join(getWindowSocketDir(), `${windowId}.sock`);
  if (Buffer.byteLength(socketPath) > 100) throw new Error(`OMP window socket path is too long: ${socketPath}`);
  return socketPath;
}

export async function ensureWindowDirectories(): Promise<void> {
  const root = getControlRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(getWindowRegistryDir(), { recursive: true, mode: 0o700 });
  await mkdir(getWindowSocketDir(), { recursive: true, mode: 0o700 });
  await Promise.all([chmod(root, 0o700), chmod(getWindowRegistryDir(), 0o700), chmod(getWindowSocketDir(), 0o700)]);
}

export async function writeWindowRecord(record: WindowRecord): Promise<void> {
  await ensureWindowDirectories();
  const target = windowRecordPath(record.windowId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function removeWindowArtifacts(record: Pick<WindowRecord, "windowId" | "socketPath">, removeSocket = true): Promise<void> {
  await rm(windowRecordPath(record.windowId), { force: true });
  if (removeSocket) await rm(record.socketPath, { force: true });
}

function isWindowRecord(value: unknown): value is WindowRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WindowRecord>;
  return (
    candidate.protocolVersion === WINDOW_PROTOCOL_VERSION &&
    typeof candidate.windowId === "string" &&
    typeof candidate.socketPath === "string" &&
    typeof candidate.pid === "number" &&
    typeof candidate.appPid === "number" &&
    typeof candidate.label === "string" &&
    Array.isArray(candidate.workspaceFolders) &&
    candidate.workspaceFolders.every((folder) => typeof folder === "string") &&
    typeof candidate.updatedAt === "string" &&
    Array.isArray(candidate.terminals) &&
    Boolean(candidate.watchdog)
  );
}

export async function readWindowRecords(): Promise<WindowRecord[]> {
  await ensureWindowDirectories();
  const names = await readdir(getWindowRegistryDir());
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const parsed: unknown = JSON.parse(await readFile(path.join(getWindowRegistryDir(), name), "utf8"));
          return isWindowRecord(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }),
  );
  const live: WindowRecord[] = [];
  for (const record of records) {
    if (!record) continue;
    if (!isProcessAlive(record.pid)) {
      await removeWindowArtifacts(record);
      continue;
    }
    live.push(record);
  }
  return live.sort((left, right) => left.label.localeCompare(right.label) || left.windowId.localeCompare(right.windowId));
}

export async function requestWindow(window: WindowRecord, request: WindowRequest, timeoutMs = 3_000): Promise<WindowResponse> {
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) throw new Error("OMP window request exceeds frame limit");
  return await new Promise<WindowResponse>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = createConnection(window.socketPath);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out contacting VS Code window ${window.label} (${window.windowId})`))),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        finish(() => reject(new Error("OMP window response exceeds frame limit")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(() => resolve(JSON.parse(buffer.slice(0, newline)) as WindowResponse));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (!settled) finish(() => reject(new Error(`Empty response from VS Code window ${window.label}`)));
    });
  });
}

export function defaultCodiumPath(): string {
  return process.env.OMP_VSCODE_CLI || path.join("/opt", "homebrew", "bin", "codium");
}
export interface SupervisorState {
  pid: number;
  startedAt: string;
  updatedAt: string;
  windows?: number;
  instances?: number;
  summaries?: Array<{ kind: "omp" | "vscode"; id: string; pid: number; rssBytes: number; limitBytes: number }>;
}

export async function readSupervisorState(): Promise<SupervisorState | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(getControlRoot(), "supervisor.json"), "utf8")) as Partial<SupervisorState>;
    if (typeof value.pid !== "number" || typeof value.startedAt !== "string" || typeof value.updatedAt !== "string") return undefined;
    return value as SupervisorState;
  } catch {
    return undefined;
  }
}


export function expandHome(value: string): string {
  return path.resolve(value.replace(/^~(?=$|\/)/, homedir()));
}
