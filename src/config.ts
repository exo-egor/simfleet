import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const APP_ENVIRONMENTS = ["development", "staging", "preprod", "production"] as const;
export const BUILD_MODES = ["debug", "release"] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];
export type BuildMode = (typeof BUILD_MODES)[number];

type Variant = {
  appName: string;
  bundleId: string;
  scheme: string;
  googleServicesFile?: string;
  portRange: readonly [number, number];
};

type NativeShell = Omit<Variant, "portRange"> & {
  legacySchemes?: string[];
  /** Optional prebuilt simulator app used when launching a React Native CLI lane. */
  artifactPath?: string;
  /** Android application ID when it differs from the iOS bundle identifier. */
  androidPackage?: string;
};

/**
 * Values may reference `{environment}`, `{mode}`, and `{port}`. Release bundling
 * renders the same templates with `{port}` set to `embedded`.
 */
type EnvTemplate = Record<string, string>;

export type MetroSettings = {
  driver?: "expo" | "react-native";
  /** Directory relative to the Git worktree containing the app. */
  cwd?: string;
  /** Executable and arguments; templates accept {environment}, {mode}, and {port}. */
  command?: string[];
  env?: EnvTemplate;
  modeEnv?: Partial<Record<BuildMode, EnvTemplate>>;
};

export type ProjectConfigFile = {
  schemaVersion: 1;
  projectName: string;
  nativeAuth?: {
    provider: string;
    allowedAppIdentifiers: string[];
  };
  nativeShells: Record<BuildMode, NativeShell>;
  environments: Record<AppEnvironment, { envFile?: string; portRange: [number, number] }>;
  /** Host directory names; defaults derive from projectName. */
  stateDirectoryName?: string;
  cacheDirectoryName?: string;
  simslimProfile?: string;
  /** Slim every booted device automatically unless opted out (default true). */
  autoSlim?: boolean;
  /** Process names the dashboard treats as "the app" when attributing memory. */
  appProcessNames?: string[];
  metro?: MetroSettings;
  release?: {
    entryFile?: string;
  };
  nativeFingerprint?: {
    rootFiles?: string[];
    sourceDirectories?: string[];
    localNativeDirectories?: string[];
    localNativeFiles?: string[];
  };
  worktrees?: {
    baseRef?: string;
    overlayFiles?: string[];
    removedFiles?: string[];
    sharedPaths?: string[];
    /** Skill directories (relative to the main checkout) linked into new worktrees. */
    skills?: string[];
    /** Home-directory entries surfaced as extra checkouts when their name has one of these prefixes. */
    legacyHomePrefixes?: string[];
  };
  android?: {
    /** Launcher activity; defaults to the package's resolved launcher. */
    activity?: string;
    /** Extra avdslim flags applied to boot/slim (e.g. ["--keep=com.google.android.apps.maps"]). */
    avdslimArgs?: string[];
  };
};

export const PROJECT_CONFIG_RELATIVE_PATH = path.join(".sim-fleet", "project.json");

function hasProjectConfig(directory: string): boolean {
  return fs.existsSync(path.join(directory, PROJECT_CONFIG_RELATIVE_PATH));
}

function mainCheckoutFor(directory: string): string | null {
  const result = spawnSync(
    "git",
    ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) return null;
  const commonDirectory = result.stdout.trim();
  return path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : null;
}

/**
 * The fleet always runs against the main checkout: that is where shared
 * dependencies, skills, and the worktree overlay live. Running the CLI from a
 * linked feature worktree therefore resolves to its main checkout.
 */
export function resolveProjectRoot(start: string): string {
  let directory = path.resolve(start);
  for (;;) {
    if (hasProjectConfig(directory)) break;
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        `No ${PROJECT_CONFIG_RELATIVE_PATH} found in ${start} or its parents. ` +
          "Run simfleet from a project that declares one, or set SIM_FLEET_PROJECT_ROOT.",
      );
    }
    directory = parent;
  }
  const main = mainCheckoutFor(directory);
  return main && hasProjectConfig(main) ? main : directory;
}

export function loadProjectConfig(projectRoot: string): ProjectConfigFile {
  const projectConfigPath = path.join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH);
  const config = JSON.parse(fs.readFileSync(projectConfigPath, "utf8")) as ProjectConfigFile;
  if (config.schemaVersion !== 1) {
    throw new Error(`Unsupported simulator fleet project schema in ${projectConfigPath}`);
  }
  for (const [mode, shell] of Object.entries(config.nativeShells)) {
    if (config.nativeAuth && !config.nativeAuth.allowedAppIdentifiers.includes(shell.bundleId)) {
      throw new Error(
        `${mode} native shell ${shell.bundleId} is not declared in nativeAuth.allowedAppIdentifiers`,
      );
    }
    if (shell.bundleId.includes(".wt")) {
      throw new Error(`${mode} native shell must not use a worktree-derived bundle identifier`);
    }
    if (!shell.googleServicesFile) continue;
    const googleServicesPath = path.resolve(projectRoot, shell.googleServicesFile);
    if (!fs.existsSync(googleServicesPath)) {
      throw new Error(
        `${mode} native shell GoogleService-Info file is missing: ${googleServicesPath}`,
      );
    }
    if (
      !fs.readFileSync(googleServicesPath, "utf8").includes(`<string>${shell.bundleId}</string>`)
    ) {
      throw new Error(
        `${mode} native shell ${shell.bundleId} does not match ${shell.googleServicesFile}`,
      );
    }
  }
  return config;
}

