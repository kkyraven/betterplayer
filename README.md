# BetterPlayer engine

The GPL-3.0-or-later native engine used by BetterPlayer. It exposes media playback, script handling, device output, tracking, detection, beat analysis, and generation through a Node N-API addon.

## Build

The engine needs Rust, Node.js 22, pnpm, and libmpv development files.

On macOS:

```sh
brew install mpv pkgconf
pnpm install --frozen-lockfile
pnpm run build
```

On Ubuntu or Debian:

```sh
sudo apt install libmpv-dev libudev-dev libdbus-1-dev pkg-config
pnpm install --frozen-lockfile
pnpm run build
```

The generated addon and TypeScript declarations are written to the repository root. Windows builds need an mpv development package; the release workflow prepares one from the shinchiro mpv builds.

## Releases

Tags beginning with `v` build macOS, Windows, and Linux N-API addon archives and attach them to the matching GitHub Release. The archives contain the addon, loader, and declarations. libmpv is a runtime dependency: install or package it for the platform where the addon runs.

## Licence

GPL-3.0-or-later. Detector model weights are not included; see the detector source for their separate licence requirements.
