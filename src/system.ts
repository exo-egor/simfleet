import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  FLEET_CONFIG,
  PROJECT_CONFIG,
  getVariant,
  projectBundleEnv,
  resolveMetroCommand,
  type AppEnvironment,
  type BuildMode,
} from "./config";
import type { FleetSession } from "./state";

type ProcessInfo = {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPercent: number;
  elapsed: string;
  command: string;
  executablePath?: string;
};

export type WorktreeInfo = {
  path: string;
  branch: string;
  dirty: boolean;
};

export type SimulatorInfo = {
  /** Seconds since the simulator's launchd_sim started; null when shut down. */
  uptimeSeconds: number | null;
  udid: string;
  name: string;
  runtime: string;
  state: string;
  dataSizeBytes: number;
  processCount: number;
  rssBytes: number;
  topProcesses: Array<{ name: string; rssBytes: number }>;
};

export type MetroListener = {
  pid: number;
  port: number;
  rssBytes: number;
  elapsed: string;
  cwd: string | null;
  command: string;
};

export type SimSlimDevice = {
  udid: string;
  managedDisabled?: number;
  managedTotal: number;
  memory?: { processes: number; bytes: number; cpu: number };
  verified?: boolean;
};

export type SimSlimInventory = {
  installed: boolean;
  version: string | null;
  profilePath: string | null;
  devices: SimSlimDevice[];
  stale?: boolean;
};

export type SimulatorInput =
  | { kind: "tap" | "double-tap"; x: number; y: number; width: number; height: number }
  | {
      kind: "swipe";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      width: number;
      height: number;
      durationSeconds?: number;
    }
  | { kind: "text"; text: string }
  | { kind: "key"; code: string; modifiers?: string[] }
  | {
      kind: "button";
      button:
        | "home"
        | "lock"
        | "power"
        | "volume-up"
        | "volume-down"
        | "action"
        | "app-switcher"
        | "swipe-to-app-switcher"
        | "swipe-to-home"
        | "pull-down-to-lock-screen"
        | "pull-down-to-notification-center";
    }
  | {
      kind: "orientation";
      orientation: "portrait" | "landscape-left" | "landscape-right" | "portrait-upside-down";
    }
  | { kind: "open-url"; url: string }
  | { kind: "shake" };

type CommandResult = { stdout: string; stderr: string; exitCode: number };

export async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs)
    : null;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (timeout) clearTimeout(timeout);
  return {
    stdout,
    stderr: timedOut
      ? `${stderr.trim()}\nCommand timed out after ${options.timeoutMs}ms`.trim()
      : stderr,
    exitCode,
  };
}

function parseProcessList(raw: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      cpuPercent: Number(match[4]),
      elapsed: match[5],
      command: match[6],
    });
  }
  return processes;
}

export async function getProcesses(): Promise<ProcessInfo[]> {
  const [processResult, executableResult] = await Promise.all([
    run("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,etime=,command="]),
    // `command` includes arguments, while `comm` preserves the executable path.
    // Keeping both avoids labels such as "iOS" when a runtime path contains spaces.
    run("ps", ["-axo", "pid=,comm="]),
  ]);
  const executableByPid = new Map<number, string>();
  for (const line of executableResult.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) executableByPid.set(Number(match[1]), match[2].trim());
  }
  return parseProcessList(processResult.stdout).map((process) => ({
    ...process,
    executablePath: executableByPid.get(process.pid),
  }));
}

function processName(process: ProcessInfo): string {
  const executable = process.executablePath || process.command.split(/\s+/)[0] || process.command;
  return path.basename(executable);
}

export async function getHostMemory() {
  const [memoryResult, swapResult, pressureResult] = await Promise.all([
    run("sysctl", ["-n", "hw.memsize"]),
    run("sysctl", ["vm.swapusage"]),
    run("memory_pressure", ["-Q"]),
  ]);
  const totalBytes = Number(memoryResult.stdout.trim());
  const freeMatch = pressureResult.stdout.match(/free percentage:\s*(\d+)%/i);
  const swapMatch = swapResult.stdout.match(
    /total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M/,
  );
  return {
    totalBytes,
    freePercent: freeMatch ? Number(freeMatch[1]) : null,
    swapTotalBytes: swapMatch ? Number(swapMatch[1]) * 1024 * 1024 : null,
    swapUsedBytes: swapMatch ? Number(swapMatch[2]) * 1024 * 1024 : null,
  };
}

