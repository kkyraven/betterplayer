[CmdletBinding()]
param(
  [switch]$EngineDebug,
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$ElectronArgs = @()
)
& (Join-Path $PSScriptRoot 'run-windows.ps1') -Watch -EngineDebug:$EngineDebug @ElectronArgs
exit $LASTEXITCODE
