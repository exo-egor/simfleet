import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_CONFIG, androidPackageFor, getVariant } from "./config";
import type { FleetSession } from "./state";
import { run } from "./system";

/**
 * Android emulator support. AVD names are the stable device identifiers (a
 * serial such as emulator-5554 only exists while the emulator runs), and
 * avdslim owns boot, slimming, and restore the way SimSlim does for iOS.
 */

const AVDSLIM_STATE_FILE = "/data/local/tmp/avdslim_state.json";
const AVD_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const DEFAULT_GUEST_RAM_MB = Number(process.env.SIM_FLEET_ANDROID_RAM_MB || 2048);

type ProcessLike = { pid: number; rssKb: number; command: string };

export type AndroidToolchain = {
  sdkDirectory: string | null;
  adbPath: string | null;
  emulatorPath: string | null;
  avdslim: { installed: boolean; path: string | null; version: string | null };
  avdDirectory: string;
};

export type AvdSlimState = {
  slimmed: boolean;
  preset: string | null;
  disabledPackages: number;
  slimmedAt: string | null;
};

export type EmulatorInfo = {
  platform: "android";
  avd: string;
  displayName: string;
  state: "Booted" | "Booting" | "Offline" | "Shutdown";
  serial: string | null;
  apiLevel: string | null;
  systemImage: string | null;
  abi: string | null;
  playStore: boolean;
  config: { ramMb: number | null; gpuMode: string | null; heapMb: number | null };
  tuned: boolean;
  goldenSnapshot: boolean;
  hostPid: number | null;
  rssBytes: number;
  footprintBytes: number | null;
  avdSlim: AvdSlimState | null;
};

export type EmulatorAction = "boot" | "slim" | "restore" | "shutdown" | "tune";
export type EmulatorActionOptions = { headless?: boolean; cold?: boolean; stock?: boolean };

export type AndroidInput =
  | {
      kind: "tap" | "double-tap" | "long-press";
      x: number;
      y: number;
      width?: number;
      height?: number;
    }
  | {
      kind: "swipe";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      width?: number;
      height?: number;
      durationSeconds?: number;
    }
  | { kind: "text"; text: string }
  | { kind: "key"; code: string }
  | { kind: "button"; button: AndroidButton }
  | {
      kind: "orientation";
      orientation: "portrait" | "landscape-left" | "landscape-right" | "portrait-upside-down";
    }
  | { kind: "open-url"; url: string }
  | { kind: "dev-menu" };

export const ANDROID_BUTTON_KEYCODES = {
  home: 3,
  back: 4,
  "app-switcher": 187,
  menu: 82,
  lock: 26,
  power: 26,
  "volume-up": 24,
  "volume-down": 25,
} as const;
export type AndroidButton = keyof typeof ANDROID_BUTTON_KEYCODES;
export const ANDROID_BUTTONS = Object.keys(ANDROID_BUTTON_KEYCODES) as AndroidButton[];

