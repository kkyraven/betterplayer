param(
  [Parameter(Mandatory)][string]$Out,
  [string]$Triplet = 'x64-windows'
)
$ErrorActionPreference = 'Stop'

function Say ($m) { Write-Host "-> $m" -ForegroundColor Cyan }

function Usable ($root) {
  $root -and ((Test-Path (Join-Path $root 'vcpkg.exe')) -or (Test-Path (Join-Path $root 'bootstrap-vcpkg.bat')))
}
$vcpkgRoot = @($env:VCPKG_ROOT, $env:VCPKG_INSTALLATION_ROOT) | Where-Object { Usable $_ } | Select-Object -First 1
if (-not $vcpkgRoot) { $vcpkgRoot = Join-Path $env:LOCALAPPDATA 'betterplayer\vcpkg' }
if (-not (Usable $vcpkgRoot)) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is needed to fetch vcpkg' }
  Say "cloning vcpkg into $vcpkgRoot"
  New-Item -ItemType Directory -Force -Path (Split-Path $vcpkgRoot) | Out-Null
  & git clone --depth 1 https://github.com/microsoft/vcpkg.git $vcpkgRoot | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'git clone of vcpkg failed' }
}
$vcpkg = Join-Path $vcpkgRoot 'vcpkg.exe'
if (-not (Test-Path $vcpkg)) {
  Say 'bootstrapping vcpkg'
  & (Join-Path $vcpkgRoot 'bootstrap-vcpkg.bat') -disableMetrics | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'vcpkg bootstrap failed' }
}

$bin = Join-Path $vcpkgRoot "installed\$Triplet\bin"
if (-not (Test-Path (Join-Path $bin 'libEGL.dll'))) {
  Say "building ANGLE with vcpkg ($Triplet)"
  & $vcpkg install "angle:$Triplet" --clean-after-build | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'vcpkg install angle failed' }
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
foreach ($name in 'libEGL.dll', 'libGLESv2.dll', 'z.dll') {
  $src = Join-Path $bin $name
  if (-not (Test-Path $src)) { throw "$src is missing from the vcpkg build" }
  Copy-Item $src (Join-Path $Out $name) -Force
}
Say "ANGLE staged in $((Resolve-Path $Out).Path)"