export async function getTopProcesses(processes: ProcessInfo[]) {
  return [...processes]
    .sort((left, right) => right.rssKb - left.rssKb)
    .slice(0, 20)
    .map((process) => ({
      ...process,
      rssBytes: process.rssKb * 1024,
      name: processName(process),
    }));
}

const simSlimProfilePath = FLEET_CONFIG.simslimProfilePath;
const simSlimProfileArgs = simSlimProfilePath ? ["--profile", simSlimProfilePath] : [];
let lastSimSlimInventory: SimSlimInventory | null = null;

async function readSimSlimInventory(): Promise<SimSlimInventory> {
  try {
    const [listResult, versionResult] = await Promise.all([
      // Listing scans every device set and takes ~5 s with dozens of simulators.
      run("simslim", ["list", "--json"], { timeoutMs: 45_000 }),
      run("simslim", ["version"], { timeoutMs: 10_000 }),
    ]);
    if (listResult.exitCode !== 0) throw new Error(listResult.stderr || listResult.stdout);
    const devices = JSON.parse(listResult.stdout) as SimSlimDevice[];
    const verifiedDevices = await Promise.all(
      devices.map(async (device) => {
        if (!device.memory || !device.managedDisabled) return device;
        const verification = await run(
          "simslim",
          ["verify", device.udid, ...simSlimProfileArgs, "--json"],
          { timeoutMs: 15_000 },
        );
        if (verification.exitCode !== 0) return { ...device, verified: false };
        try {
          return {
            ...device,
            verified: Boolean((JSON.parse(verification.stdout) as { ok?: boolean }).ok),
          };
        } catch {
          return { ...device, verified: false };
        }
      }),
    );
    const inventory = {
      installed: true,
      version: versionResult.stdout.trim() || null,
      profilePath: simSlimProfilePath,
      devices: verifiedDevices,
    };
    lastSimSlimInventory = inventory;
    return inventory;
  } catch {
    if (lastSimSlimInventory) return { ...lastSimSlimInventory, stale: true };
    return {
      installed: false,
      version: null,
      profilePath: simSlimProfilePath,
      devices: [],
    };
  }
}

let simSlimInventoryAt = 0;
let simSlimInventoryRequest: Promise<SimSlimInventory> | null = null;

/**
 * SimSlim inventory is slow, so status reads a cached copy refreshed in the
 * background. Only the very first call (or `fresh`) waits for simslim.
 */
export async function getSimSlimInventory(
  options: { maxAgeMs?: number; fresh?: boolean } = {}
): Promise<SimSlimInventory> {
  const maxAgeMs = options.maxAgeMs ?? 15_000;
  const refresh = () => {
    simSlimInventoryRequest ||= readSimSlimInventory().finally(() => {
      simSlimInventoryAt = Date.now();
      simSlimInventoryRequest = null;
    });
    return simSlimInventoryRequest;
  };
  if (options.fresh || !lastSimSlimInventory) return refresh();
  if (Date.now() - simSlimInventoryAt > maxAgeMs) void refresh();
  return lastSimSlimInventory;
}