export const PROJECT_ROOT = resolveProjectRoot(process.env.SIM_FLEET_PROJECT_ROOT || process.cwd());
const projectConfig = loadProjectConfig(PROJECT_ROOT);
export const PROJECT_CONFIG = projectConfig;

/**
 * Native shells are shared by every runtime environment. Environment-specific
 * API keys and endpoints belong to the JS bundle served by a lane, so changing
 * staging/preprod/production must never force a native build.
 */
export const NATIVE_SHELLS: Record<BuildMode, NativeShell> = {
  debug: projectConfig.nativeShells.debug,
  release: projectConfig.nativeShells.release,
};

export function androidPackageFor(mode: BuildMode): string {
  return NATIVE_SHELLS[mode].androidPackage || NATIVE_SHELLS[mode].bundleId;
}

/**
 * Bundle identifiers are stable native identities, never worktree identities.
 * Worktree isolation comes from assigning one device and Metro port per lane.
 */
export const VARIANTS = Object.fromEntries(
  APP_ENVIRONMENTS.map((environment) => [
    environment,
    Object.fromEntries(
      BUILD_MODES.map((mode) => [
        mode,
        { ...NATIVE_SHELLS[mode], portRange: projectConfig.environments[environment].portRange },
      ]),
    ),
  ]),
) as unknown as Record<AppEnvironment, Record<BuildMode, Variant>>;

function defaultDirectoryName(): string {
  return `${projectConfig.projectName} Sim Fleet`;
}

const simslimProfile = process.env.SIM_FLEET_SIMSLIM_PROFILE || projectConfig.simslimProfile;

export const FLEET_CONFIG = {
  host: "127.0.0.1",
  dashboardPort: Number(process.env.SIM_FLEET_UI_PORT || 8790),
  browserControlPort: Number(process.env.SIM_FLEET_CONTROL_PORT || 8421),
  metroMaxWorkers: Number(process.env.SIM_FLEET_METRO_WORKERS || 1),
  stateDirectory: path.join(
    os.homedir(),
    "Library",
    "Application Support",
    projectConfig.stateDirectoryName || defaultDirectoryName(),
  ),
  simslimProfilePath: simslimProfile ? path.resolve(PROJECT_ROOT, simslimProfile) : null,
  screenshotRefreshMs: 4000,
} as const;

export function renderEnvTemplate(
  template: EnvTemplate | undefined,
  values: { environment: AppEnvironment; mode: BuildMode; port: number | "embedded" },
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(template || {})) {
    rendered[key] = value
      .replaceAll("{environment}", values.environment)
      .replaceAll("{mode}", values.mode)
      .replaceAll("{port}", String(values.port));
  }
  return rendered;
}

export function resolveMetroCommand(
  settings: MetroSettings | undefined,
  worktreePath: string,
  values: { environment: AppEnvironment; mode: BuildMode; port: number },
): { driver: "expo" | "react-native"; cwd: string; command: string; args: string[] } {
  const root = path.resolve(worktreePath);
  const cwd = path.resolve(root, settings?.cwd || ".");
  const relative = path.relative(root, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Metro cwd must stay within the worktree");
  }
  const driver = settings?.driver || "expo";
  const configured = settings?.command;
  if (configured && (!configured.length || configured.some((part) => !part))) {
    throw new Error("Metro command must contain an executable and nonempty arguments");
  }
  if (configured && !configured.some((part) => part.includes("{port}"))) {
    throw new Error("Metro command must include {port} so each lane uses its leased port");
  }
  if (driver === "react-native" && !configured) {
    throw new Error("React Native CLI lanes require metro.command");
  }
  const command = configured || [
    path.join(cwd, "node_modules", ".bin", "expo"),
    "start",
    "--dev-client",
    "--localhost",
    "--port",
    "{port}",
    "--max-workers",
    String(FLEET_CONFIG.metroMaxWorkers),
  ];
  const rendered = command.map((part) =>
    part
      .replaceAll("{environment}", values.environment)
      .replaceAll("{mode}", values.mode)
      .replaceAll("{port}", String(values.port)),
  );
  const executable = rendered[0].includes(path.sep) && !path.isAbsolute(rendered[0])
    ? path.resolve(cwd, rendered[0])
    : rendered[0];
  return { driver, cwd, command: executable, args: rendered.slice(1) };
}

/** Project-declared environment for a Metro server or embedded bundle. */
export function projectBundleEnv(values: {
  environment: AppEnvironment;
  mode: BuildMode;
  port: number | "embedded";
}): Record<string, string> {
  return {
    ...renderEnvTemplate(projectConfig.metro?.env, values),
    ...renderEnvTemplate(projectConfig.metro?.modeEnv?.[values.mode], values),
  };
}

export function getVariant(environment: AppEnvironment, mode: BuildMode): Variant {
  return VARIANTS[environment][mode];
}

export function isAppEnvironment(value: unknown): value is AppEnvironment {
  return typeof value === "string" && APP_ENVIRONMENTS.includes(value as AppEnvironment);
}

export function isBuildMode(value: unknown): value is BuildMode {
  return typeof value === "string" && BUILD_MODES.includes(value as BuildMode);
}
