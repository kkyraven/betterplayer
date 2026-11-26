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

$names = @('libEGL.dll', 'libGLESv2.dll')
foreach ($name in $names) {
  if (-not (Test-Path (Join-Path $bin $name))) { throw "$name is missing from the vcpkg build in $bin" }
}
$imports = @(& dumpbin /nologo /dependents (Join-Path $bin 'libGLESv2.dll') |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -match '^[\w.+-]+\.dll$' -and $names -notcontains $_ -and (Test-Path (Join-Path $bin $_)) })
if ($LASTEXITCODE -ne 0) { throw 'dumpbin could not read libGLESv2.dll; run this from a Developer PowerShell' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
foreach ($name in $names + $imports) {
  Copy-Item (Join-Path $bin $name) (Join-Path $Out $name) -Force
}
Say "ANGLE ($(($names + $imports) -join ', ')) staged in $((Resolve-Path $Out).Path)"
