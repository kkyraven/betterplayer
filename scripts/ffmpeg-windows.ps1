param([Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'
$version = '9.0.1'
$sha256 = 'fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9'
$archive = Join-Path ([IO.Path]::GetTempPath()) "bp-ffmpeg-$([guid]::NewGuid()).zip"
try {
  Invoke-WebRequest "https://github.com/GyanD/codexffmpeg/releases/download/$version/ffmpeg-$version-essentials_build.zip" -OutFile $archive
  if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) { throw 'FFmpeg archive checksum mismatch' }
  Expand-Archive $archive -DestinationPath $Dir -Force
} finally {
  Remove-Item $archive -ErrorAction SilentlyContinue
}
$package = (Resolve-Path (Join-Path $Dir "ffmpeg-$version-essentials_build")).Path
foreach ($tool in 'ffmpeg', 'ffprobe') {
  & (Join-Path $package "bin/$tool.exe") -version
  if ($LASTEXITCODE -ne 0) { throw "$tool failed to start" }
}
Write-Host "BP_FFMPEG_DIR=$package"
if ($env:GITHUB_ENV) { "BP_FFMPEG_DIR=$package" | Add-Content -Path $env:GITHUB_ENV }
