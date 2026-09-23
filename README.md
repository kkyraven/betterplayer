# BetterPlayer
A better video player and media manager for interactive toys

Download from [KinkyRaven.com/betterplayer](https://kinkyraven.com/betterplayer) (recommended) or the releases in the right.

- Manage your Library of Videos
- Start a play session
- Connect and play with your devices
- Watch crisp videos

## Forks

If you create a fork of BetterPlayer please be aware the app is under BSL, premium features are all rights reserved, models are copyrighted entirely, and ensure not to use our network/server features in forks you share or distribute please, we will block those custom clients as it costs money/resources to maintain the server features/server.

You are welcome to use server features on custom forks that you make for personal use! :3

See [LICENSE.txt](LICENSE.txt). The engine is GPL-3.0-or-later ([engine/LICENSE](engine/LICENSE)).

## Build

You need Node.js 22+, pnpm 10+ and Rust, plus:

- macOS: Xcode 26 or newer, and `brew install mpv pkgconf`
- Linux: `libmpv-dev`, `libudev-dev`, `libdbus-1-dev`, `libssl-dev`, `pkg-config`, a C toolchain, and a Mesa or NVIDIA OpenGL driver
- Windows: VS 2022 Build Tools with the C++ workload, git, and `BP_MPV_DIR` set to an extracted [shinchiro mpv-dev](https://github.com/shinchiro/mpv-winbuild-cmake/releases) package

From the repo root:

```sh
./run-macos.sh        # or ./run-linux.sh, or .\run-windows.ps1
```

The script installs dependencies, builds the engine when its code changed, and starts the app. `--engine-debug` compiles the engine faster but plays slower. The `-keep-updated` scripts also rebuild and restart when the engine changes.

To build an installer:

```sh
cd engine && pnpm install && pnpm run build && cd ..
node scripts/bundle-engine.mjs
cd app && pnpm build && pnpm dist --mac   # or --win, --linux
```

The AI models are not included, so AI features do not work in your own build.
