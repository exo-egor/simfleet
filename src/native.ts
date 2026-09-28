import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  FLEET_CONFIG,
  NATIVE_SHELLS,
  PROJECT_CONFIG,
  projectBundleEnv,
  type AppEnvironment,
  type BuildMode,
} from "./config";
import { run } from "./system";

const require = createRequire(import.meta.url);
const provider = require("./local-build-cache.cjs") as {
  calculateFingerprintHash: (context: NativeContext) => Promise<string>;
  resolveBuildCache: (context: NativeContext) => Promise<string | null>;
  uploadBuildCache: (context: NativeContext & { buildPath: string }) => Promise<void>;
  releaseBuildCache: (context: NativeContext) => void;
  _testing: {
    DEFAULT_CACHE_DIRECTORY: string;
    cachedApp: (entry: string) => string | null;
    entryDirectory: (context: NativeContext, options?: { cacheDirectory?: string }) => string;
  };
};

type NativeContext = {
  platform: "ios";
  projectRoot: string;
  fingerprintHash: string;
  runOptions: { configuration: "Debug" | "Release" };
};

export type NativeBuildPlan = {
  worktreePath: string;
  mode: BuildMode;
  configuration: "Debug" | "Release";
  bundleId: string;
  nativeAuthProvider: string | null;
  nativeAuthIdentifierDeclared: boolean;
  googleServicesFile: string | null;
  fingerprint: string;
  cacheHit: boolean;
  artifactPath: string | null;
  installed: boolean | null;
  installedArtifactMatches: boolean | null;
  decision: "reuse" | "build";
};

const buildOperations = new Map<string, Promise<string>>();

function configurationFor(mode: BuildMode): "Debug" | "Release" {
  return mode === "debug" ? "Debug" : "Release";
}

async function installedOn(
  simulatorUdid: string | undefined,
  bundleId: string,
): Promise<boolean | null> {
  if (!simulatorUdid) return null;
  const result = await run("xcrun", [
    "simctl",
    "get_app_container",
    simulatorUdid,
    bundleId,
    "app",
  ]);
  return result.exitCode === 0;
}

async function installedArtifactMatches(
  simulatorUdid: string | undefined,
  bundleId: string,
  artifactPath: string | null,
): Promise<boolean | null> {
  if (!simulatorUdid || !artifactPath) return null;
  const container = await run("xcrun", [
    "simctl",
    "get_app_container",
    simulatorUdid,
    bundleId,
    "app",
  ]);
  if (container.exitCode !== 0) return false;
  const executable = await run("plutil", [
    "-extract",
    "CFBundleExecutable",
    "raw",
    "-o",
    "-",
    path.join(artifactPath, "Info.plist"),
  ]);
  const executableName = executable.stdout.trim();
  if (executable.exitCode !== 0 || !executableName) return false;
  const cachedExecutable = path.join(artifactPath, executableName);
  const installedExecutable = path.join(container.stdout.trim(), executableName);
  if (!fs.existsSync(cachedExecutable) || !fs.existsSync(installedExecutable)) return false;
  return (await run("cmp", ["-s", cachedExecutable, installedExecutable])).exitCode === 0;
}

