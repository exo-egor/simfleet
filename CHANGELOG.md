# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- React Native CLI debug lanes with configurable Metro commands and app directories, including
  prebuilt iOS debug app installation and Android port forwarding.
- Simulator Open falls back to Xcode's DeviceHub when Simulator.app is absent.

## [0.1.0] - 2026-09-28

### Added

- Fleet server and CLI (`simfleet serve`, `simfleet …`) with a local HTTP/WebSocket API.
- Browser dashboard (React, shadcn) with a live device wall, focus view, inspector, agents and host
  views, light/dark themes, and full keyboard and screen-reader support.
- iOS simulators slimmed with SimSlim and streamed over MJPEG through Baguette.
- Android emulators booted and slimmed with avdslim (2 GB guest RAM by default), streamed as live H.264
  through scrcpy's device server with direct touch, scroll, key, and text input; screenshot polling
  fallback.
- Auto-slim for devices booted outside the fleet, with explicit stock opt-outs.
- Lanes: one worktree, one device, one leased Metro port per environment range; Android lanes via
  `adb reverse`.
- Native build cache with fingerprinting and single-flight builds, exposed as an Expo
  `buildCacheProvider` (`simfleet/build-cache`).
- Agent attribution for Claude Code and Codex sessions, device claims, and a macOS menu-bar icon.
- `simfleet init`, `simfleet skill install`, and a bundled agent skill.
- Documentation site at https://entropyconquers.github.io/simfleet, deployed from `docs/`.

[Unreleased]: https://github.com/entropyconquers/simfleet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/entropyconquers/simfleet/releases/tag/v0.1.0
