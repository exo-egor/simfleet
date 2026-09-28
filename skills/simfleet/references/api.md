# Fleet API v1

The `simfleet serve` server listens on `http://127.0.0.1:8790` by default. Responses are JSON unless stated otherwise.
Mutations return a non-2xx response with `{ "error": "..." }` when rejected.

## Discovery and state

- `GET /api/v1/capabilities` lists supported operations and resource templates.
- `GET /api/v1/status` returns host memory, existing worktrees, simulators with SimSlim state, Metro
  listeners, managed lanes, and top memory consumers.
- `GET /api/v1/ports` returns each environment/mode range, active leases, and the next available port.
- `GET /api/v1/lanes` returns managed lane state and Metro health.
- `GET /api/v1/lanes/{laneId}/log?maxCharacters=20000` returns the tail as plain text.
- `GET /api/v1/simulator-creation-options` returns installed device-type and runtime identifiers.
- `GET /api/v1/native-builds/plan?worktreePath=...&mode=debug&simulatorUdid=...` reports the native
  fingerprint, cache hit/miss, artifact, installation state, Google services file, and whether its
  installed app identifier is declared in the project's `nativeAuth` allowlist, without building.
- `POST /api/v1/native-builds/ensure` with `worktreePath`, `simulatorUdid`, and `mode` starts an
  asynchronous, single-flight build/install job. Poll the returned job URL through
  `GET /api/v1/native-builds/jobs/{jobId}`.

## Worktree creation

`POST /api/v1/worktrees` with `{ "name": "agent-e2e-a", "branch": "fleet-agent/e2e-a" }` creates a
fresh Git worktree from `HEAD` and prepares it for the current fleet. Optional `startPoint` selects an
existing commit or ref. The name becomes the suffix of a sibling directory and is restricted to
lowercase letters, digits, and hyphens.

Preparation copies the current fleet-sensitive config overlay and links the central dependency tree,
shared paths, environment files, project contract, and the skills listed in `worktrees.skills`. It does not copy native
projects or build products. This is the supported path when an authorized agent must create a worktree
while the fleet implementation itself is still uncommitted.

## Lane lifecycle

Create a lane:

```http
POST /api/v1/lanes
Content-Type: application/json

{
  "worktreePath": "/absolute/existing/checkout",
  "simulatorUdid": "...",
  "environment": "development",
  "mode": "debug"
}
```

`environment` is one of `development`, `staging`, `preprod`, or `production`; `mode` is `debug` or
`release`. `preferredPort` is optional for debug only and is accepted within that environment's range
when free. Release lanes embed JS and return `port: null`, `metroPid: null`.
React Native CLI projects can set `metro.driver: "react-native"`, `metro.cwd`, and `metro.command`
in `.sim-fleet/project.json`; `{port}` in the command becomes the leased port. Their release lanes
and the native build cache are not currently supported.

- `POST /api/v1/lanes/{laneId}/launch` waits up to 15 seconds for a debug Metro and connects to its
  exact leased URL. Release launch immediately returns a background job and `pollUrl`; poll until the
  job is complete while it copies/rebundles a cached release shell with that lane's environment.
- `POST /api/v1/lanes/{laneId}/open-url` with `{ "url": "buy" }` chooses the lane build mode's scheme;
  a fully-qualified URL is passed through unchanged.
- `POST /api/v1/lanes/{laneId}/stop` releases the lane and stops only a Metro process group owned by it.

## Simulator lifecycle and inspection

Create a simulator with `POST /api/v1/simulators` and
`{ "name": "Fleet iPhone", "deviceTypeIdentifier": "...", "runtimeIdentifier": "..." }`. Use values
from `simulator-creation-options`; the new device remains shut down until booted through SimSlim.

- `POST /api/v1/simulators/{udid}/boot`
- `POST /api/v1/simulators/{udid}/slim`
- `POST /api/v1/simulators/{udid}/restore`
- `POST /api/v1/simulators/{udid}/shutdown`
- `POST /api/v1/simulators/{udid}/open`

Open uses Simulator.app when present, or Xcode DeviceHub on installations without Simulator.app.

Lifecycle mutations return a background job and `pollUrl`. Poll
`GET /api/v1/simulators/jobs/{jobId}` until the job is complete. Cold SimSlim boots can take several
minutes when multiple new devices contend for CoreSimulator; the job automatically retries once and
only succeeds after `simslim verify` confirms the complete profile.

- `GET /api/v1/simulators/{udid}/ui` returns the accessibility tree.
- `GET /api/v1/simulators/{udid}/ui?x=20&y=40` performs an accessibility hit test.
- `GET /api/v1/simulators/{udid}/screenshot` returns JPEG.
- `GET /api/v1/simulators/{udid}/definition` returns screen/device geometry.