export async function nativeBuildPlan(
  worktreePath: string,
  mode: BuildMode,
  simulatorUdid?: string,
): Promise<NativeBuildPlan> {
  if (PROJECT_CONFIG.metro?.driver === "react-native") {
    throw new Error("The native build cache supports Expo projects only; React Native CLI debug lanes can use nativeShells.debug.artifactPath");
  }
  const configuration = configurationFor(mode);
  const context: NativeContext = {
    platform: "ios",
    projectRoot: worktreePath,
    fingerprintHash: "pending",
    runOptions: { configuration },
  };
  const fingerprint = await provider.calculateFingerprintHash(context);
  context.fingerprintHash = fingerprint;
  const entry = provider._testing.entryDirectory(context);
  const artifactPath = provider._testing.cachedApp(entry);
  const bundleId = NATIVE_SHELLS[mode].bundleId;
  const installed = await installedOn(simulatorUdid, bundleId);
  return {
    worktreePath,
    mode,
    configuration,
    bundleId,
    nativeAuthProvider: PROJECT_CONFIG.nativeAuth?.provider ?? null,
    nativeAuthIdentifierDeclared:
      PROJECT_CONFIG.nativeAuth?.allowedAppIdentifiers.includes(bundleId) ?? true,
    googleServicesFile: NATIVE_SHELLS[mode].googleServicesFile ?? null,
    fingerprint,
    cacheHit: artifactPath !== null,
    artifactPath,
    installed,
    installedArtifactMatches:
      installed && artifactPath
        ? await installedArtifactMatches(simulatorUdid, bundleId, artifactPath)
        : installed === false
          ? false
          : null,
    decision: artifactPath ? "reuse" : "build",
  };
}

async function installArtifact(simulatorUdid: string, artifactPath: string): Promise<void> {
  const result = await run("xcrun", ["simctl", "install", simulatorUdid, artifactPath]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not install cached app");
  }
}