// W3C KeyboardEvent.code values the iOS API already accepts, mapped to keycodes.
export const W3C_KEYCODES: Record<string, number> = {
  Enter: 66,
  NumpadEnter: 66,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  Space: 62,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

const ROTATIONS = {
  portrait: 0,
  "landscape-left": 1,
  "portrait-upside-down": 2,
  "landscape-right": 3,
} as const;

/** An operation that conflicts with the device's current state (HTTP 409). */
export class DeviceStateError extends Error {
  readonly status = 409;
}

export function isAvdName(value: unknown): value is string {
  return typeof value === "string" && AVD_NAME_PATTERN.test(value);
}

function which(binary: string): string | null {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

function sdkDirectory(): string | null {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Library", "Android", "sdk"),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function avdDirectory(): string {
  const configured = process.env.ANDROID_AVD_HOME;
  if (configured && fs.existsSync(configured)) return configured;
  return path.join(os.homedir(), ".android", "avd");
}

let cachedAvdSlimVersion: { path: string; version: string | null } | null = null;

export async function getAndroidToolchain(): Promise<AndroidToolchain> {
  const sdk = sdkDirectory();
  const sdkBinary = (relative: string) => {
    if (!sdk) return null;
    const candidate = path.join(sdk, relative);
    return fs.existsSync(candidate) ? candidate : null;
  };
  const avdslimPath = process.env.AVDSLIM_BIN || which("avdslim");
  let version: string | null = null;
  if (avdslimPath) {
    if (cachedAvdSlimVersion?.path === avdslimPath) {
      version = cachedAvdSlimVersion.version;
    } else {
      const result = await run(avdslimPath, ["version"], { timeoutMs: 5_000 });
      version = result.exitCode === 0 ? result.stdout.trim().split("\n")[0] || null : null;
      cachedAvdSlimVersion = { path: avdslimPath, version };
    }
  }
  return {
    sdkDirectory: sdk,
    adbPath: which("adb") || sdkBinary("platform-tools/adb"),
    emulatorPath: sdkBinary("emulator/emulator") || which("emulator"),
    avdslim: { installed: Boolean(avdslimPath), path: avdslimPath, version },
    avdDirectory: avdDirectory(),
  };
}

async function toolchainOrThrow(): Promise<AndroidToolchain & { adbPath: string }> {
  const toolchain = await getAndroidToolchain();
  if (!toolchain.adbPath) {
    throw new Error(
      "adb was not found. Install the Android SDK platform-tools or set ANDROID_HOME.",
    );
  }
  return toolchain as AndroidToolchain & { adbPath: string };
}

function avdslimOrThrow(toolchain: AndroidToolchain): string {
  if (!toolchain.avdslim.path) {
    throw new Error(
      "avdslim is not installed. Install it with `brew tap kdbhalala/avdslim https://github.com/kdbhalala/avdslim.git && brew install avdslim`.",
    );
  }
  return toolchain.avdslim.path;
}

function readIni(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const index = line.indexOf("=");
      if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  } catch {
    // Unreadable AVD metadata is reported as unknown values.
  }
  return values;
}

type InstalledAvd = { name: string; directory: string; config: Record<string, string> };

export function listInstalledAvds(): InstalledAvd[] {
  const base = avdDirectory();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const avds: InstalledAvd[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".ini") || entry.isDirectory()) continue;
    const name = entry.name.slice(0, -".ini".length);
    const pointer = readIni(path.join(base, entry.name));
    const directory =
      pointer.path && fs.existsSync(pointer.path) ? pointer.path : path.join(base, `${name}.avd`);
    const configPath = path.join(directory, "config.ini");
    if (!fs.existsSync(configPath)) continue;
    avds.push({ name, directory, config: readIni(configPath) });
  }
  return avds.sort((left, right) => left.name.localeCompare(right.name));
}

async function adb(adbPath: string, args: string[], timeoutMs = 15_000) {
  return run(adbPath, args, { timeoutMs });
}

type RunningEmulator = {
  serial: string;
  adbState: string;
  avd: string | null;
  bootCompleted: boolean;
};

async function runningEmulators(adbPath: string): Promise<RunningEmulator[]> {
  const devices = await adb(adbPath, ["devices"], 5_000);
  if (devices.exitCode !== 0) return [];
  const rows = devices.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2 && fields[0].startsWith("emulator-"));
  return Promise.all(
    rows.map(async ([serial, adbState]) => {
      const [name, boot] = await Promise.all([
        adb(adbPath, ["-s", serial, "emu", "avd", "name"], 5_000),
        adbState === "device"
          ? adb(adbPath, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 5_000)
          : Promise.resolve(null),
      ]);
      const avd = name.exitCode === 0 ? name.stdout.split(/\r?\n/)[0].trim() || null : null;
      return { serial, adbState, avd, bootCompleted: boot?.stdout.trim() === "1" };
    }),
  );
}

