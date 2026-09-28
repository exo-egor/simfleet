import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLEET_CONFIG,
  PROJECT_CONFIG,
  PROJECT_ROOT,
  VARIANTS,
  getVariant,
  isAppEnvironment,
  isBuildMode,
} from "./config";
import {
  loadState,
  logPathFor,
  saveState,
  sessionPlatform,
  setSlimOptOut,
  slimOptOuts,
  updateState,
  type DevicePlatform,
  type FleetSession,
} from "./state";
import {
  ANDROID_BUTTONS,
  configureAndLaunchAndroid,
  describeEmulatorUi,
  emulatorAction,
  emulatorDefinition,
  emulatorScreenshot,
  getAndroidToolchain,
  getEmulators,
  isAvdName,
  listInstalledAvds,
  removeLaneReverse,
  sendEmulatorInput,
  type AndroidButton,
  type AndroidInput,
  type EmulatorAction,
  type EmulatorActionOptions,
} from "./android";
import {
  androidStreamAvailable,
  attachAndroidViewer,
  closeAndroidStream,
  detachAndroidViewer,
  handleAndroidViewerMessage,
  type StreamViewer,
} from "./android-stream";
import {
  AGENT_HEADER,
  SESSION_HEADER,
  attributeAgents,
  getAgentSessions,
  recordAttachment,
  releaseAttachment,
} from "./agents";
import { createRebundledRelease, ensureNativeShell, nativeBuildPlan } from "./native";
import { createFleetWorktree } from "./worktree";
import {
  allocatePort,
  browserControlHealthy,
  configureAndLaunch,
  createSimulator,
  describeSimulatorUi,
  getHostMemory,
  getMetroListeners,
  getProcesses,
  getSimSlimInventory,
  getSimulatorCreationOptions,
  getSimulators,
  getTopProcesses,
  getWorktrees,
  isPortAvailable,
  isProcessRunning,
  metroHealthy,
  screenshot,
  sendSimulatorInput,
  simulatorAction,
  startBrowserControl,
  startMetro,
  stopManagedMetro,
  type SimulatorInput,
} from "./system";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = PROJECT_ROOT;
// The built dashboard (dashboard/ → dist/dashboard) is preferred; the legacy
// single-file page remains as a fallback for source checkouts without a build.
const dashboardDirectory = path.resolve(toolDirectory, "../dist/dashboard");
const dashboardSource = path.resolve(toolDirectory, "../dashboard");

/**
 * Published packages ship the built dashboard. A git checkout builds it on the
 * first `serve` so `bun install -g github:...` and local clones work unchanged.
 */
function ensureDashboardBuilt(): void {
  if (fs.existsSync(path.join(dashboardDirectory, "index.html"))) return;
  if (!fs.existsSync(path.join(dashboardSource, "package.json"))) return;
  console.log("Building the dashboard (first run)…");
  for (const args of [["install", "--frozen-lockfile"], ["run", "build"]]) {
    const result = spawnSync(process.execPath, args, { cwd: dashboardSource, stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`Dashboard build failed (bun ${args.join(" ")}); the API still works.`);
      return;
    }
  }
}
ensureDashboardBuilt();

const DASHBOARD_MISSING = `<!doctype html><html lang="en"><meta charset="utf-8"><title>simfleet</title>
<body style="font:15px system-ui;margin:3rem;max-width:40rem;line-height:1.5">
<h1>simfleet</h1><p>The API is running, but the dashboard is not built. Run
<code>bun run build:dashboard</code> in the simfleet package and reload.</p></body></html>`;
/** Changes whenever the dashboard is rebuilt, so open tabs can reload themselves. */
function dashboardBuild(): string {
  const built = path.join(dashboardDirectory, "index.html");
  return String(fs.existsSync(built) ? fs.statSync(built).mtimeMs : 0);
}