async function runLoggedStep(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: number,
): Promise<number> {
  fs.writeSync(log, `\n${new Date().toISOString()} ${executable} ${args.join(" ")}\n`);
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ["ignore", log, log],
  });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function buildNativeShell(
  worktreePath: string,
  simulatorUdid: string,
  mode: BuildMode,
  fingerprint: string,
): Promise<string> {
  const expo = path.join(worktreePath, "node_modules", ".bin", "expo");
  if (!fs.existsSync(expo)) throw new Error(`Expo CLI is missing in ${worktreePath}/node_modules`);
  const configuration = configurationFor(mode);
  const context: NativeContext = {
    platform: "ios",
    projectRoot: worktreePath,
    fingerprintHash: fingerprint,
    runOptions: { configuration },
  };
  const cacheResult = await provider.resolveBuildCache(context);
  if (cacheResult) return cacheResult;
  const environment = {
    ...process.env,
    NODE_ENV: mode === "debug" ? "development" : "production",
    ...projectBundleEnv({ environment: "development", mode, port: "embedded" }),
    EXPO_NO_DOTENV: "1",
    EXPO_NO_INTERACTIVE: "1",
  };
  const logsDirectory = path.join(FLEET_CONFIG.stateDirectory, "logs", "native");
  fs.mkdirSync(logsDirectory, { recursive: true });
  const logPath = path.join(logsDirectory, `${mode}-${Date.now().toString(36)}.log`);
  const log = fs.openSync(logPath, "a");
  try {
    // A native cache miss must regenerate the managed iOS project and run the
    // config-plugin/post-install pipeline. Cache hits skip all three steps.
    const prebuildExitCode = await runLoggedStep(
      expo,
      ["prebuild", "--platform", "ios", "--no-install"],
      worktreePath,
      environment,
      log,
    );
    if (prebuildExitCode !== 0) {
      throw new Error(`iOS prebuild failed with exit ${prebuildExitCode}; see ${logPath}`);
    }
    const podsExitCode = await runLoggedStep(
      "pod",
      ["install"],
      path.join(worktreePath, "ios"),
      environment,
      log,
    );
    if (podsExitCode !== 0) {
      throw new Error(`CocoaPods install failed with exit ${podsExitCode}; see ${logPath}`);
    }
    const iosDirectory = path.join(worktreePath, "ios");
    const projectName = fs
      .readdirSync(iosDirectory)
      .find((entry) => entry.endsWith(".xcodeproj") && !entry.startsWith("Pods"))
      ?.replace(/\.xcodeproj$/, "");
    if (!projectName)
      throw new Error(`Could not find the generated iOS app project in ${iosDirectory}`);
    const workspace = path.join(iosDirectory, `${projectName}.xcworkspace`);
    const schemeDirectory = path.join(
      iosDirectory,
      `${projectName}.xcodeproj`,
      "xcshareddata",
      "xcschemes",
    );
    const scheme = fs
      .readdirSync(schemeDirectory)
      .find((entry) => entry.endsWith(".xcscheme"))
      ?.replace(/\.xcscheme$/, "");
    if (!scheme || !fs.existsSync(workspace)) {
      throw new Error(
        `Could not resolve the generated iOS workspace and scheme in ${iosDirectory}`,
      );
    }
    const xcodeArgs = [
      "-workspace",
      workspace,
      "-scheme",
      scheme,
      "-configuration",
      configuration,
      "-destination",
      `id=${simulatorUdid}`,
      "ONLY_ACTIVE_ARCH=YES",
      `ARCHS=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
    ];
    const buildExitCode = await runLoggedStep(
      "xcodebuild",
      [...xcodeArgs, "build"],
      worktreePath,
      environment,
      log,
    );
    if (buildExitCode !== 0) {
      throw new Error(
        `${configuration} native build failed with exit ${buildExitCode}; see ${logPath}`,
      );
    }
    const settingsResult = await run("xcodebuild", [...xcodeArgs, "-showBuildSettings", "-json"], {
      cwd: worktreePath,
      env: environment,
      timeoutMs: 30_000,
    });
    if (settingsResult.exitCode !== 0) {
      throw new Error(`Could not resolve the built app path; see ${logPath}`);
    }
    const settings = JSON.parse(settingsResult.stdout) as Array<{
      buildSettings?: Record<string, string>;
    }>;
    const appSettings = settings.find(({ buildSettings }) =>
      (buildSettings?.FULL_PRODUCT_NAME || "").endsWith(".app"),
    )?.buildSettings;
    const buildPath = appSettings
      ? path.join(appSettings.TARGET_BUILD_DIR, appSettings.FULL_PRODUCT_NAME)
      : null;
    if (!buildPath || !fs.existsSync(buildPath)) {
      throw new Error(`xcodebuild succeeded but its .app product was not found; see ${logPath}`);
    }
    await provider.uploadBuildCache({ ...context, buildPath });
  } catch (error) {
    provider.releaseBuildCache(context);
    throw error;
  } finally {
    fs.closeSync(log);
  }
  const plan = await nativeBuildPlan(worktreePath, mode, simulatorUdid);
  if (!plan.artifactPath) {
    throw new Error(
      "Native build completed but the build cache provider did not publish an artifact",
    );
  }
  return plan.artifactPath;
}

export async function ensureNativeShell(
  worktreePath: string,
  simulatorUdid: string,
  mode: BuildMode,
): Promise<NativeBuildPlan & { cacheOutcome: "hit" | "built" | "waited" }> {
  const initial = await nativeBuildPlan(worktreePath, mode, simulatorUdid);
  let artifactPath = initial.artifactPath;
  let cacheOutcome: "hit" | "built" | "waited" = artifactPath ? "hit" : "built";
  if (!artifactPath) {
    const key = `${mode}:${initial.fingerprint}`;
    const active = buildOperations.get(key);
    if (active) {
      cacheOutcome = "waited";
      artifactPath = await active;
    } else {
      const operation = buildNativeShell(worktreePath, simulatorUdid, mode, initial.fingerprint);
      buildOperations.set(key, operation);
      try {
        artifactPath = await operation;
      } finally {
        buildOperations.delete(key);
      }
    }
  }
  if (!(await installedArtifactMatches(simulatorUdid, initial.bundleId, artifactPath))) {
    await installArtifact(simulatorUdid, artifactPath);
  }
  return {
    ...(await nativeBuildPlan(worktreePath, mode, simulatorUdid)),
    cacheOutcome,
  };
}

function releaseEntryFile(worktreePath: string): string {
  const declared = PROJECT_CONFIG.release?.entryFile;
  if (declared) return path.join(worktreePath, declared);
  const candidate = ["index.ts", "index.tsx", "index.js"]
    .map((name) => path.join(worktreePath, name))
    .find((file) => fs.existsSync(file));
  if (!candidate) throw new Error(`No release entry file found in ${worktreePath}`);
  return candidate;
}

export async function createRebundledRelease(
  worktreePath: string,
  simulatorUdid: string,
  environment: AppEnvironment,
): Promise<{ artifactPath: string; fingerprint: string }> {
  const ensured = await ensureNativeShell(worktreePath, simulatorUdid, "release");
  if (!ensured.artifactPath) throw new Error("Release native shell is unavailable");
  const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sim-fleet-release-"));
  const destination = path.join(destinationRoot, path.basename(ensured.artifactPath));
  fs.cpSync(ensured.artifactPath, destination, { recursive: true });
  const expo = path.join(worktreePath, "node_modules", ".bin", "expo");
  const releaseEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    METRO_PORT: "embedded",
    ...projectBundleEnv({ environment, mode: "release", port: "embedded" }),
    EXPO_NO_DOTENV: "1",
    EXPO_NO_INTERACTIVE: "1",
  };
  try {
    // Expo's run:ios --binary rebundle path only accepts development-client
    // binaries. Build the Hermes payload directly into a disposable copy of
    // the cached production shell, then install and launch it with simctl.
    const configResult = await run(expo, ["config", "--type", "public", "--json"], {
      cwd: worktreePath,
      env: releaseEnvironment,
    });
    if (configResult.exitCode !== 0) {
      throw new Error(configResult.stderr.trim() || "Could not generate release app config");
    }
    const publicConfig = JSON.parse(configResult.stdout) as unknown;
    fs.writeFileSync(
      path.join(destination, "EXConstants.bundle", "app.config"),
      `${JSON.stringify(publicConfig)}\n`,
    );
    const updatesPlist = path.join(destination, "Expo.plist");
    if (fs.existsSync(updatesPlist)) {
      const disableUpdates = await run("plutil", [
        "-replace",
        "EXUpdatesEnabled",
        "-bool",
        "NO",
        updatesPlist,
      ]);
      if (disableUpdates.exitCode !== 0) {
        throw new Error(
          disableUpdates.stderr.trim() || "Could not disable OTA in local release shell",
        );
      }
    }

    const bundlePath = path.join(destination, "main.jsbundle");
    const bundleResult = await run(
      expo,
      [
        "export:embed",
        "--entry-file",
        releaseEntryFile(worktreePath),
        "--platform",
        "ios",
        "--dev",
        "false",
        "--minify",
        "false",
        "--bundle-output",
        bundlePath,
        "--assets-dest",
        destination,
        "--max-workers",
        String(FLEET_CONFIG.metroMaxWorkers),
        "--bytecode",
      ],
      { cwd: worktreePath, env: releaseEnvironment },
    );
    if (bundleResult.exitCode !== 0 || !fs.existsSync(bundlePath)) {
      throw new Error(
        bundleResult.stderr.trim() || bundleResult.stdout.trim() || "Release rebundle failed",
      );
    }

    const signResult = await run("codesign", ["--force", "--deep", "--sign", "-", destination]);
    if (signResult.exitCode !== 0) {
      throw new Error(signResult.stderr.trim() || "Could not sign rebundled simulator app");
    }
    await installArtifact(simulatorUdid, destination);
    const launchResult = await run("xcrun", [
      "simctl",
      "launch",
      "--terminate-running-process",
      simulatorUdid,
      NATIVE_SHELLS.release.bundleId,
    ]);
    if (launchResult.exitCode !== 0) {
      throw new Error(
        launchResult.stderr.trim() || launchResult.stdout.trim() || "Release launch failed",
      );
    }
    return { artifactPath: ensured.artifactPath, fingerprint: ensured.fingerprint };
  } finally {
    fs.rmSync(destinationRoot, { recursive: true, force: true });
  }
}
