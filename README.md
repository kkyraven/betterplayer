# BetterPlayer
A better video player and media manager for interactive toys

Download from KinkyRaven.com/betterplayer or the releases in the right.

- Manage your Library of Videos
- Start a play session
- Connect and play with your devices
- Watch crisp videos

--


# BetterPlayer Engine Source


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
Windows builds need an mpv development package; the release workflow prepares one from the shinchiro mpv builds.

## Licence

GPL-3.0-or-later. Detector model weights are not included; see the detector source for their separate licence requirements.