function dashboardIndex(): string {
  const built = path.join(dashboardDirectory, "index.html");
  return fs.existsSync(built) ? fs.readFileSync(built, "utf8") : DASHBOARD_MISSING;
}
const staticContentTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
function staticDashboardFile(pathname: string): Response | null {
  if (pathname === "/" || pathname.startsWith("/api/")) return null;
  const file = path.resolve(dashboardDirectory, `.${pathname}`);
  if (!file.startsWith(`${dashboardDirectory}${path.sep}`) || !fs.existsSync(file)) return null;
  if (!fs.statSync(file).isFile()) return null;
  return new Response(Bun.file(file), {
    headers: {
      "content-type": staticContentTypes[path.extname(file)] || "application/octet-stream",
      "cache-control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}
const browserControl = await startBrowserControl();
let sessionMutationQueue: Promise<void> = Promise.resolve();
const simulatorOperations = new Map<
  string,
  {
    action: SimulatorAction;
    startedAt: string;
    promise: Promise<void>;
  }
>();
type NativeEnsureJob = {
  id: string;
  worktreePath: string;
  simulatorUdid: string;
  mode: "debug" | "release";
  status: "running" | "complete" | "failed";
  startedAt: string;
  result?: Awaited<ReturnType<typeof ensureNativeShell>>;
  error?: string;
};
const nativeEnsureJobs = new Map<string, NativeEnsureJob>();
type LaneLaunchJob = {
  id: string;
  laneId: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  result?: Record<string, unknown>;
  error?: string;
};
const laneLaunchJobs = new Map<string, LaneLaunchJob>();
type SimulatorAction = "boot" | "boot-stock" | "shutdown" | "open" | "slim" | "restore";
type SimulatorActionJob = {
  id: string;
  simulatorUdid: string;
  action: SimulatorAction;
  status: "running" | "complete" | "failed";
  startedAt: string;
  result?: { ok: true; action: SimulatorAction; simulatorUdid: string };
  error?: string;
};
const simulatorActionJobs = new Map<string, SimulatorActionJob>();
type EmulatorActionJob = {
  id: string;
  avd: string;
  action: EmulatorAction;
  status: "running" | "complete" | "failed";
  startedAt: string;
  result?: { ok: true; action: EmulatorAction; avd: string };
  error?: string;
};
const emulatorActionJobs = new Map<string, EmulatorActionJob>();
const emulatorOperations = new Map<
  string,
  { action: EmulatorAction; startedAt: string; promise: Promise<void> }
>();
// avdslim picks the next free console port when it starts an emulator, so two
// concurrent boots could race for the same port. Boots are serialized.
let emulatorBootQueue: Promise<void> = Promise.resolve();
let cachedStatus: { expiresAt: number; payload: unknown } | null = null;
let statusRequest: Promise<unknown> | null = null;
let statusRevision = 0;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Device modules signal client errors (wrong state, bad input) with a status. */
function statusFromError(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function serializeSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionMutationQueue.then(operation, operation);
  sessionMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function invalidateStatus(): void {
  statusRevision += 1;
  cachedStatus = null;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...init.headers },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new Error("Expected a JSON request body");
  }
}

function errorResponse(error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, { status });
}

function sessionId(branch: string, simulatorUdid: string): string {
  const branchPart = branch
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${branchPart || "lane"}-${simulatorUdid.slice(0, 8)}-${Date.now().toString(36)}`;
}

function sessionIsActive(session: FleetSession): boolean {
  return (
    session.mode === "release" || (session.metroPid !== null && isProcessRunning(session.metroPid))
  );
}

async function statusPayload() {
  const processes = await getProcesses();
  const [memory, worktrees, simulators, metroListeners, topProcesses, emulators, androidToolchain] =
    await Promise.all([
      getHostMemory(),
      getWorktrees(repoRoot),
      getSimulators(processes),
      getMetroListeners(processes),
      getTopProcesses(processes),
      getEmulators(processes).catch(() => []),
      getAndroidToolchain(),
    ]);
  const simSlim = await getSimSlimInventory();
  const simulatorsWithSlimState = simulators.map((simulator) => ({
    ...simulator,
    simSlim: simSlim.devices.find((device) => device.udid === simulator.udid) || null,
    operation: simulatorOperations.has(simulator.udid)
      ? {
          action: simulatorOperations.get(simulator.udid)!.action,
          startedAt: simulatorOperations.get(simulator.udid)!.startedAt,
        }
      : null,
  }));
  const state = loadState();
  const agentSessions = getAgentSessions();
  const deviceAgents = attributeAgents(
    [
      ...simulators.map((simulator) => simulator.udid),
      ...emulators.map((emulator) => emulator.avd),
    ],
    state.sessions.filter(sessionIsActive),
    agentSessions,
  );
  const sessions = await Promise.all(
    state.sessions.map(async (session) => ({
      ...session,
      platform: sessionPlatform(session),
      processRunning: session.metroPid !== null && isProcessRunning(session.metroPid),
      healthy:
        session.mode === "release"
          ? true
          : session.port !== null && (await metroHealthy(session.port)),
    })),
  );
  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    projectName: PROJECT_CONFIG.projectName,
    dashboardBuild: dashboardBuild(),
    config: {
      variants: VARIANTS,
      nativeAuth: PROJECT_CONFIG.nativeAuth ?? null,
      appProcessNames: PROJECT_CONFIG.appProcessNames || [],
      metroMaxWorkers: FLEET_CONFIG.metroMaxWorkers,
      screenshotRefreshMs: FLEET_CONFIG.screenshotRefreshMs,
    },
    memory,
    worktrees,
    simulators: simulatorsWithSlimState.map((simulator) => ({
      ...simulator,
      platform: "ios" as const,
      agents: deviceAgents.get(simulator.udid) || [],
    })),
    simSlim,
    emulators: emulators.map((emulator) => ({
      ...emulator,
      operation: emulatorOperations.has(emulator.avd)
        ? {
            action: emulatorOperations.get(emulator.avd)!.action,
            startedAt: emulatorOperations.get(emulator.avd)!.startedAt,
          }
        : null,
      agents: deviceAgents.get(emulator.avd) || [],
    })),
    android: androidToolchain,
    autoSlim: {
      enabled: autoSlimEnabled,
      iosFreshBootSeconds: IOS_FRESH_BOOT_SECONDS,
      devices: autoSlimReport,
      optOuts: slimOptOuts(),
    },
    agentSessions,
    simulatorControl: {
      available: browserControl.installed,
      port: browserControl.port,
      running: await browserControlHealthy(),
      streamEndpoint: "/api/v1/simulators/{udid}/stream?format=mjpeg&version=v2",
    },
    metroListeners,
    topProcesses,
    sessions,
  };
}

async function readStatusPayload(): Promise<Awaited<ReturnType<typeof statusPayload>>> {
  if (cachedStatus && cachedStatus.expiresAt > Date.now()) {
    return cachedStatus.payload as Awaited<ReturnType<typeof statusPayload>>;
  }
  if (statusRequest) {
    return statusRequest as Promise<Awaited<ReturnType<typeof statusPayload>>>;
  }
  const requestRevision = statusRevision;
  statusRequest = statusPayload();
  try {
    const payload = await statusRequest;
    if (requestRevision === statusRevision) {
      cachedStatus = { expiresAt: Date.now() + 3000, payload };
    }
    return payload as Awaited<ReturnType<typeof statusPayload>>;
  } finally {
    statusRequest = null;
  }
}

async function runSimulatorAction(action: SimulatorAction, udid: string): Promise<void> {
  const active = simulatorOperations.get(udid);
  if (active) {
    console.info(
      `${new Date().toISOString()} [sim-fleet] simulator-operation`,
      JSON.stringify({
        event: "deduplicated",
        udid,
        requestedAction: action,
        activeAction: active.action,
      }),
    );
    if (active.action === action) return active.promise;
    throw new HttpError(
      `Simulator ${udid} is already running ${active.action}; wait for that operation to finish`,
      409,
    );
  }

  const operationId = `${udid.slice(0, 8)}-${action}-${Date.now().toString(36)}`;
  const startedAtMs = Date.now();
  const operation = simulatorAction(action, udid);
  simulatorOperations.set(udid, {
    action,
    startedAt: new Date().toISOString(),
    promise: operation,
  });
  invalidateStatus();
  console.info(
    `${new Date().toISOString()} [sim-fleet] simulator-operation`,
    JSON.stringify({ event: "started", operationId, udid, action }),
  );
  try {
    await operation;
    recordSlimIntent(udid, "ios", action);
    console.info(
      `${new Date().toISOString()} [sim-fleet] simulator-operation`,
      JSON.stringify({
        event: "completed",
        operationId,
        udid,
        action,
        durationMs: Date.now() - startedAtMs,
      }),
    );
  } catch (error) {
    console.error(
      `${new Date().toISOString()} [sim-fleet] simulator-operation`,
      JSON.stringify({
        event: "failed",
        operationId,
        udid,
        action,
        durationMs: Date.now() - startedAtMs,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  } finally {
    simulatorOperations.delete(udid);
    invalidateStatus();
  }
}

/**
 * Devices are slim by default. Restoring or booting stock records an explicit
 * opt-out that auto-slim respects; slimming or a normal boot clears it.
 */
function recordSlimIntent(deviceId: string, platform: DevicePlatform, action: string): void {
  if (action === "restore" || action === "boot-stock") setSlimOptOut(deviceId, platform, true);
  if (action === "slim" || action === "boot") setSlimOptOut(deviceId, platform, false);
}

async function runEmulatorAction(
  action: EmulatorAction,
  avd: string,
  options: EmulatorActionOptions,
): Promise<void> {
  const active = emulatorOperations.get(avd);
  if (active) {
    if (active.action === action) return active.promise;
    throw new HttpError(
      `Emulator ${avd} is already running ${active.action}; wait for it to finish`,
      409,
    );
  }
  if (action === "shutdown") closeAndroidStream(avd);
  const needsBootSlot = action === "boot" || action === "slim";
  const operation = needsBootSlot
    ? (emulatorBootQueue = emulatorBootQueue.then(
        () => emulatorAction(action, avd, options),
        () => emulatorAction(action, avd, options),
      ))
    : emulatorAction(action, avd, options);
  emulatorOperations.set(avd, { action, startedAt: new Date().toISOString(), promise: operation });
  invalidateStatus();
  const startedAtMs = Date.now();
  try {
    await operation;
    recordSlimIntent(avd, "android", options.stock && action === "boot" ? "boot-stock" : action);
    console.info(
      `${new Date().toISOString()} [sim-fleet] emulator-operation`,
      JSON.stringify({ event: "completed", avd, action, durationMs: Date.now() - startedAtMs }),
    );
  } catch (error) {
    console.error(
      `${new Date().toISOString()} [sim-fleet] emulator-operation`,
      JSON.stringify({
        event: "failed",
        avd,
        action,
        durationMs: Date.now() - startedAtMs,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  } finally {
    emulatorOperations.delete(avd);
    invalidateStatus();
  }
}

const UUID_PATTERN = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i;

function devicePlatformFor(deviceId: string, requested?: unknown): DevicePlatform {
  if (requested === "ios" || requested === "android") return requested;
  if (UUID_PATTERN.test(deviceId)) return "ios";
  if (listInstalledAvds().some((avd) => avd.name === deviceId)) return "android";
  throw new HttpError(`Unknown device ${deviceId}: not a simulator UDID or installed AVD`, 404);
}

/** Records which agent session drove a device, from the CLI's identity headers. */
function recordTouch(request: Request, deviceId: string, platform: DevicePlatform): void {
  const agent = request.headers.get(AGENT_HEADER);
  const sessionId = request.headers.get(SESSION_HEADER);
  if (!agent || !sessionId || !/^[\w.-]{1,40}$/.test(agent) || sessionId.length > 200) return;
  try {
    recordAttachment({ deviceId, platform, agent, sessionId, source: "touch" });
  } catch (error) {
    console.warn("[sim-fleet] could not record agent touch", error);
  }
}

async function startSession(request: Request): Promise<Response> {
  const input = await body(request);
  if (
    typeof input.worktreePath !== "string" ||
    typeof input.simulatorUdid !== "string" ||
    !isAppEnvironment(input.environment) ||
    !isBuildMode(input.mode)
  ) {
    return errorResponse("worktreePath, simulatorUdid, environment, and mode are required");
  }
  const platform = devicePlatformFor(input.simulatorUdid, input.platform);
  if (platform === "android" && input.mode === "release") {
    return errorResponse(
      "Android release lanes are not supported yet; start a debug lane on the emulator instead",
    );
  }
  if (PROJECT_CONFIG.metro?.driver === "react-native" && input.mode === "release") {
    return errorResponse("React Native CLI release lanes are not supported; use a debug lane");
  }
  const worktrees = await getWorktrees(repoRoot);
  const worktree = worktrees.find((candidate) => candidate.path === input.worktreePath);
  if (!worktree) return errorResponse("Unknown worktree path");
  const currentState = loadState();
  if (
    currentState.sessions.some(
      (session) => session.worktreePath === worktree.path && sessionIsActive(session),
    )
  ) {
    return errorResponse("This worktree already has a managed Metro session");
  }
  if (
    currentState.sessions.some(
      (session) => session.simulatorUdid === input.simulatorUdid && sessionIsActive(session),
    )
  ) {
    return errorResponse("This device is already assigned to a managed lane");
  }
  const variant = getVariant(input.environment, input.mode);
  let port: number | null = null;
  if (input.mode === "release" && input.preferredPort !== undefined) {
    return errorResponse("release lanes embed their JS bundle and do not lease a Metro port");
  }
  if (input.mode === "debug" && input.preferredPort !== undefined) {
    if (!Number.isInteger(input.preferredPort)) {
      return errorResponse("preferredPort must be an integer");
    }
    port = Number(input.preferredPort);
    const [start, end] = variant.portRange;
    if (port < start || port > end) {
      return errorResponse(`preferredPort must be within ${start}-${end} for this variant`);
    }
    if (
      currentState.sessions.some((session) => session.port === port && sessionIsActive(session)) ||
      !(await isPortAvailable(port))
    ) {
      return errorResponse(`Metro port ${port} is already in use`, 409);
    }
  } else if (input.mode === "debug") {
    port = await allocatePort(input.environment, input.mode, currentState.sessions);
  }
  const id = sessionId(worktree.branch, input.simulatorUdid);
  const base: FleetSession = {
    id,
    platform,
    branch: worktree.branch,
    worktreePath: worktree.path,
    simulatorUdid: input.simulatorUdid,
    environment: input.environment,
    mode: input.mode,
    bundleId: variant.bundleId,
    port,
    metroPid: null,
    logPath: logPathFor(id),
    startedAt: new Date().toISOString(),
  };
  const session: FleetSession =
    input.mode === "debug"
      ? {
          ...base,
          metroPid: startMetro({ ...base, port: port as number }),
        }
      : base;
  updateState((state) => {
    state.sessions = state.sessions.filter(
      (existing) =>
        existing.worktreePath !== session.worktreePath &&
        existing.simulatorUdid !== session.simulatorUdid,
    );
    state.sessions.push(session);
  });
  recordTouch(request, session.simulatorUdid, platform);
  invalidateStatus();
  return json({ session }, { status: 201 });
}

async function stopSession(id: string): Promise<Response> {
  const state = loadState();
  const session = state.sessions.find((candidate) => candidate.id === id);
  if (!session) return errorResponse("Unknown fleet session", 404);
  await stopManagedMetro(session);
  if (sessionPlatform(session) === "android")
    await removeLaneReverse(session).catch(() => undefined);
  state.sessions = state.sessions.filter((candidate) => candidate.id !== id);
  saveState(state);
  invalidateStatus();
  return json({ stopped: id });
}

async function waitForMetro(session: FleetSession, timeoutMs = 15_000): Promise<boolean> {
  if (session.port === null) return false;
  const deadline = Date.now() + timeoutMs;
  do {
    if (await metroHealthy(session.port)) return true;
    if (session.metroPid !== null && !isProcessRunning(session.metroPid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return false;
}

async function launchLane(id: string): Promise<Record<string, unknown>> {
  const session = loadState().sessions.find((candidate) => candidate.id === id);
  if (!session) throw new HttpError("Unknown fleet session", 404);
  if (session.mode === "debug" && !(await waitForMetro(session))) {
    throw new HttpError(`Metro on port ${session.port} is not ready yet`, 409);
  }
  if (session.mode === "release") {
    const release = await createRebundledRelease(
      session.worktreePath,
      session.simulatorUdid,
      session.environment,
    );
    return { launched: id, delivery: "embedded-release-bundle", ...release };
  }
  if (sessionPlatform(session) === "android") {
    const android = await configureAndLaunchAndroid(session);
    return { launched: id, delivery: "metro", platform: "android", ...android };
  }
  await configureAndLaunch(session);
  return { launched: id, delivery: "metro", platform: "ios" };
}

async function launchSession(id: string): Promise<Response> {
  return json(await launchLane(id));
}

function startLaneLaunchJob(laneId: string): LaneLaunchJob {
  const existing = [...laneLaunchJobs.values()].find(
    (job) => job.laneId === laneId && job.status === "running",
  );
  if (existing) return existing;
  const job: LaneLaunchJob = {
    id: `launch-${laneId.slice(0, 28)}-${Date.now().toString(36)}`,
    laneId,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  laneLaunchJobs.set(job.id, job);
  void launchLane(laneId).then(
    (result) => {
      job.status = "complete";
      job.result = result;
      invalidateStatus();
    },
    (error) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    },
  );
  return job;
}

function laneDeepLink(session: FleetSession, input: Record<string, unknown>): string {
  if (typeof input.url !== "string" || input.url.trim().length === 0) {
    throw new Error("url is required");
  }
  const requested = input.url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(requested)) return requested;
  const scheme = getVariant(session.environment, session.mode).scheme;
  return `${scheme}://${requested.replace(/^\/+/, "")}`;
}

function browserControlTarget(url: URL): URL | null {
  const match = url.pathname.match(
    /^\/api(?:\/v1)?\/simulators\/([A-F0-9-]+)\/(definition|stream)$/i,
  );
  if (!match) return null;
  const extension = match[2] === "definition" ? "definition.json" : "stream";
  const pathname = `/simulators/${match[1]}/${extension}`;
  return new URL(
    `${pathname}${url.search}`,
    `http://${FLEET_CONFIG.host}:${FLEET_CONFIG.browserControlPort}`,
  );
}

const simulatorButtons = new Set([
  "home",
  "lock",
  "power",
  "volume-up",
  "volume-down",
  "action",
  "app-switcher",
  "swipe-to-app-switcher",
  "swipe-to-home",
  "pull-down-to-lock-screen",
  "pull-down-to-notification-center",
]);
const simulatorOrientations = new Set([
  "portrait",
  "landscape-left",
  "landscape-right",
  "portrait-upside-down",
]);

function finiteNumber(input: Record<string, unknown>, name: string): number {
  const value = input[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function parseSimulatorInput(input: Record<string, unknown>): SimulatorInput {
  switch (input.kind) {
    case "tap":
    case "double-tap":
      return {
        kind: input.kind,
        x: finiteNumber(input, "x"),
        y: finiteNumber(input, "y"),
        width: finiteNumber(input, "width"),
        height: finiteNumber(input, "height"),
      };
    case "swipe":
      return {
        kind: "swipe",
        startX: finiteNumber(input, "startX"),
        startY: finiteNumber(input, "startY"),
        endX: finiteNumber(input, "endX"),
        endY: finiteNumber(input, "endY"),
        width: finiteNumber(input, "width"),
        height: finiteNumber(input, "height"),
        durationSeconds:
          input.durationSeconds === undefined ? undefined : finiteNumber(input, "durationSeconds"),
      };
    case "text":
      if (typeof input.text !== "string" || input.text.length === 0) {
        throw new Error("text must be a non-empty string");
      }
      return { kind: "text", text: input.text };
    case "key":
      if (typeof input.code !== "string" || input.code.length === 0) {
        throw new Error("code must be a non-empty W3C KeyboardEvent.code string");
      }
      if (
        input.modifiers !== undefined &&
        (!Array.isArray(input.modifiers) ||
          input.modifiers.some((modifier) => typeof modifier !== "string"))
      ) {
        throw new Error("modifiers must be an array of strings");
      }
      return { kind: "key", code: input.code, modifiers: input.modifiers as string[] | undefined };
    case "button":
      if (typeof input.button !== "string" || !simulatorButtons.has(input.button)) {
        throw new Error(`Unsupported simulator button: ${String(input.button)}`);
      }
      return {
        kind: "button",
        button: input.button as Extract<SimulatorInput, { kind: "button" }>["button"],
      };
    case "orientation":
      if (typeof input.orientation !== "string" || !simulatorOrientations.has(input.orientation)) {
        throw new Error(`Unsupported simulator orientation: ${String(input.orientation)}`);
      }
      return {
        kind: "orientation",
        orientation: input.orientation as Extract<
          SimulatorInput,
          { kind: "orientation" }
        >["orientation"],
      };
    case "open-url":
      if (typeof input.url !== "string" || input.url.length === 0) {
        throw new Error("url must be a non-empty string");
      }
      return { kind: "open-url", url: input.url };
    case "shake":
      return { kind: "shake" };
    default:
      throw new Error(`Unsupported simulator input kind: ${String(input.kind)}`);
  }
}

function optionalNumber(input: Record<string, unknown>, name: string): number | undefined {
  return input[name] === undefined ? undefined : finiteNumber(input, name);
}

const androidOrientations = new Set([
  "portrait",
  "landscape-left",
  "landscape-right",
  "portrait-upside-down",
]);

function parseAndroidInput(input: Record<string, unknown>): AndroidInput {
  switch (input.kind) {
    case "tap":
    case "double-tap":
    case "long-press":
      return {
        kind: input.kind,
        x: finiteNumber(input, "x"),
        y: finiteNumber(input, "y"),
        width: optionalNumber(input, "width"),
        height: optionalNumber(input, "height"),
      };
    case "swipe":
      return {
        kind: "swipe",
        startX: finiteNumber(input, "startX"),
        startY: finiteNumber(input, "startY"),
        endX: finiteNumber(input, "endX"),
        endY: finiteNumber(input, "endY"),
        width: optionalNumber(input, "width"),
        height: optionalNumber(input, "height"),
        durationSeconds: optionalNumber(input, "durationSeconds"),
      };
    case "text":
      if (typeof input.text !== "string" || input.text.length === 0) {
        throw new Error("text must be a non-empty string");
      }
      return { kind: "text", text: input.text };
    case "key":
      if (typeof input.code !== "string" || input.code.length === 0) {
        throw new Error("code must be a W3C KeyboardEvent.code, KEYCODE_* name, or keycode number");
      }
      return { kind: "key", code: input.code };
    case "button":
      if (
        typeof input.button !== "string" ||
        !ANDROID_BUTTONS.includes(input.button as AndroidButton)
      ) {
        throw new Error(`Unsupported Android button: ${String(input.button)}`);
      }
      return { kind: "button", button: input.button as AndroidButton };
    case "orientation":
      if (typeof input.orientation !== "string" || !androidOrientations.has(input.orientation)) {
        throw new Error(`Unsupported orientation: ${String(input.orientation)}`);
      }
      return {
        kind: "orientation",
        orientation: input.orientation as Extract<
          AndroidInput,
          { kind: "orientation" }
        >["orientation"],
      };
    case "open-url":
      if (typeof input.url !== "string" || input.url.length === 0) {
        throw new Error("url must be a non-empty string");
      }
      return { kind: "open-url", url: input.url };
    case "dev-menu":
    case "shake":
      return { kind: "dev-menu" };
    default:
      throw new Error(`Unsupported Android input kind: ${String(input.kind)}`);
  }
}

async function portPayload() {
  const state = loadState();
  const variants: Array<{
    environment: string;
    mode: string;
    range: readonly [number, number] | null;
    leasedPorts: number[];
    leases: Array<{
      port: number;
      laneId: string;
      mode: string;
      branch: string;
      worktreePath: string;
      simulatorUdid: string;
    }>;
    nextAvailablePort: number | null;
  }> = [];
  for (const [environment, modes] of Object.entries(VARIANTS)) {
    for (const [mode, variant] of Object.entries(modes)) {
      variants.push({
        environment,
        mode,
        range: mode === "debug" ? variant.portRange : null,
        leasedPorts: state.sessions
          .filter(
            (session) =>
              session.environment === environment &&
              session.mode === "debug" &&
              session.port !== null &&
              session.metroPid !== null &&
              isProcessRunning(session.metroPid),
          )
          .map((session) => session.port as number),
        leases: state.sessions
          .filter(
            (session) =>
              session.environment === environment &&
              session.mode === "debug" &&
              session.port !== null &&
              session.metroPid !== null &&
              isProcessRunning(session.metroPid),
          )
          .map((session) => ({
            port: session.port as number,
            laneId: session.id,
            mode: session.mode,
            branch: session.branch,
            worktreePath: session.worktreePath,
            simulatorUdid: session.simulatorUdid,
          })),
        nextAvailablePort:
          mode === "debug"
            ? await allocatePort(
                environment as Parameters<typeof allocatePort>[0],
                mode as Parameters<typeof allocatePort>[1],
                state.sessions,
              ).catch(() => null)
            : null,
      });
    }
  }
  return { allocation: "leased-by-lane", variants };
}

function capabilitiesPayload() {
  return {
    apiVersion: "v1",
    transport: "http-and-websocket",
    lifecycleActions: ["boot", "slim", "restore", "shutdown", "open"],
    platforms: {
      ios: {
        lifecycleActions: ["boot", "slim", "restore", "shutdown", "open"],
        deviceId: "simulator UDID",
      },
      android: {
        lifecycleActions: ["boot", "slim", "restore", "shutdown", "tune"],
        deviceId: "AVD name",
        inputKinds: [
          "tap",
          "double-tap",
          "long-press",
          "swipe",
          "text",
          "key",
          "button",
          "orientation",
          "open-url",
          "dev-menu",
        ],
        buttons: ANDROID_BUTTONS,
        coordinateSpace: "device pixels, or a scaled frame when width/height are supplied",
        laneModes: ["debug"],
      },
    },
    agentAttribution: {
      headers: [AGENT_HEADER, SESSION_HEADER],
      sources: ["claim", "touch", "lane-worktree"],
    },
    inputKinds: [
      "tap",
      "double-tap",
      "swipe",
      "text",
      "key",
      "button",
      "orientation",
      "open-url",
      "shake",
    ],
    resources: {
      status: "/api/v1/status",
      ports: "/api/v1/ports",
      lanes: "/api/v1/lanes",
      worktreeCreate: "/api/v1/worktrees",
      simulators: "/api/v1/simulators/{udid}",
      simulatorCreationOptions: "/api/v1/simulator-creation-options",
      nativeBuildPlan: "/api/v1/native-builds/plan?worktreePath=...&mode=debug&simulatorUdid=...",
      nativeBuildEnsure: "/api/v1/native-builds/ensure",
      nativeBuildJob: "/api/v1/native-builds/jobs/{jobId}",
      laneLaunchJob: "/api/v1/lanes/launch-jobs/{jobId}",
      simulatorActionJob: "/api/v1/simulators/jobs/{jobId}",
      stream: "/api/v1/simulators/{udid}/stream?format=mjpeg&version=v2",
      emulators: "/api/v1/emulators/{avd}",
      emulatorActionJob: "/api/v1/emulators/jobs/{jobId}",
      emulatorScreenshot: "/api/v1/emulators/{avd}/screenshot",
      emulatorStream: "ws /api/v1/emulators/{avd}/stream (H.264 via scrcpy; JSON touch/scroll/key/text/button in)",
      agents: "/api/v1/agents",
      deviceClaim: "/api/v1/devices/{deviceId}/claim",
    },
  };
}

async function proxyBrowserControl(request: Request, target: URL): Promise<Response> {
  const upstream = await fetch(target, {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  const headers = new Headers(upstream.headers);
  if (headers.get("content-type")?.includes("text/html")) {
    headers.delete("content-security-policy");
    headers.delete("x-frame-options");
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

type ControlSocketData =
  | {
      kind: "ios";
      upstreamUrl: string;
      upstream?: WebSocket;
      pending: Array<string | Uint8Array<ArrayBuffer>>;
    }
  | { kind: "android"; avd: string; viewer?: StreamViewer };

const ANDROID_STREAM_PATH = /^\/api\/v1\/emulators\/([^/]+)\/stream$/;

const server = Bun.serve<ControlSocketData>({
  hostname: FLEET_CONFIG.host,
  port: FLEET_CONFIG.dashboardPort,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      const androidStream = url.pathname.match(ANDROID_STREAM_PATH);
      if (androidStream && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const avd = decodeURIComponent(androidStream[1]!);
        if (!isAvdName(avd)) return errorResponse("Invalid AVD name", 400);
        if (!(await androidStreamAvailable())) {
          return errorResponse("scrcpy is not installed; install it with `brew install scrcpy`", 501);
        }
        recordTouch(request, avd, "android");
        if (server.upgrade(request, { data: { kind: "android", avd } })) return;
        return errorResponse("Could not open emulator stream WebSocket", 502);
      }
      const controlTarget = browserControlTarget(url);
      if (controlTarget && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        controlTarget.protocol = controlTarget.protocol === "https:" ? "wss:" : "ws:";
        if (
          server.upgrade(request, {
            data: { kind: "ios", upstreamUrl: controlTarget.toString(), pending: [] },
          })
        ) {
          return;
        }
        return errorResponse("Could not open browser-control WebSocket", 502);
      }
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(dashboardIndex(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return json(await readStatusPayload());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/status") {
        return json(await readStatusPayload());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/capabilities") {
        return json(capabilitiesPayload());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/ports") {
        return json(await portPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/v1/worktrees") {
        const input = await body(request);
        if (
          typeof input.name !== "string" ||
          typeof input.branch !== "string" ||
          (input.startPoint !== undefined && typeof input.startPoint !== "string")
        ) {
          return errorResponse("name and branch are required; startPoint is optional");
        }
        const worktree = createFleetWorktree(
          repoRoot,
          input.name,
          input.branch,
          input.startPoint || "HEAD",
        );
        invalidateStatus();
        return json({ worktree }, { status: 201 });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/native-builds/plan") {
        if (PROJECT_CONFIG.metro?.driver === "react-native") {
          return errorResponse("The native build cache supports Expo projects only");
        }
        const worktreePath = url.searchParams.get("worktreePath");
        const mode = url.searchParams.get("mode");
        const simulatorUdid = url.searchParams.get("simulatorUdid") || undefined;
        if (!worktreePath || !isBuildMode(mode)) {
          return errorResponse("worktreePath and mode=debug|release are required");
        }
        const worktrees = await getWorktrees(repoRoot);
        if (!worktrees.some((candidate) => candidate.path === worktreePath)) {
          return errorResponse("Unknown worktree path");
        }
        return json(await nativeBuildPlan(worktreePath, mode, simulatorUdid));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/native-builds/ensure") {
        if (PROJECT_CONFIG.metro?.driver === "react-native") {
          return errorResponse("The native build cache supports Expo projects only");
        }
        const input = await body(request);
        if (
          typeof input.worktreePath !== "string" ||
          typeof input.simulatorUdid !== "string" ||
          !isBuildMode(input.mode)
        ) {
          return errorResponse("worktreePath, simulatorUdid, and mode=debug|release are required");
        }
        const worktrees = await getWorktrees(repoRoot);
        if (!worktrees.some((candidate) => candidate.path === input.worktreePath)) {
          return errorResponse("Unknown worktree path");
        }
        const id = `native-${input.mode}-${input.simulatorUdid.slice(0, 8)}-${Date.now().toString(36)}`;
        const job: NativeEnsureJob = {
          id,
          worktreePath: input.worktreePath,
          simulatorUdid: input.simulatorUdid,
          mode: input.mode,
          status: "running",
          startedAt: new Date().toISOString(),
        };
        nativeEnsureJobs.set(id, job);
        void ensureNativeShell(input.worktreePath, input.simulatorUdid, input.mode).then(
          (result) => {
            job.status = "complete";
            job.result = result;
            invalidateStatus();
          },
          (error) => {
            job.status = "failed";
            job.error = error instanceof Error ? error.message : String(error);
          },
        );
        return json({ job }, { status: 202 });
      }
      const nativeJobMatch = url.pathname.match(/^\/api\/v1\/native-builds\/jobs\/([^/]+)$/);
      if (request.method === "GET" && nativeJobMatch) {
        const job = nativeEnsureJobs.get(nativeJobMatch[1]);
        if (!job) return errorResponse("Unknown native build job", 404);
        return json({ job });
      }
      const launchJobMatch = url.pathname.match(/^\/api\/v1\/lanes\/launch-jobs\/([^/]+)$/);
      if (request.method === "GET" && launchJobMatch) {
        const job = laneLaunchJobs.get(launchJobMatch[1]);
        if (!job) return errorResponse("Unknown lane launch job", 404);
        return json({ job });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/simulator-creation-options") {
        return json(await getSimulatorCreationOptions());
      }
      if (request.method === "POST" && url.pathname === "/api/v1/simulators") {
        const input = await body(request);
        if (
          typeof input.name !== "string" ||
          input.name.trim().length === 0 ||
          input.name.length > 80 ||
          typeof input.deviceTypeIdentifier !== "string" ||
          !input.deviceTypeIdentifier.startsWith("com.apple.CoreSimulator.SimDeviceType.") ||
          typeof input.runtimeIdentifier !== "string" ||
          !input.runtimeIdentifier.startsWith("com.apple.CoreSimulator.SimRuntime.")
        ) {
          return errorResponse(
            "name, a CoreSimulator deviceTypeIdentifier, and a CoreSimulator runtimeIdentifier are required",
          );
        }
        const udid = await createSimulator(
          input.name.trim(),
          input.deviceTypeIdentifier,
          input.runtimeIdentifier,
        );
        invalidateStatus();
        return json(
          { simulator: { udid, name: input.name.trim(), state: "Shutdown" } },
          { status: 201 },
        );
      }
      if (request.method === "GET" && url.pathname === "/api/v1/agents") {
        const status = await readStatusPayload();
        const devices = [
          ...status.simulators.map((device) => ({
            platform: "ios",
            deviceId: device.udid,
            name: device.name,
            state: device.state,
            agents: device.agents,
          })),
          ...status.emulators.map((device) => ({
            platform: "android",
            deviceId: device.avd,
            name: device.displayName,
            state: device.state,
            agents: device.agents,
          })),
        ];
        return json({ sessions: status.agentSessions, devices });
      }
      const claimMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/claim$/);
      if (claimMatch && (request.method === "POST" || request.method === "DELETE")) {
        const deviceId = decodeURIComponent(claimMatch[1]);
        const input = request.method === "POST" ? await body(request) : {};
        const agent =
          (typeof input.agent === "string" && input.agent) || request.headers.get(AGENT_HEADER);
        const sessionId =
          (typeof input.sessionId === "string" && input.sessionId) ||
          request.headers.get(SESSION_HEADER);
        if (!agent || !sessionId) {
          return errorResponse(
            `agent and sessionId are required (body or ${AGENT_HEADER}/${SESSION_HEADER} headers)`,
          );
        }
        const platform = devicePlatformFor(deviceId, input.platform);
        invalidateStatus();
        if (request.method === "DELETE") {
          return json({ released: releaseAttachment(deviceId, agent, sessionId), deviceId });
        }
        const attachment = recordAttachment({
          deviceId,
          platform,
          agent,
          sessionId,
          source: "claim",
          note: typeof input.note === "string" ? input.note.slice(0, 200) : undefined,
        });
        return json({ attachment }, { status: 201 });
      }
      const emulatorJobMatch = url.pathname.match(/^\/api\/v1\/emulators\/jobs\/([^/]+)$/);
      if (request.method === "GET" && emulatorJobMatch) {
        const job = emulatorActionJobs.get(emulatorJobMatch[1]);
        if (!job) return errorResponse("Unknown emulator action job", 404);
        return json({ job });
      }
      const emulatorMatch = url.pathname.match(
        /^\/api\/v1\/emulators\/([^/]+)\/(boot|slim|restore|shutdown|tune|screenshot|definition|ui|input)$/,
      );
      if (emulatorMatch) {
        const avd = decodeURIComponent(emulatorMatch[1]);
        if (!isAvdName(avd)) return errorResponse("Invalid AVD name");
        const operation = emulatorMatch[2];
        if (request.method === "GET" && operation === "screenshot") {
          return new Response(new Blob([(await emulatorScreenshot(avd)) as Uint8Array<ArrayBuffer>]), {
            headers: { "content-type": "image/png", "cache-control": "no-store" },
          });
        }
        if (request.method === "GET" && operation === "definition") {
          return json(await emulatorDefinition(avd));
        }
        if (request.method === "GET" && operation === "ui") {
          const x = url.searchParams.get("x");
          const y = url.searchParams.get("y");
          if ((x === null) !== (y === null))
            return errorResponse("x and y must be supplied together");
          const point = x === null ? undefined : { x: Number(x), y: Number(y) };
          if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y))) {
            return errorResponse("x and y must be finite numbers");
          }
          recordTouch(request, avd, "android");
          return json({ tree: await describeEmulatorUi(avd, point) });
        }
        if (request.method === "POST" && operation === "input") {
          const input = parseAndroidInput(await body(request));
          recordTouch(request, avd, "android");
          await sendEmulatorInput(avd, input);
          return json({ ok: true, inputKind: input.kind, avd });
        }
        if (
          request.method === "POST" &&
          ["boot", "slim", "restore", "shutdown", "tune"].includes(operation)
        ) {
          const action = operation as EmulatorAction;
          let options: EmulatorActionOptions = {};
          if (request.headers.get("content-length") !== "0" && request.body) {
            const input = await body(request).catch(() => ({}) as Record<string, unknown>);
            options = {
              headless: typeof input.headless === "boolean" ? input.headless : undefined,
              cold: input.cold === true,
              stock: input.stock === true,
            };
          }
          recordTouch(request, avd, "android");
          const id = `emu-${action}-${avd.slice(0, 16)}-${Date.now().toString(36)}`;
          const job: EmulatorActionJob = {
            id,
            avd,
            action,
            status: "running",
            startedAt: new Date().toISOString(),
          };
          emulatorActionJobs.set(id, job);
          void runEmulatorAction(action, avd, options).then(
            () => {
              job.status = "complete";
              job.result = { ok: true, action, avd };
            },
            (error) => {
              job.status = "failed";
              job.error = error instanceof Error ? error.message : String(error);
            },
          );
          return json(
            { job, pollUrl: `/api/v1/emulators/jobs/${encodeURIComponent(id)}` },
            { status: 202 },
          );
        }
        return errorResponse("Method not allowed", 405);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/lanes") {
        const status = await readStatusPayload();
        return json({ lanes: status.sessions });
      }
      const screenshotMatch = url.pathname.match(
        /^\/api(?:\/v1)?\/simulators\/([A-F0-9-]+)\/screenshot$/i,
      );
      if (request.method === "GET" && screenshotMatch) {
        return new Response(new Blob([(await screenshot(screenshotMatch[1])) as Uint8Array<ArrayBuffer>]), {
          headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
        });
      }
      const uiMatch = url.pathname.match(/^\/api\/v1\/simulators\/([A-F0-9-]+)\/ui$/i);
      if (request.method === "GET" && uiMatch) {
        const x = url.searchParams.get("x");
        const y = url.searchParams.get("y");
        if ((x === null) !== (y === null)) {
          return errorResponse("x and y must be supplied together");
        }
        const point =
          x === null ? undefined : { x: Number.parseFloat(x), y: Number.parseFloat(y as string) };
        if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y))) {
          return errorResponse("x and y must be finite numbers");
        }
        recordTouch(request, uiMatch[1], "ios");
        return json({ tree: await describeSimulatorUi(uiMatch[1], point) });
      }
      const simulatorMatch = url.pathname.match(
        /^\/api(?:\/v1)?\/simulators\/([A-F0-9-]+)\/(boot|shutdown|open|slim|restore)$/i,
      );
      if (request.method === "POST" && simulatorMatch) {
        const simulatorUdid = simulatorMatch[1];
        let action = simulatorMatch[2].toLowerCase() as SimulatorAction;
        if (action === "boot" && request.body) {
          const input = await body(request).catch(() => ({}) as Record<string, unknown>);
          if (input.stock === true) action = "boot-stock";
        }
        recordTouch(request, simulatorUdid, "ios");
        const id = `sim-${action}-${simulatorUdid.slice(0, 8)}-${Date.now().toString(36)}`;
        const job: SimulatorActionJob = {
          id,
          simulatorUdid,
          action,
          status: "running",
          startedAt: new Date().toISOString(),
        };
        simulatorActionJobs.set(id, job);
        void runSimulatorAction(action, simulatorUdid).then(
          () => {
            job.status = "complete";
            job.result = { ok: true, action, simulatorUdid };
          },
          (error) => {
            job.status = "failed";
            job.error = error instanceof Error ? error.message : String(error);
          },
        );
        return json(
          { job, pollUrl: `/api/v1/simulators/jobs/${encodeURIComponent(id)}` },
          { status: 202 },
        );
      }
      const simulatorJobMatch = url.pathname.match(/^\/api\/v1\/simulators\/jobs\/([^/]+)$/);
      if (request.method === "GET" && simulatorJobMatch) {
        const job = simulatorActionJobs.get(simulatorJobMatch[1]);
        if (!job) return errorResponse("Unknown simulator action job", 404);
        return json({ job });
      }
      const inputMatch = url.pathname.match(/^\/api\/v1\/simulators\/([A-F0-9-]+)\/input$/i);
      if (request.method === "POST" && inputMatch) {
        const input = parseSimulatorInput(await body(request));
        recordTouch(request, inputMatch[1], "ios");
        await sendSimulatorInput(inputMatch[1], input);
        return json({ ok: true, inputKind: input.kind, simulatorUdid: inputMatch[1] });
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/api/sessions" || url.pathname === "/api/v1/lanes")
      ) {
        return await serializeSessionMutation(() => startSession(request));
      }
      const sessionMatch = url.pathname.match(
        /^\/api\/(?:sessions|v1\/lanes)\/([^/]+)\/(stop|launch|open-url)$/,
      );
      if (request.method === "POST" && sessionMatch) {
        if (sessionMatch[2] === "stop") {
          return await serializeSessionMutation(() => stopSession(sessionMatch[1]));
        }
        if (sessionMatch[2] === "launch") {
          const session = loadState().sessions.find(
            (candidate) => candidate.id === sessionMatch[1],
          );
          if (!session) return errorResponse("Unknown fleet session", 404);
          recordTouch(request, session.simulatorUdid, sessionPlatform(session));
          if (session.mode === "release") {
            const job = startLaneLaunchJob(session.id);
            return json(
              { job, pollUrl: `/api/v1/lanes/launch-jobs/${encodeURIComponent(job.id)}` },
              { status: 202 },
            );
          }
          return await launchSession(session.id);
        }
        const session = loadState().sessions.find((candidate) => candidate.id === sessionMatch[1]);
        if (!session) return errorResponse("Unknown fleet session", 404);
        const target = laneDeepLink(session, await body(request));
        recordTouch(request, session.simulatorUdid, sessionPlatform(session));
        if (sessionPlatform(session) === "android") {
          await sendEmulatorInput(session.simulatorUdid, { kind: "open-url", url: target });
        } else {
          await sendSimulatorInput(session.simulatorUdid, { kind: "open-url", url: target });
        }
        return json({
          opened: target,
          laneId: session.id,
          environment: session.environment,
          mode: session.mode,
        });
      }
      const logMatch = url.pathname.match(/^\/api\/v1\/lanes\/([^/]+)\/log$/);
      if (request.method === "GET" && logMatch) {
        const session = loadState().sessions.find((candidate) => candidate.id === logMatch[1]);
        if (!session) return errorResponse("Unknown fleet lane", 404);
        const logText = fs.existsSync(session.logPath)
          ? fs.readFileSync(session.logPath, "utf8")
          : "";
        const maxCharacters = Math.min(
          Math.max(Number.parseInt(url.searchParams.get("maxCharacters") || "20000", 10), 1000),
          200000,
        );
        return new Response(logText.slice(-maxCharacters), {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (controlTarget) return await proxyBrowserControl(request, controlTarget);
      if (request.method === "GET") {
        const asset = staticDashboardFile(url.pathname);
        if (asset) return asset;
      }
      return errorResponse("Not found", 404);
    } catch (error) {
      console.error(error);
      return errorResponse(error, error instanceof HttpError ? error.status : statusFromError(error));
    }
  },
  websocket: {
    open(socket) {
      if (socket.data.kind === "android") {
        const { avd } = socket.data;
        const viewer: StreamViewer = {
          send: (data) => void socket.send(data),
          close: (code, reason) => socket.close(code, reason),
        };
        socket.data.viewer = viewer;
        attachAndroidViewer(avd, viewer).catch((error: Error) => {
          socket.send(JSON.stringify({ type: "error", error: error.message }));
          socket.close(1011, error.message.slice(0, 120));
        });
        return;
      }
      const data = socket.data;
      const upstream = new WebSocket(data.upstreamUrl);
      upstream.binaryType = "arraybuffer";
      data.upstream = upstream;
      upstream.onopen = () => {
        for (const message of data.pending.splice(0)) upstream.send(message);
      };
      upstream.onmessage = (event) => socket.send(event.data as string | ArrayBuffer);
      upstream.onclose = () => socket.close();
      upstream.onerror = () => socket.close(1011, "Browser-control upstream failed");
    },
    message(socket, message) {
      if (socket.data.kind === "android") {
        if (typeof message === "string") handleAndroidViewerMessage(socket.data.avd, message);
        return;
      }
      const value = typeof message === "string" ? message : new Uint8Array(message);
      if (socket.data.upstream?.readyState === WebSocket.OPEN) {
        socket.data.upstream.send(value);
      } else {
        socket.data.pending.push(value);
      }
    },
    close(socket) {
      if (socket.data.kind === "android") {
        if (socket.data.viewer) detachAndroidViewer(socket.data.avd, socket.data.viewer);
        return;
      }
      socket.data.upstream?.close();
    },
  },
});

console.log(`${PROJECT_CONFIG.projectName} Sim Fleet: http://${server.hostname}:${server.port}`);
console.log(`Simulator transport: ${browserControl.url}`);
console.log(`Repository: ${repoRoot}`);
console.log(`State: ${FLEET_CONFIG.stateDirectory}`);

/**
 * Auto-slim: every device is slim unless someone explicitly opted it out.
 * Android slims live, so any running unslimmed emulator is slimmed. iOS
 * slimming reboots the simulator, so only fresh boots (for example from Xcode
 * or argent) are slimmed automatically; long-running ones are reported as
 * needing a reboot rather than being interrupted mid-test.
 */
type AutoSlimEntry = {
  deviceId: string;
  platform: DevicePlatform;
  status: "slimming" | "needs-reboot" | "opted-out" | "unavailable" | "backoff";
  reason: string;
};
const autoSlimEnabled =
  process.env.SIM_FLEET_AUTO_SLIM !== "0" && PROJECT_CONFIG.autoSlim !== false;
const IOS_FRESH_BOOT_SECONDS = 240;
const AUTO_SLIM_RETRY_MS = 10 * 60 * 1000;
const autoSlimAttempts = new Map<string, number>();
let autoSlimReport: AutoSlimEntry[] = [];
let autoSlimRunning = false;

function autoSlimLaunch(
  deviceId: string,
  platform: DevicePlatform,
  start: () => Promise<void>
): AutoSlimEntry["status"] {
  const last = autoSlimAttempts.get(deviceId);
  if (last && Date.now() - last < AUTO_SLIM_RETRY_MS) return "backoff";
  autoSlimAttempts.set(deviceId, Date.now());
  console.info(
    `${new Date().toISOString()} [sim-fleet] auto-slim`,
    JSON.stringify({ event: "started", deviceId, platform })
  );
  void start().then(
    () => autoSlimAttempts.delete(deviceId),
    (error) =>
      console.error(
        `${new Date().toISOString()} [sim-fleet] auto-slim`,
        JSON.stringify({ event: "failed", deviceId, platform, error: String(error) })
      )
  );
  return "slimming";
}

async function autoSlimTick(): Promise<void> {
  if (autoSlimRunning) return;
  autoSlimRunning = true;
  try {
    const optedOut = new Set(slimOptOuts().map((entry) => entry.deviceId));
    const processes = await getProcesses();
    const [simulators, simSlim, emulators, toolchain] = await Promise.all([
      getSimulators(processes),
      getSimSlimInventory(),
      getEmulators(processes).catch(() => []),
      getAndroidToolchain(),
    ]);
    const report: AutoSlimEntry[] = [];

    for (const simulator of simulators) {
      if (simulator.state !== "Booted" || simulatorOperations.has(simulator.udid)) continue;
      const slim = simSlim.devices.find((device) => device.udid === simulator.udid);
      if (!simSlim.installed || simSlim.stale || !slim || (slim.managedDisabled || 0) > 0) continue;
      const entry = { deviceId: simulator.udid, platform: "ios" as const };
      if (optedOut.has(simulator.udid)) {
        report.push({ ...entry, status: "opted-out", reason: "restored or booted stock on request" });
      } else if (simulator.uptimeSeconds !== null && simulator.uptimeSeconds <= IOS_FRESH_BOOT_SECONDS) {
        const status = autoSlimLaunch(simulator.udid, "ios", () =>
          runSimulatorAction("slim", simulator.udid)
        );
        report.push({ ...entry, status, reason: "booted without SimSlim" });
      } else {
        report.push({
          ...entry,
          status: "needs-reboot",
          reason: "running unslimmed; slimming reboots it, so it is not interrupted automatically",
        });
      }
    }

    for (const emulator of emulators) {
      if (emulator.state !== "Booted" || !emulator.avdSlim || emulator.avdSlim.slimmed) continue;
      if (emulatorOperations.has(emulator.avd)) continue;
      const entry = { deviceId: emulator.avd, platform: "android" as const };
      if (optedOut.has(emulator.avd)) {
        report.push({ ...entry, status: "opted-out", reason: "restored or booted stock on request" });
      } else if (!toolchain.avdslim.installed) {
        report.push({ ...entry, status: "unavailable", reason: "avdslim is not installed" });
      } else {
        const status = autoSlimLaunch(emulator.avd, "android", () =>
          runEmulatorAction("slim", emulator.avd, {})
        );
        report.push({ ...entry, status, reason: "running without avdslim" });
      }
    }
    autoSlimReport = report;
  } catch (error) {
    console.error("[sim-fleet] auto-slim tick failed", error);
  } finally {
    autoSlimRunning = false;
  }
}

if (autoSlimEnabled) {
  void autoSlimTick();
  setInterval(() => void autoSlimTick(), 15_000);
}

// The menu-bar icon follows the server's lifetime; SIM_FLEET_TRAY=0 disables it.
if (process.platform === "darwin" && process.env.SIM_FLEET_TRAY !== "0") {
  try {
    const { startTray } = await import("./tray");
    startTray(`http://${server.hostname}:${server.port}/`, process.pid);
  } catch (error) {
    console.warn(`Menu-bar icon unavailable: ${error instanceof Error ? error.message : error}`);
  }
}

function stopOwnedBrowserControl() {
  if (browserControl.owned && browserControl.pid && isProcessRunning(browserControl.pid)) {
    process.kill(browserControl.pid, "SIGTERM");
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopOwnedBrowserControl();
    server.stop();
    process.exit(0);
  });
}
process.once("exit", stopOwnedBrowserControl);
