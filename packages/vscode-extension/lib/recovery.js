const { processAlive, readInstances, readWindows, requestSocket } = require("./control.js");

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(200);
  }
  return !processAlive(pid);
}

async function terminatePid(pid) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    if (await waitForExit(pid, signal === "SIGTERM" ? 3_000 : 1_000)) return;
  }
}

async function restartAndResumeInstance(instance, reason = "manual restart") {
  if (!instance.sessionFile) throw new Error(`OMP ${instance.alias} has no persisted session to resume`);
  const windows = await readWindows();
  const owner =
    windows.find((window) => window.windowId === instance.windowId) ||
    windows.find((window) => window.workspaceFolders.some((folder) => instance.cwd.startsWith(folder)));
  if (!owner) throw new Error(`No managed VS Code window can resume ${instance.alias}`);
  try {
    await requestSocket(instance.socketPath, { action: "interrupt" }, 1_500);
  } catch {
    // Continue with shutdown.
  }
  try {
    await requestSocket(instance.socketPath, { action: "shutdown" }, 2_000);
  } catch {
    // Unresponsive OMP is terminated below.
  }
  if (!(await waitForExit(instance.pid, 5_000))) await terminatePid(instance.pid);
  await readInstances({ includeStale: true });
  return await requestSocket(
    owner.socketPath,
    {
      action: "resume_omp",
      sessionFile: instance.sessionFile,
      alias: instance.alias,
      cwd: instance.cwd,
      terminalId: instance.terminalId,
      reason,
    },
    30_000,
  );
}

module.exports = { restartAndResumeInstance };
