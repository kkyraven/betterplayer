#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

unset ELECTRON_RUN_AS_NODE

WATCH=0
PROFILE=release
ARGS=()

usage() {
  cat <<'USAGE'
Usage: scripts/dev.sh [options] [-- <electron args>]

  --watch          rebuild the Rust engine and restart the app when engine/crates changes
  --engine-debug   build the addon unoptimised (much faster to compile, slower to play)
  -h, --help       this message

Anything else is forwarded to Electron, so the app's dev flags work as documented in README.md:

  scripts/dev.sh video.mp4 --start 40
  scripts/dev.sh -- --data /tmp/bp-data --library ~/videos --remote 8420
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=1 ;;
    --engine-debug) PROFILE=debug ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do ARGS+=("$1"); shift; done; break ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  *) printf 'Unsupported system: %s. Use run-windows.ps1 on Windows.\n' "$(uname -s)" >&2; exit 1 ;;
esac

say() { printf '\033[36m→\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

linux_hint() {
  case "$1" in
    mpv) echo "apt install libmpv-dev  |  dnf install mpv-libs-devel  |  pacman -S mpv" ;;
    udev) echo "apt install libudev-dev  |  dnf install systemd-devel  |  pacman -S systemd-libs" ;;
    ssl) echo "apt install libssl-dev  |  dnf install openssl-devel  |  pacman -S openssl" ;;
    dbus) echo "apt install libdbus-1-dev  |  dnf install dbus-devel  |  pacman -S dbus" ;;
    pkgconfig) echo "apt install pkg-config  |  dnf install pkgconf-pkg-config  |  pacman -S pkgconf" ;;
    cc) echo "apt install build-essential  |  dnf groupinstall 'Development Tools'  |  pacman -S base-devel" ;;
    patchelf) echo "apt install patchelf  |  dnf install patchelf  |  pacman -S patchelf" ;;
    ffmpeg) echo "apt install ffmpeg  |  dnf install ffmpeg  |  pacman -S ffmpeg" ;;
  esac
}

have node || die "node not found. Install Node 22+ (https://nodejs.org or nvm)."
have pnpm || die "pnpm not found. Run: corepack enable pnpm"
have cargo || die "cargo not found. Install Rust: https://rustup.rs"

if [ "$OS" = macos ]; then
  have pkg-config || die "pkg-config not found. Run: brew install pkg-config"
  pkg-config --exists mpv || die "libmpv not found. Run: brew install mpv"
  xcode-select -p >/dev/null 2>&1 || die "Command Line Tools not found. Run: xcode-select --install"
else
  have cc || die "no C compiler. $(linux_hint cc)"
  have pkg-config || die "pkg-config not found. $(linux_hint pkgconfig)"
  pkg-config --exists mpv || die "libmpv not found. $(linux_hint mpv)"
  pkg-config --exists libudev || die "libudev not found. $(linux_hint udev)"
  pkg-config --exists dbus-1 || die "D-Bus not found. $(linux_hint dbus)"
  pkg-config --exists openssl || die "OpenSSL headers not found. $(linux_hint ssl)"
  have patchelf || die "patchelf not found. $(linux_hint patchelf)"
  have ffmpeg || die "ffmpeg not found. $(linux_hint ffmpeg)"
fi

install_deps() {
  local dir="$1" name="$2"
  if [ ! -d "$dir/node_modules" ] || [ "$dir/pnpm-lock.yaml" -nt "$dir/node_modules" ]; then
    say "pnpm install ($name)"
    (cd "$dir" && pnpm install)
    touch "$dir/node_modules"
  fi
}

install_deps "$ROOT/engine" engine
install_deps "$ROOT/app" app

addon() { ls "$ROOT"/engine/bp-engine.*.node 2>/dev/null | head -1; }

engine_stale() {
  local built
  built="$(addon)"
  [ -n "$built" ] || return 0
  [ -n "$(find "$ROOT/engine/crates" "$ROOT/engine/Cargo.toml" "$ROOT/engine/Cargo.lock" -newer "$built" -print -quit 2>/dev/null)" ]
}

staged_stale() {
  [ "$OS" = linux ] || return 1
  local copy
  copy="$(ls "$ROOT"/app/resources/engine/bp-engine.*.node 2>/dev/null | head -1)"
  [ -z "$copy" ] || [ "$(addon)" -nt "$copy" ] ||
    [ "$ROOT/engine/index.js" -nt "$copy" ] ||
    [ "$ROOT/scripts/bundle-engine.mjs" -nt "$copy" ] ||
    [ "$ROOT/scripts/bundle-linux.mjs" -nt "$copy" ]
}

stage_engine() {
  say "staging the engine addon into app/resources/engine"
  (cd "$ROOT" && node scripts/bundle-engine.mjs)
}

build_engine() {
  local script=build
  if [ "$PROFILE" = debug ]; then script=build:debug; fi
  say "building the engine addon ($PROFILE)"
  (cd "$ROOT/engine" && pnpm run "$script") || return 1
  [ "$OS" != linux ] || stage_engine
}

if engine_stale; then
  build_engine
elif staged_stale; then
  stage_engine
else
  say "engine addon up to date ($(basename "$(addon)"))"
fi

[ -n "$(addon)" ] || die "the engine build produced no .node addon in engine/"

VITE="$ROOT/app/node_modules/.bin/electron-vite"
[ -x "$VITE" ] || die "electron-vite missing. Delete app/node_modules and re-run."

cd "$ROOT/app"
set -- dev --watch
if [ ${#ARGS[@]} -gt 0 ]; then set -- "$@" -- "${ARGS[@]}"; fi

if [ "$WATCH" -eq 0 ]; then
  say "starting the app (Rust changes need a re-run; use the keep-updated script to watch them)"
  exec "$VITE" "$@"
fi

set -m
APP_PGID=""

start_app() {
  "$VITE" "$@" &
  APP_PGID=$!
}

stop_app() {
  [ -n "$APP_PGID" ] || return 0
  kill -TERM "-$APP_PGID" 2>/dev/null || true
  wait "$APP_PGID" 2>/dev/null || true
  APP_PGID=""
}

trap 'stop_app; exit 0' INT TERM
trap 'stop_app' EXIT

STAMP="$ROOT/engine/target/.bp-watch-stamp"
mkdir -p "$(dirname "$STAMP")"
touch "$STAMP"

say "watching engine/crates; the app restarts after each successful rebuild"
start_app "$@"

while :; do
  sleep 1
  if [ -z "$(jobs -r -p)" ]; then
    say "the app exited"
    exit 0
  fi
  if [ -z "$(find "$ROOT/engine/crates" "$ROOT/engine/Cargo.toml" "$ROOT/engine/Cargo.lock" -newer "$STAMP" -print -quit 2>/dev/null)" ]; then
    continue
  fi
  touch "$STAMP"
  if build_engine; then
    say "restarting the app"
    stop_app
    start_app "$@"
  else
    warn "engine build failed; the app keeps running the last good addon"
  fi
done