Send input through `POST /api/v1/simulators/{udid}/input`. The body is a discriminated object:

```json
{ "kind": "tap", "x": 200, "y": 436, "width": 400, "height": 872 }
{ "kind": "double-tap", "x": 200, "y": 436, "width": 400, "height": 872 }
{ "kind": "swipe", "startX": 200, "startY": 700, "endX": 200, "endY": 200, "width": 400, "height": 872 }
{ "kind": "text", "text": "hello" }
{ "kind": "key", "code": "Enter", "modifiers": ["command"] }
{ "kind": "button", "button": "home" }
{ "kind": "orientation", "orientation": "landscape-left" }
{ "kind": "open-url", "url": "myapp://path" }
{ "kind": "shake" }
```

## Live screen transport

Connect to `ws://127.0.0.1:8790/api/v1/simulators/{udid}/stream?format=mjpeg&version=v2`.
Binary messages are JPEG frames. Keep one socket per visible simulator, retain the last decoded frame while
reconnecting, and use bounded exponential backoff. The unified dashboard uses this endpoint directly;
there is no embedded secondary UI.

## Android emulators

Emulators are addressed by AVD name. `GET /api/v1/status` includes `emulators[]` (state
`Booted|Booting|Offline|Shutdown`, `serial`, `avdSlim`, `footprintBytes`, `tuned`, `agents`) and
`android` (SDK, adb, emulator, and avdslim availability).

- `POST /api/v1/emulators/{avd}/{boot|slim|restore|shutdown|tune}` returns a job and `pollUrl`
  (`GET /api/v1/emulators/jobs/{jobId}`). `boot` accepts `{ "headless": true, "cold": false }`.
  Boots are serialized so avdslim never races for a console port.
- `GET /api/v1/emulators/{avd}/ui[?x=&y=]` returns UIAutomator nodes with device-pixel bounds.
- `GET /api/v1/emulators/{avd}/screenshot` returns PNG; `GET .../definition` returns the pixel size.
- `ws://127.0.0.1:8790/api/v1/emulators/{avd}/stream` streams live H.264 through scrcpy's device server
  (requires `brew install scrcpy`; `501` without it). The first text message is
  `{"type":"meta","width","height","name"}`; each binary message is one flag byte (bit 0 codec config,
  bit 1 key frame) followed by an Annex B packet. Send JSON to drive the device:
  `{"type":"touch","action":"down|move|up|cancel","x","y","width","height"}` in video pixels,
  `{"type":"scroll",...,"dx","dy"}`, `{"type":"key","code":"Enter"}`, `{"type":"text","text"}`,
  `{"type":"button","button":"back"}`, and `{"type":"reset"}` to request a fresh key frame. One
  scrcpy session is shared by all viewers of an emulator.
- `POST /api/v1/emulators/{avd}/input` takes the iOS input kinds plus `long-press` and `dev-menu`.
  Coordinates are device pixels unless `width`/`height` describe a scaled frame. Buttons: `home`,
  `back`, `app-switcher`, `menu`, `lock`, `power`, `volume-up`, `volume-down`.
- Operations on an emulator that is not running return `409`.
- `POST /api/v1/lanes` accepts an AVD name as `simulatorUdid` (or `"platform": "android"`); Android
  lanes are debug-only. Expo lanes launch through `adb reverse` plus the dev-client deep link;
  React Native CLI lanes map emulator port 8081 to the leased Metro port and open the app activity.

## Agent attribution

- Send `x-simfleet-agent` (`claude` or `codex`) and `x-simfleet-session` on device requests; the
  `simfleet` CLI does this automatically from `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`.
- `GET /api/v1/agents` returns live sessions and, per device, the attached agents with
  `via: "claim" | "touch" | "lane-worktree"`. Touches expire after 30 minutes of inactivity; claims
  last until released or until the Claude session exits.
- `POST /api/v1/devices/{deviceId}/claim` with `{ "agent", "sessionId", "note" }` claims a device;
  `DELETE` on the same path releases it.

## Slim by default

- `POST /api/v1/simulators/{udid}/boot` and `/api/v1/emulators/{avd}/boot` slim and verify. Send
  `{ "stock": true }` only when the user explicitly wants stock services; that records an opt-out.
- `status.autoSlim` lists devices the fleet is slimming (`slimming`), iOS simulators that need a
  reboot to slim (`needs-reboot`), and explicit opt-outs (`opted-out`). `restore` opts out; `slim`
  opts back in.