async function readAvdSlimState(adbPath: string, serial: string): Promise<AvdSlimState> {
  const result = await adb(adbPath, ["-s", serial, "shell", "cat", AVDSLIM_STATE_FILE], 5_000);
  if (result.exitCode !== 0 || !result.stdout.includes("disabled_packages")) {
    return { slimmed: false, preset: null, disabledPackages: 0, slimmedAt: null };
  }
  try {
    const state = JSON.parse(result.stdout) as {
      timestamp?: string;
      preset?: string;
      disabled_packages?: string[];
    };
    return {
      slimmed: true,
      preset: state.preset || null,
      disabledPackages: state.disabled_packages?.length || 0,
      slimmedAt: state.timestamp || null,
    };
  } catch {
    return { slimmed: true, preset: null, disabledPackages: 0, slimmedAt: null };
  }
}

async function physicalFootprintBytes(pid: number): Promise<number | null> {
  const result = await run("footprint", ["--format", "bytes", "-p", String(pid)], {
    timeoutMs: 4_000,
  });
  const match = result.stdout.match(/phys_footprint:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function qemuProcessFor(processes: ProcessLike[], avd: string): ProcessLike | null {
  return (
    processes.find(
      (process) =>
        /qemu-system/.test(process.command) &&
        new RegExp(`(?:^|\\s)-avd\\s+${avd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(
          process.command,
        ),
    ) || null
  );
}

export async function getEmulators(processes: ProcessLike[]): Promise<EmulatorInfo[]> {
  const toolchain = await getAndroidToolchain();
  const installed = listInstalledAvds();
  const running = toolchain.adbPath ? await runningEmulators(toolchain.adbPath) : [];
  const emulators = await Promise.all(
    installed.map(async (avd): Promise<EmulatorInfo> => {
      const live = running.find((candidate) => candidate.avd === avd.name) || null;
      const qemu = qemuProcessFor(processes, avd.name);
      const ramMb = Number(avd.config["hw.ramSize"]?.replace(/[^\d]/g, "")) || null;
      const heapMb = Number(avd.config["vm.heapSize"]?.replace(/[^\d]/g, "")) || null;
      const gpuMode = avd.config["hw.gpu.mode"] || null;
      const systemImage = avd.config["image.sysdir.1"] || null;
      const state: EmulatorInfo["state"] = !live
        ? qemu
          ? "Booting"
          : "Shutdown"
        : live.adbState !== "device"
          ? "Offline"
          : live.bootCompleted
            ? "Booted"
            : "Booting";
      const ready = live && state === "Booted" && toolchain.adbPath;
      const [avdSlim, footprintBytes] = await Promise.all([
        ready ? readAvdSlimState(toolchain.adbPath as string, live.serial) : Promise.resolve(null),
        qemu ? physicalFootprintBytes(qemu.pid) : Promise.resolve(null),
      ]);
      return {
        platform: "android",
        avd: avd.name,
        displayName: avd.config["avd.ini.displayname"] || avd.name.replaceAll("_", " "),
        state,
        serial: live?.serial || null,
        apiLevel: systemImage?.match(/android-(\d+)/)?.[1] || null,
        systemImage,
        abi: avd.config["abi.type"] || null,
        playStore: /playstore/.test(avd.config["tag.id"] || systemImage || ""),
        config: { ramMb, gpuMode, heapMb },
        tuned: ramMb !== null && ramMb <= 2048 && gpuMode === "host",
        goldenSnapshot: fs.existsSync(path.join(avd.directory, "snapshots", "avdslim_clean")),
        hostPid: qemu?.pid || null,
        rssBytes: (qemu?.rssKb || 0) * 1024,
        footprintBytes,
        avdSlim,
      };
    }),
  );
  const rank = (emulator: EmulatorInfo) =>
    emulator.state === "Booted" ? 0 : emulator.state === "Shutdown" ? 2 : 1;
  return emulators.sort(
    (left, right) => rank(left) - rank(right) || left.avd.localeCompare(right.avd),
  );
}

async function requireInstalledAvd(avd: string): Promise<InstalledAvd> {
  const installed = listInstalledAvds().find((candidate) => candidate.name === avd);
  if (!installed) throw Object.assign(new Error(`Unknown AVD ${avd}`), { status: 404 });
  return installed;
}

export async function serialForAvd(avd: string): Promise<string | null> {
  const toolchain = await toolchainOrThrow();
  const live = (await runningEmulators(toolchain.adbPath)).find(
    (candidate) => candidate.avd === avd,
  );
  return live?.serial || null;
}

export async function requireSerial(avd: string): Promise<{ adbPath: string; serial: string }> {
  const toolchain = await toolchainOrThrow();
  const live = (await runningEmulators(toolchain.adbPath)).find(
    (candidate) => candidate.avd === avd,
  );
  if (!live || live.adbState !== "device") {
    throw new DeviceStateError(`Emulator ${avd} is not running; boot it first`);
  }
  return { adbPath: toolchain.adbPath, serial: live.serial };
}

async function waitForBoot(adbPath: string, avd: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = (await runningEmulators(adbPath)).find((candidate) => candidate.avd === avd);
    if (live?.bootCompleted) return live.serial;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Emulator ${avd} did not finish booting within ${Math.round(timeoutMs / 1000)}s`);
}

function commandError(
  result: { stdout: string; stderr: string; exitCode: number },
  fallback: string,
) {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const tail = output.split("\n").slice(-12).join("\n");
  return new Error(tail || `${fallback} (exit ${result.exitCode})`);
}

async function slimAndVerify(avdslim: string, adbPath: string, serial: string): Promise<void> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await run(
      avdslim,
      ["on", serial, ...(PROJECT_CONFIG.android?.avdslimArgs || [])],
      { timeoutMs: 180_000 },
    );
    const state = await readAvdSlimState(adbPath, serial);
    if (state.slimmed) return;
    failures.push(`attempt ${attempt}: ${commandError(result, "avdslim on failed").message}`);
  }
  throw new Error(`avdslim did not slim ${serial} after two attempts\n${failures.join("\n")}`);
}

export async function emulatorAction(
  action: EmulatorAction,
  avd: string,
  options: EmulatorActionOptions = {},
): Promise<void> {
  await requireInstalledAvd(avd);
  const toolchain = await toolchainOrThrow();
  const serial = await serialForAvd(avd);

  if (action === "tune") {
    if (serial) throw new DeviceStateError(`Shut down ${avd} before tuning its config.ini`);
    const result = await run(avdslimOrThrow(toolchain), ["tune-avd", avd], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw commandError(result, "avdslim tune-avd failed");
    return;
  }

  if (action === "shutdown") {
    if (!serial) return;
    const result = toolchain.avdslim.path
      ? await run(toolchain.avdslim.path, ["stop", serial, "-f"], { timeoutMs: 30_000 })
      : await adb(toolchain.adbPath, ["-s", serial, "emu", "kill"], 30_000);
    if (result.exitCode !== 0) throw commandError(result, "Emulator shutdown failed");
    return;
  }

  if (action === "restore") {
    if (!serial) throw new DeviceStateError(`Emulator ${avd} is not running; boot it before restoring`);
    const result = await run(avdslimOrThrow(toolchain), ["off", serial], { timeoutMs: 180_000 });
    if (result.exitCode !== 0) throw commandError(result, "avdslim off failed");
    return;
  }

  const avdslim = avdslimOrThrow(toolchain);
  if (serial) {
    if (options.stock) return;
    // Already running: slim and verify in place, exactly like a fresh boot would.
    await slimAndVerify(
      avdslim,
      toolchain.adbPath,
      await waitForBoot(toolchain.adbPath, avd, 180_000),
    );
    return;
  }

  const extraArgs = PROJECT_CONFIG.android?.avdslimArgs || [];
  const args = ["start", avd, ...extraArgs];
  // avdslim defaults to 1536 MB, which leaves API 34+ images swapping ~600 MB
  // to zram and janky to drive; 2048 MB keeps them responsive.
  if (!extraArgs.some((arg) => arg.startsWith("--ram="))) args.push(`--ram=${DEFAULT_GUEST_RAM_MB}`);
  // The fleet is browser-first like the headless iOS transport; a window is opt-in.
  if (options.headless !== false) args.push("--headless");
  if (options.cold) args.push("--cold");
  if (options.stock) args.push("--no-slim");
  const started = await run(avdslim, args, { timeoutMs: 420_000 });
  if (started.exitCode !== 0) throw commandError(started, "avdslim start failed");
  // `avdslim start` exits 0 when a slow boot outlives its own wait, so the
  // fleet confirms boot and slim state itself.
  const bootedSerial = await waitForBoot(toolchain.adbPath, avd, 240_000);
  if (options.stock) return;
  await slimAndVerify(avdslim, toolchain.adbPath, bootedSerial);
}

async function screenSize(
  adbPath: string,
  serial: string,
): Promise<{ width: number; height: number; density: number | null }> {
  const [size, density] = await Promise.all([
    adb(adbPath, ["-s", serial, "shell", "wm", "size"], 5_000),
    adb(adbPath, ["-s", serial, "shell", "wm", "density"], 5_000),
  ]);
  const sizes = [...size.stdout.matchAll(/(\d+)x(\d+)/g)];
  const chosen = sizes.at(-1); // "Override size" follows "Physical size" when set.
  if (!chosen) throw new Error(`Could not read the screen size of ${serial}`);
  const densities = [...density.stdout.matchAll(/:\s*(\d+)/g)];
  return {
    width: Number(chosen[1]),
    height: Number(chosen[2]),
    density: densities.length ? Number(densities.at(-1)![1]) : null,
  };
}

export async function emulatorDefinition(avd: string) {
  const { adbPath, serial } = await requireSerial(avd);
  const screen = await screenSize(adbPath, serial);
  return {
    platform: "android",
    avd,
    serial,
    screen: { rect: { width: screen.width, height: screen.height }, density: screen.density },
    coordinateSpace: "device-pixels",
  };
}

export async function emulatorScreenshot(avd: string): Promise<Uint8Array> {
  const { adbPath, serial } = await requireSerial(avd);
  const child = Bun.spawn([adbPath, "-s", serial, "exec-out", "screencap", "-p"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [image, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 || image.byteLength < 8) {
    throw new Error(stderr.trim() || `Screenshot of ${avd} failed`);
  }
  return new Uint8Array(image);
}

export type AndroidUiNode = {
  index: number;
  depth: number;
  className: string;
  text: string;
  resourceId: string;
  contentDescription: string;
  packageName: string;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
};

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&");
}

export function parseUiAutomatorXml(xml: string): AndroidUiNode[] {
  const nodes: AndroidUiNode[] = [];
  let depth = 0;
  for (const match of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
    if (match[1] === "/") {
      depth -= 1;
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attributes[attribute[1]] = decodeXml(attribute[2]);
    }
    const bounds = attributes.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const [left, top, right, bottom] = bounds ? bounds.slice(1).map(Number) : [0, 0, 0, 0];
    nodes.push({
      index: nodes.length,
      depth,
      className: attributes.class || "",
      text: attributes.text || "",
      resourceId: attributes["resource-id"] || "",
      contentDescription: attributes["content-desc"] || "",
      packageName: attributes.package || "",
      clickable: attributes.clickable === "true",
      enabled: attributes.enabled !== "false",
      focused: attributes.focused === "true",
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
    });
    if (match[3] !== "/") depth += 1;
  }
  return nodes;
}

export async function describeEmulatorUi(avd: string, point?: { x: number; y: number }) {
  const { adbPath, serial } = await requireSerial(avd);
  const result = await adb(
    adbPath,
    ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"],
    20_000,
  );
  const xml = result.stdout.slice(
    0,
    result.stdout.lastIndexOf("</hierarchy>") + "</hierarchy>".length,
  );
  if (!xml.includes("<hierarchy")) {
    throw commandError(result, `Could not dump the UI hierarchy of ${avd}`);
  }
  const nodes = parseUiAutomatorXml(xml);
  if (!point) return { platform: "android", coordinateSpace: "device-pixels", nodes };
  const hits = nodes.filter(
    ({ bounds }) =>
      point.x >= bounds.x &&
      point.y >= bounds.y &&
      point.x < bounds.x + bounds.width &&
      point.y < bounds.y + bounds.height,
  );
  return {
    platform: "android",
    coordinateSpace: "device-pixels",
    hit: hits.at(-1) || null,
    stack: hits,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function scalePoint(
  x: number,
  y: number,
  frame: { width?: number; height?: number },
  screen: { width: number; height: number },
): [number, number] {
  // Callers may send points in a scaled frame (for example a dashboard image);
  // without a frame they are device pixels.
  if (!frame.width || !frame.height) return [Math.round(x), Math.round(y)];
  return [
    Math.round((x * screen.width) / frame.width),
    Math.round((y * screen.height) / frame.height),
  ];
}

export async function sendEmulatorInput(avd: string, input: AndroidInput): Promise<void> {
  const { adbPath, serial } = await requireSerial(avd);
  const shell = (command: string) => adb(adbPath, ["-s", serial, "shell", command]);
  let result: Awaited<ReturnType<typeof shell>>;
  switch (input.kind) {
    case "tap":
    case "double-tap":
    case "long-press": {
      const [x, y] = scalePoint(input.x, input.y, input, await screenSize(adbPath, serial));
      const command =
        input.kind === "long-press" ? `input swipe ${x} ${y} ${x} ${y} 800` : `input tap ${x} ${y}`;
      result = await shell(input.kind === "double-tap" ? `${command} && ${command}` : command);
      break;
    }
    case "swipe": {
      const screen = await screenSize(adbPath, serial);
      const [startX, startY] = scalePoint(input.startX, input.startY, input, screen);
      const [endX, endY] = scalePoint(input.endX, input.endY, input, screen);
      const durationMs = Math.round((input.durationSeconds ?? 0.3) * 1000);
      result = await shell(`input swipe ${startX} ${startY} ${endX} ${endY} ${durationMs}`);
      break;
    }
    case "text": {
      if (/[^\x20-\x7e]/.test(input.text)) {
        throw new Error("Android text input supports printable ASCII only");
      }
      // `input text` treats %s as a space; a literal space would split the argument.
      result = await shell(`input text ${shellQuote(input.text.replaceAll(" ", "%s"))}`);
      break;
    }
    case "key": {
      const keycode =
        W3C_KEYCODES[input.code] ??
        (/^(KEYCODE_[A-Z0-9_]+|\d+)$/.test(input.code) ? input.code : null);
      if (keycode === null) throw new Error(`Unsupported Android key code: ${input.code}`);
      result = await shell(`input keyevent ${keycode}`);
      break;
    }
    case "button":
      result = await shell(`input keyevent ${ANDROID_BUTTON_KEYCODES[input.button]}`);
      break;
    case "dev-menu":
      // React Native opens its developer menu on the menu key, as a shake does on iOS.
      result = await shell("input keyevent 82");
      break;
    case "orientation":
      result = await shell(
        `settings put system accelerometer_rotation 0 && settings put system user_rotation ${ROTATIONS[input.orientation]}`,
      );
      break;
    case "open-url":
      result = await shell(`am start -W -a android.intent.action.VIEW -d ${shellQuote(input.url)}`);
      break;
  }
  if (result.exitCode !== 0 || /Error:|Exception/.test(result.stdout)) {
    throw commandError(result, `Android ${input.kind} failed`);
  }
}

export async function removeLaneReverse(session: FleetSession): Promise<void> {
  if (session.port === null) return;
  const toolchain = await getAndroidToolchain();
  if (!toolchain.adbPath) return;
  const serial = await serialForAvd(session.simulatorUdid).catch(() => null);
  if (!serial) return;
  const devicePort = PROJECT_CONFIG.metro?.driver === "react-native" ? 8081 : session.port;
  await adb(toolchain.adbPath, ["-s", serial, "reverse", "--remove", `tcp:${devicePort}`], 5_000);
}

/**
 * Chooses the deep-link scheme the installed client actually registers: the
 * configured scheme, then Expo's `exp+<slug>` dev-launcher scheme, then legacy
 * schemes. Older installed clients often predate a scheme rename.
 */
async function devClientScheme(
  adbPath: string,
  serial: string,
  packageName: string,
  session: FleetSession
): Promise<string> {
  const variant = getVariant(session.environment, session.mode) as ReturnType<typeof getVariant> & {
    legacySchemes?: string[];
  };
  const dump = await adb(adbPath, ["-s", serial, "shell", "dumpsys", "package", packageName]);
  const registered = new Set(
    [...dump.stdout.matchAll(/Scheme:\s*"([^"]+)"/g)].map((match) => match[1])
  );
  const preferred = [variant.scheme, ...(variant.legacySchemes || [])];
  // Only the dev launcher's own `exp+<slug>` scheme reliably opens a bundle URL;
  // a legacy app scheme may route into the embedded bundle instead.
  const scheme =
    (registered.has(variant.scheme) ? variant.scheme : undefined) ||
    [...registered].find((candidate) => candidate.startsWith("exp+")) ||
    preferred.find((candidate) => registered.has(candidate));
  if (!scheme) {
    throw new DeviceStateError(
      `${packageName} on ${session.simulatorUdid} registers none of the dev-client schemes (${preferred.join(", ")}, exp+*). Install a current development client.`
    );
  }
  return scheme;
}

/**
 * Debug lanes reach Metro through `adb reverse`, so the device's own loopback
 * port maps to the lane's leased host port and no LAN address is involved.
 */
export async function configureAndLaunchAndroid(
  session: FleetSession,
): Promise<{ serial: string; package: string; scheme: string }> {
  if (session.port === null) throw new Error("A debug lane requires a Metro port");
  const { adbPath, serial } = await requireSerial(session.simulatorUdid);
  const packageName = androidPackageFor(session.mode);
  const installed = await adb(adbPath, ["-s", serial, "shell", "pm", "path", packageName]);
  if (!installed.stdout.includes("package:")) {
    throw new DeviceStateError(
      `${packageName} is not installed on ${session.simulatorUdid}. Install the Android debug app first.`,
    );
  }
  const reactNative = PROJECT_CONFIG.metro?.driver === "react-native";
  const devicePort = reactNative ? 8081 : session.port;
  const reverse = await adb(adbPath, [
    "-s",
    serial,
    "reverse",
    `tcp:${devicePort}`,
    `tcp:${session.port}`,
  ]);
  if (reverse.exitCode !== 0) throw commandError(reverse, "adb reverse failed");
  await adb(adbPath, ["-s", serial, "shell", "am", "force-stop", packageName]);
  if (reactNative) {
    const launch = PROJECT_CONFIG.android?.activity
      ? await adb(adbPath, ["-s", serial, "shell", "am", "start", "-W", "-n", PROJECT_CONFIG.android.activity])
      : await adb(adbPath, ["-s", serial, "shell", "monkey", "-p", packageName,
        "-c", "android.intent.category.LAUNCHER", "1"]);
    if (launch.exitCode !== 0 || /Error:|Exception/.test(launch.stdout)) {
      throw Object.assign(commandError(launch, "Android launch failed"), { status: 409 });
    }
    return { serial, package: packageName, scheme: "launcher" };
  }
  const scheme = await devClientScheme(adbPath, serial, packageName, session);
  const bundleUrl = encodeURIComponent(`http://127.0.0.1:${session.port}`);
  const launch = await adb(adbPath, [
    "-s",
    serial,
    "shell",
    `am start -W -a android.intent.action.VIEW -d ${shellQuote(`${scheme}://expo-development-client/?url=${bundleUrl}`)} ${packageName}`,
  ]);
  if (launch.exitCode !== 0 || /Error:/.test(launch.stdout)) {
    throw Object.assign(commandError(launch, "Android launch failed"), { status: 409 });
  }
  return { serial, package: packageName, scheme };
}