/** `ps` etime ([[dd-]hh:]mm:ss) in seconds. */
export function elapsedSeconds(elapsed: string): number | null {
  const match = elapsed.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

async function gitBranch(worktreePath: string): Promise<string> {
  const result = await run("git", ["-C", worktreePath, "branch", "--show-current"]);
  return result.stdout.trim() || "detached";
}

async function gitDirty(worktreePath: string): Promise<boolean> {
  const result = await run("git", [
    "-C",
    worktreePath,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  return result.stdout.trim().length > 0;
}

export async function getWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const candidates = new Set<string>();
  const listed = await run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) candidates.add(line.slice("worktree ".length));
  }

  // Some projects historically kept checkouts directly under $HOME. Surface
  // those old lanes for migration, but only directories that are Git checkouts.
  const legacyPrefixes = PROJECT_CONFIG.worktrees?.legacyHomePrefixes || [];
  for (const entry of legacyPrefixes.length
    ? fs.readdirSync(os.homedir(), { withFileTypes: true })
    : []) {
    if (!entry.isDirectory()) continue;
    if (!legacyPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const candidate = path.join(os.homedir(), entry.name);
    if (fs.existsSync(path.join(candidate, ".git"))) candidates.add(candidate);
  }

  const worktrees = await Promise.all(
    [...candidates].map(async (worktreePath) => ({
      path: worktreePath,
      branch: await gitBranch(worktreePath),
      dirty: await gitDirty(worktreePath),
    })),
  );
  return worktrees.sort((left, right) => left.path.localeCompare(right.path));
}

export async function getSimulators(processes: ProcessInfo[]): Promise<SimulatorInfo[]> {
  const result = await run("xcrun", ["simctl", "list", "devices", "-j"]);
  const payload = JSON.parse(result.stdout) as {
    devices: Record<
      string,
      Array<{
        udid: string;
        name: string;
        state: string;
        isAvailable: boolean;
        dataPathSize?: number;
      }>
    >;
  };
  const simulators: SimulatorInfo[] = [];
  for (const [runtime, devices] of Object.entries(payload.devices)) {
    if (!runtime.includes("iOS")) continue;
    for (const device of devices) {
      if (!device.isAvailable) continue;
      const launchd = processes.find(
        (process) =>
          process.command.startsWith("launchd_sim ") && process.command.includes(device.udid),
      );
      const children = launchd ? processes.filter((process) => process.ppid === launchd.pid) : [];
      const topProcesses = [...children]
        .sort((left, right) => right.rssKb - left.rssKb)
        .slice(0, 5)
        .map((process) => ({
          name: processName(process),
          rssBytes: process.rssKb * 1024,
        }));
      simulators.push({
        udid: device.udid,
        name: device.name,
        runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replaceAll("-", " "),
        state: device.state,
        dataSizeBytes: device.dataPathSize || 0,
        processCount: children.length,
        rssBytes: children.reduce((total, process) => total + process.rssKb * 1024, 0),
        uptimeSeconds: launchd ? elapsedSeconds(launchd.elapsed) : null,
        topProcesses,
      });
    }
  }
  return simulators.sort((left, right) => {
    if (left.state === right.state) return left.name.localeCompare(right.name);
    return left.state === "Booted" ? -1 : 1;
  });
}

export async function getSimulatorCreationOptions(): Promise<unknown> {
  const [deviceTypes, runtimes] = await Promise.all([
    run("xcrun", ["simctl", "list", "devicetypes", "-j"]),
    run("xcrun", ["simctl", "list", "runtimes", "-j"]),
  ]);
  if (deviceTypes.exitCode !== 0 || runtimes.exitCode !== 0) {
    throw new Error(
      deviceTypes.stderr.trim() ||
        runtimes.stderr.trim() ||
        "Could not enumerate simulator creation options",
    );
  }
  return {
    deviceTypes: JSON.parse(deviceTypes.stdout).devicetypes,
    runtimes: JSON.parse(runtimes.stdout).runtimes,
  };
}

export async function createSimulator(
  name: string,
  deviceTypeIdentifier: string,
  runtimeIdentifier: string,
): Promise<string> {
  const result = await run("xcrun", [
    "simctl",
    "create",
    name,
    deviceTypeIdentifier,
    runtimeIdentifier,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not create simulator");
  }
  const udid = result.stdout.trim();
  if (!/^[A-F0-9-]+$/i.test(udid)) throw new Error("simctl returned an invalid simulator UDID");
  return udid;
}

async function cwdForPid(pid: number): Promise<string | null> {
  const result = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwdLine = result.stdout.split("\n").find((line) => line.startsWith("n"));
  return cwdLine ? cwdLine.slice(1) : null;
}

export async function getMetroListeners(processes: ProcessInfo[]): Promise<MetroListener[]> {
  const result = await run("lsof", ["-nP", "-iTCP:8081-9999", "-sTCP:LISTEN"]);
  const listeners = new Map<number, { pid: number; port: number }>();
  for (const line of result.stdout.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9 || fields[0] !== "node") continue;
    const pid = Number(fields[1]);
    const portMatch = fields[8].match(/:(\d+)$/);
    if (Number.isFinite(pid) && portMatch) {
      listeners.set(pid, { pid, port: Number(portMatch[1]) });
    }
  }
  return Promise.all(
    [...listeners.values()].map(async (listener) => {
      const process = processes.find((candidate) => candidate.pid === listener.pid);
      return {
        ...listener,
        rssBytes: (process?.rssKb || 0) * 1024,
        elapsed: process?.elapsed || "",
        cwd: await cwdForPid(listener.pid),
        command: process?.command || "node",
      };
    }),
  );
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, FLEET_CONFIG.host, () => {
      server.close(() => resolve(true));
    });
  });
}

