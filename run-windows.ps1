[CmdletBinding()]
param(
  [switch]$Watch,
  [switch]$EngineDebug,
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$ElectronArgs = @()
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$engineDir = Join-Path $root 'engine'

Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Say  ($m) { Write-Host "-> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "!  $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "x  $m" -ForegroundColor Red; exit 1 }
function Have ($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

if (-not (Have node))  { Die "node not found. Install Node 22+: winget install OpenJS.NodeJS" }
if (-not (Have pnpm))  { Die "pnpm not found. Run: corepack enable pnpm" }
if (-not (Have cargo)) { Die "cargo not found. Install Rust (msvc toolchain): https://rustup.rs" }
if (-not (Have git))   { Die "git not found. Install it: winget install Git.Git" }
$pnpmMajor = [int]((pnpm --version) -split '\.')[0]
if ($pnpmMajor -lt 10) { Die "pnpm $(pnpm --version) is too old for the workspace files here. Run: corepack enable pnpm (or npm install -g pnpm)" }

function Enter-MsvcEnv {
  if ((Have lib.exe) -and (Have dumpbin.exe) -and $env:VCINSTALLDIR) { return }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { Die "Visual Studio Build Tools not found. Install them with the C++ workload: winget install Microsoft.VisualStudio.2022.BuildTools --override `"--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive`"" }
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
  if (-not $vs) { Die "no Visual Studio install has the C++ build tools (Microsoft.VisualStudio.Workload.VCTools)" }
  Import-Module (Join-Path $vs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
  Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64 -no_logo' | Out-Null
  if (-not (Have lib.exe)) { Die "the Developer PowerShell came up without lib.exe; is the C++ workload installed?" }
}
Enter-MsvcEnv

if (-not $env:BP_MPV_DIR) { Die "BP_MPV_DIR is not set. Extract a shinchiro mpv-dev-x86_64 package (github.com/shinchiro/mpv-winbuild-cmake/releases) and point BP_MPV_DIR at the folder." }
if (-not (Test-Path $env:BP_MPV_DIR)) { Die "BP_MPV_DIR does not exist: $env:BP_MPV_DIR" }
$mpvDir = (Resolve-Path $env:BP_MPV_DIR).Path
$mpvDll = Join-Path $mpvDir 'libmpv-2.dll'
$mpvLib = Join-Path $mpvDir 'mpv.lib'
if (-not (Test-Path $mpvDll)) { Die "libmpv-2.dll not found in $mpvDir" }
if ((-not (Test-Path $mpvLib)) -or ((Get-Item $mpvDll).LastWriteTimeUtc -gt (Get-Item $mpvLib).LastWriteTimeUtc)) {
  Say "making mpv.lib from $mpvDll"
  & (Join-Path $root 'scripts\mpv-windows.ps1') -Dir $mpvDir | Out-Host
}
$env:BP_MPV_DIR = $mpvDir

$engineDll = Join-Path $engineDir 'libmpv-2.dll'
if ((-not (Test-Path $engineDll)) -or ((Get-Item $mpvDll).LastWriteTimeUtc -gt (Get-Item $engineDll).LastWriteTimeUtc)) {
  Say "copying libmpv-2.dll next to the addon"
  Copy-Item $mpvDll $engineDll -Force
}
if (-not (Test-Path (Join-Path $engineDir 'libEGL.dll')) -or -not (Test-Path (Join-Path $engineDir 'libGLESv2.dll'))) {
  Say "ANGLE is not next to the addon yet; building it with vcpkg (a few minutes the first time)"
  & (Join-Path $root 'scripts\angle-windows.ps1') -Out $engineDir | Out-Host
}

function Install-Deps ($dir, $name) {
  $modules = Join-Path $dir 'node_modules'
  $lock = Join-Path $dir 'pnpm-lock.yaml'
  if ((-not (Test-Path $modules)) -or ((Get-Item $lock).LastWriteTimeUtc -gt (Get-Item $modules).LastWriteTimeUtc)) {
    Say "pnpm install ($name)"
    Push-Location $dir
    try { pnpm install; if ($LASTEXITCODE -ne 0) { Die "pnpm install failed in $name" } } finally { Pop-Location }
    (Get-Item $modules).LastWriteTimeUtc = [DateTime]::UtcNow
  }
}

Install-Deps $engineDir 'engine'
Install-Deps (Join-Path $root 'app') 'app'

function Get-Addon { Get-ChildItem $engineDir -Filter 'bp-engine.*.node' -ErrorAction SilentlyContinue | Select-Object -First 1 }

function Get-EngineStamp {
  $items = @(Get-ChildItem (Join-Path $engineDir 'crates') -Recurse -File -ErrorAction SilentlyContinue)
  $items += Get-Item (Join-Path $engineDir 'Cargo.toml')
  $items += Get-Item (Join-Path $engineDir 'Cargo.lock')
  ($items | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
}

function Build-Engine {
  $npmScript = if ($EngineDebug) { 'build:debug' } else { 'build' }
  $profileName = if ($EngineDebug) { 'debug' } else { 'release' }
  Say "building the engine addon ($profileName)"
  Push-Location $engineDir
  try { pnpm run $npmScript | Out-Host; return ($LASTEXITCODE -eq 0) } finally { Pop-Location }
}

$addon = Get-Addon
if ((-not $addon) -or ((Get-EngineStamp) -gt $addon.LastWriteTimeUtc)) {
  if (-not (Build-Engine)) { Die "the engine build failed" }
  $addon = Get-Addon
} else {
  Say "engine addon up to date ($($addon.Name))"
}

if (-not $addon) { Die "the engine build produced no .node addon in engine\" }

$vite = Join-Path $root 'app\node_modules\.bin\electron-vite.cmd'
if (-not (Test-Path $vite)) { Die "electron-vite missing. Delete app\node_modules and re-run." }
if (-not (Test-Path (Join-Path $root 'app\node_modules\electron\dist\electron.exe'))) {
  Say "fetching the Electron binary"
  Push-Location (Join-Path $root 'app')
  try { node node_modules/electron/install.js; if ($LASTEXITCODE -ne 0) { Die "the Electron download failed" } } finally { Pop-Location }
}

$viteArgs = @('dev', '--watch')
$forward = @($ElectronArgs | Where-Object { $_ -ne '--' })
if ($forward.Count -gt 0) { $viteArgs += '--'; $viteArgs += $forward }

Push-Location (Join-Path $root 'app')

if (-not $Watch) {
  Say "starting the app (Rust changes need a re-run; use run-windows-keep-updated.ps1 to watch them)"
  & $vite @viteArgs
  Pop-Location
  exit $LASTEXITCODE
}

$script:app = $null

function Start-App {
  $quoted = $viteArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
  $script:app = Start-Process -FilePath $vite -ArgumentList $quoted -NoNewWindow -PassThru
}

function Stop-App {
  if ($script:app -and -not $script:app.HasExited) {
    & taskkill /PID $script:app.Id /T /F 2>&1 | Out-Null
  }
  $script:app = $null
}

try {
  $stamp = Get-EngineStamp
  Say "watching engine\crates; the app restarts after each successful rebuild"
  Start-App

  while ($true) {
    Start-Sleep -Seconds 1
    if ($script:app -and $script:app.HasExited) { Say "the app exited"; break }

    $now = Get-EngineStamp
    if ($now -le $stamp) { continue }
    $stamp = $now
    if (Build-Engine) {
      Say "restarting the app"
      Stop-App
      Start-App
    } else {
      Warn "engine build failed; the app keeps running the last good addon"
    }
  }
} finally {
  Stop-App
  Pop-Location
}
