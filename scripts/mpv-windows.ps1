param([Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'

$Dir = (Resolve-Path $Dir).Path
$dll = Join-Path $Dir 'libmpv-2.dll'
if (-not (Test-Path $dll)) { throw "libmpv-2.dll not found in $Dir" }
foreach ($tool in 'dumpbin', 'lib') {
  if (-not (Get-Command "$tool.exe" -ErrorAction SilentlyContinue)) { throw "$tool.exe is not on PATH; run this from a Developer PowerShell" }
}

$exports = & dumpbin /nologo /exports $dll | ForEach-Object {
  if ($_ -match '^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]{8}\s+(\w+)') { $Matches[1] }
}
if ($exports.Count -lt 10) { throw "dumpbin found only $($exports.Count) exports in libmpv-2.dll" }
$def = Join-Path $Dir 'mpv.def'
@('LIBRARY libmpv-2.dll', 'EXPORTS') + $exports | Set-Content -Path $def -Encoding ASCII
& lib /nologo "/def:$def" /machine:x64 "/out:$(Join-Path $Dir 'mpv.lib')"
if ($LASTEXITCODE -ne 0) { throw 'lib.exe failed to build mpv.lib' }

$deps = & dumpbin /nologo /dependents $dll | ForEach-Object { if ($_ -match '^\s+(\S+\.dll)\s*$') { $Matches[1] } }
$local = @($deps | Where-Object { Test-Path (Join-Path $Dir $_) })
if ($local.Count -gt 0) { Write-Warning "libmpv-2.dll also needs $($local -join ', ') from $Dir; scripts/bundle-engine.mjs only ships libmpv-2.dll" }

Write-Host "BP_MPV_DIR=$Dir"
if ($env:GITHUB_ENV) {
  "BP_MPV_DIR=$Dir" | Add-Content -Path $env:GITHUB_ENV
}
if ($env:GITHUB_PATH) {
  $Dir | Add-Content -Path $env:GITHUB_PATH
}