export type BrowserControl = {
  installed: boolean;
  owned: boolean;
  pid: number | null;
  port: number;
  url: string;
};

export async function browserControlHealthy(): Promise<boolean> {
  try {
    const response = await fetch(
      `http://${FLEET_CONFIG.host}:${FLEET_CONFIG.browserControlPort}/farm`,
      { signal: AbortSignal.timeout(750) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function startBrowserControl(): Promise<BrowserControl> {
  const port = FLEET_CONFIG.browserControlPort;
  const url = `http://${FLEET_CONFIG.host}:${port}/farm`;
  if (await browserControlHealthy()) {
    return { installed: true, owned: false, pid: null, port, url };
  }
  const location = await run("which", ["baguette"]);
  if (location.exitCode !== 0) {
    return { installed: false, owned: false, pid: null, port, url };
  }
  if (!(await isPortAvailable(port))) {
    throw new Error(`Browser-control port ${port} is occupied by a non-Baguette process`);
  }

  const logsDirectory = path.join(FLEET_CONFIG.stateDirectory, "logs");
  fs.mkdirSync(logsDirectory, { recursive: true });
  const log = fs.openSync(path.join(logsDirectory, "baguette.log"), "a");
  const child = spawn(
    location.stdout.trim(),
    ["serve", "--host", FLEET_CONFIG.host, "--port", String(port)],
    { cwd: process.cwd(), stdio: ["ignore", log, log] },
  );
  fs.closeSync(log);
  if (!child.pid) throw new Error("Baguette did not return a process ID");

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await browserControlHealthy()) {
      return { installed: true, owned: true, pid: child.pid, port, url };
    }
    if (!isProcessRunning(child.pid)) throw new Error("Baguette exited during startup");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error("Baguette did not become ready within 3 seconds");
}

export async function allocatePort(
  environment: AppEnvironment,
  mode: BuildMode,
  sessions: FleetSession[],
): Promise<number> {
  const [start, end] = getVariant(environment, mode).portRange;
  const leased = new Set(
    sessions
      .filter(
        (session) =>
          session.port !== null && session.metroPid !== null && isProcessRunning(session.metroPid),
      )
      .map((session) => session.port as number),
  );
  for (let port = start; port <= end; port += 1) {
    if (!leased.has(port) && (await isPortAvailable(port))) return port;
  }
  throw new Error(`No free Metro port in ${start}-${end}`);
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startMetro(session: FleetSession & { port: number }): number {
  const launch = resolveMetroCommand(PROJECT_CONFIG.metro, session.worktreePath, {
    environment: session.environment,
    mode: session.mode,
    port: session.port,
  });
  if (!fs.existsSync(launch.cwd)) {
    throw new Error(`Metro working directory is missing: ${launch.cwd}`);
  }
  if (launch.command.includes(path.sep) && !fs.existsSync(launch.command)) {
    throw new Error(`Metro executable is missing: ${launch.command}`);
  }
  const log = fs.openSync(session.logPath, "a");
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: "development",
      ...projectBundleEnv({
        environment: session.environment,
        mode: session.mode,
        port: session.port,
      }),
      METRO_PORT: String(session.port),
      ...(launch.driver === "expo" ? { EXPO_NO_DOTENV: "1", EXPO_NO_INTERACTIVE: "1" } : {}),
      // The native client uses 127.0.0.1, so keep Metro from binding IPv6 only.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--dns-result-order=ipv4first"]
        .filter(Boolean)
        .join(" "),
    },
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.closeSync(log);
  if (!child.pid) throw new Error("Metro did not return a process ID");
  return child.pid;
}

export async function stopManagedMetro(session: FleetSession): Promise<void> {
  if (session.metroPid === null) return;
  if (!isProcessRunning(session.metroPid)) return;
  if (session.port === null) throw new Error("A debug lane requires a Metro port");
  const launch = resolveMetroCommand(PROJECT_CONFIG.metro, session.worktreePath, {
    environment: session.environment,
    mode: session.mode,
    port: session.port,
  });
  const [processResult, cwd] = await Promise.all([
    run("ps", ["-p", String(session.metroPid), "-o", "command="]),
    cwdForPid(session.metroPid),
  ]);
  if (
    !cwd ||
    fs.realpathSync(cwd) !== fs.realpathSync(launch.cwd) ||
    !processResult.stdout.includes(path.basename(launch.command)) ||
    !processResult.stdout.includes(String(session.port))
  ) {
    throw new Error(`PID ${session.metroPid} no longer belongs to this fleet session`);
  }
  try {
    process.kill(-session.metroPid, "SIGTERM");
  } catch {
    process.kill(session.metroPid, "SIGTERM");
  }
}

// `expo start --localhost` binds whichever loopback family the host resolves
// "localhost" to, which is [::1] here. Probing only 127.0.0.1 would report a
// healthy Metro as dead forever, so try both families.
const METRO_PROBE_HOSTS = [FLEET_CONFIG.host, "localhost"] as const;

export async function metroHealthy(port: number): Promise<boolean> {
  for (const host of METRO_PROBE_HOSTS) {
    try {
      const response = await fetch(`http://${host}:${port}/status`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok && (await response.text()).includes("packager-status:running")) return true;
    } catch {
      // Try the next loopback family.
    }
  }
  return false;
}

export async function configureAndLaunch(session: FleetSession): Promise<void> {
  if (session.port === null) throw new Error("A debug lane requires a Metro port");
  if (PROJECT_CONFIG.metro?.driver === "react-native") {
    const installed = await run("xcrun", [
      "simctl", "get_app_container", session.simulatorUdid, session.bundleId, "app",
    ]);
    if (installed.exitCode !== 0) {
      const artifact = PROJECT_CONFIG.nativeShells.debug.artifactPath;
      if (!artifact) {
        throw new Error(
          `Install ${session.bundleId} on ${session.simulatorUdid} first, or set nativeShells.debug.artifactPath`,
        );
      }
      const artifactPath = path.resolve(session.worktreePath, artifact);
      if (!fs.existsSync(artifactPath)) throw new Error(`Debug app is missing: ${artifactPath}`);
      const install = await run("xcrun", ["simctl", "install", session.simulatorUdid, artifactPath]);
      if (install.exitCode !== 0) throw new Error(install.stderr.trim() || "Could not install debug app");
    }
  }
  const location = `${FLEET_CONFIG.host}:${session.port}`;
  const commands: Array<[string, string[]]> = [
    [
      "xcrun",
      [
        "simctl",
        "spawn",
        session.simulatorUdid,
        "defaults",
        "write",
        session.bundleId,
        "RCT_jsLocation",
        location,
      ],
    ],
    [
      "xcrun",
      [
        "simctl",
        "spawn",
        session.simulatorUdid,
        "defaults",
        "write",
        session.bundleId,
        "RCT_packager_scheme",
        "http",
      ],
    ],
    [
      "xcrun",
      [
        "simctl",
        "launch",
        "--terminate-running-process",
        session.simulatorUdid,
        session.bundleId,
        ...(PROJECT_CONFIG.metro?.driver === "react-native"
          ? []
          : ["--initialUrl", `http://${location}`]),
      ],
    ],
  ];
  for (const [command, args] of commands) {
    const result = await run(command, args);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`);
    }
  }
}

export async function simulatorAction(
  action: "boot" | "boot-stock" | "shutdown" | "open" | "slim" | "restore",
  udid: string,
): Promise<void> {
  let result: CommandResult;
  if (action === "boot-stock") {
    // Explicitly requested stock boot: no SimSlim, and auto-slim is opted out.
    result = await run("xcrun", ["simctl", "boot", udid], { timeoutMs: 300_000 });
    if (result.exitCode !== 0 && !result.stderr.includes("current state: Booted")) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "simctl boot failed");
    }
    return;
  }
  if (action === "open") {
    const selectedXcode = await run("xcode-select", ["-p"]);
    const developerDirectory = selectedXcode.stdout.trim();
    const simulatorApp = path.join(developerDirectory, "Applications", "Simulator.app");
    const deviceHubApp = path.resolve(developerDirectory, "..", "Applications", "DeviceHub.app");
    result = fs.existsSync(simulatorApp)
      ? await run("open", ["-a", simulatorApp, "--args", "-CurrentDeviceUDID", udid])
      : fs.existsSync(deviceHubApp)
        ? await run("open", ["-a", deviceHubApp])
        : await run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid]);
  } else if (action === "slim" || action === "boot") {
    const failures: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      result = await run("simslim", ["on", udid, ...simSlimProfileArgs], {
        // Several brand-new devices may be booting concurrently. CoreSimulator can
        // legitimately take more than two minutes without the operation being stuck.
        timeoutMs: 300_000,
      });
      const verification = await run("simslim", ["verify", udid, ...simSlimProfileArgs, "--json"], {
        timeoutMs: 30_000,
      });
      let verified = false;
      try {
        verified =
          verification.exitCode === 0 &&
          Boolean((JSON.parse(verification.stdout) as { ok?: boolean }).ok);
      } catch {
        verified = false;
      }
      if (verified) return;

      failures.push(
        [
          `attempt ${attempt}`,
          result.stderr.trim() || result.stdout.trim() || `simslim exited ${result.exitCode}`,
          verification.stderr.trim() || verification.stdout.trim() || "profile verification failed",
        ].join(": "),
      );
    }
    throw new Error(`SimSlim did not verify ${udid} after two attempts\n${failures.join("\n")}`);
  } else if (action === "restore") {
    result = await run("simslim", ["off", udid], { timeoutMs: 300_000 });
  } else {
    result = await run("simslim", [action, udid], { timeoutMs: 300_000 });
  }
  if (result.exitCode !== 0 && !result.stderr.includes("current state: Booted")) {
    throw new Error(result.stderr.trim() || result.stdout.trim());
  }
}

export async function describeSimulatorUi(
  udid: string,
  point?: { x: number; y: number },
): Promise<unknown> {
  const args = ["describe-ui", "--udid", udid];
  if (point) args.push("--x", String(point.x), "--y", String(point.y));
  const result = await run("baguette", args);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Could not describe simulator UI",
    );
  }
  return JSON.parse(result.stdout);
}

export async function sendSimulatorInput(udid: string, input: SimulatorInput): Promise<void> {
  let command = "baguette";
  let args: string[];
  switch (input.kind) {
    case "tap":
    case "double-tap":
      args = [
        input.kind,
        "--udid",
        udid,
        "--x",
        String(input.x),
        "--y",
        String(input.y),
        "--width",
        String(input.width),
        "--height",
        String(input.height),
      ];
      break;
    case "swipe":
      args = [
        "swipe",
        "--udid",
        udid,
        "--start-x",
        String(input.startX),
        "--start-y",
        String(input.startY),
        "--end-x",
        String(input.endX),
        "--end-y",
        String(input.endY),
        "--width",
        String(input.width),
        "--height",
        String(input.height),
      ];
      if (input.durationSeconds !== undefined) {
        args.push("--duration", String(input.durationSeconds));
      }
      break;
    case "text":
      // Argent injects HID keyboard events character-by-character. Baguette's
      // pasteboard-backed text path triggers iOS 16+ "Allow Paste" dialogs,
      // which block unattended auth and are absent from the app AX tree.
      command = "argent";
      args = ["run", "keyboard", "--udid", udid, "--text", input.text, "--json"];
      break;
    case "key":
      args = ["key", "--udid", udid, "--code", input.code];
      if (input.modifiers?.length) args.push("--modifiers", input.modifiers.join(","));
      break;
    case "button":
      args = ["press", "--udid", udid, "--button", input.button];
      break;
    case "orientation":
      args = ["orientation", "--udid", udid, input.orientation];
      break;
    case "open-url":
      args = ["openurl", "--udid", udid, input.url];
      break;
    case "shake":
      args = ["shake", "--udid", udid];
      break;
  }

  const result = await run(command, args);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `Simulator ${input.kind} failed`,
    );
  }
}

export async function screenshot(udid: string): Promise<Uint8Array> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "simfleet-"));
  const imagePath = path.join(temporaryDirectory, `${udid}.jpg`);
  try {
    const result = await run("xcrun", [
      "simctl",
      "io",
      udid,
      "screenshot",
      "--type=jpeg",
      imagePath,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Screenshot failed");
    }
    return fs.readFileSync(imagePath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
