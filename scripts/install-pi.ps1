param(
  [string]$Version = $(if ($env:HIVEMIND_PI_VERSION) { $env:HIVEMIND_PI_VERSION } else { '0.84.3' }),
  [string]$HivemindRoot = $(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.hivemind')
)

$ErrorActionPreference = 'Stop'

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$asset = switch ($architecture) {
  'X64' { 'pi-windows-x64.zip' }
  'Arm64' { 'pi-windows-arm64.zip' }
  default { throw "Unsupported Windows architecture: $architecture" }
}

$versionRoot = Join-Path (Join-Path (Join-Path $HivemindRoot 'pi') $Version) 'pi'
$binary = Join-Path $versionRoot 'pi.exe'
if ((Test-Path -LiteralPath $binary) -and ((& $binary --version 2>$null) -eq $Version)) {
  Write-Output "pi $Version already installed at $binary"
  exit 0
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI (gh) is required to download and verify the pinned pi release'
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("hivemind-pi-$Version-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null

try {
  gh release download "v$Version" --repo earendil-works/pi --pattern $asset --pattern SHA256SUMS --dir $stage
  if ($LASTEXITCODE -ne 0) { throw "gh release download failed with exit code $LASTEXITCODE" }

  $checksumLine = Get-Content -LiteralPath (Join-Path $stage 'SHA256SUMS') |
    Where-Object { $_ -match " $([regex]::Escape($asset))$" }
  if (-not $checksumLine) { throw "No checksum entry for $asset" }
  $expected = ($checksumLine -split '\s+')[0].ToLowerInvariant()
  $archive = Join-Path $stage $asset
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Checksum mismatch: expected $expected got $actual" }

  $extract = Join-Path $stage 'extract'
  Expand-Archive -LiteralPath $archive -DestinationPath $extract
  $extractedBinary = Join-Path $extract 'pi.exe'
  if (-not (Test-Path -LiteralPath $extractedBinary)) { throw 'Release archive does not contain pi.exe' }

  $versionParent = Split-Path -Parent $versionRoot
  New-Item -ItemType Directory -Path $versionParent -Force | Out-Null
  if (Test-Path -LiteralPath $versionRoot) {
    $backup = "$versionRoot.invalid-$(Get-Date -Format 'yyyyMMddHHmmss')"
    Move-Item -LiteralPath $versionRoot -Destination $backup
    Write-Warning "Moved the invalid existing install to $backup"
  }
  Move-Item -LiteralPath $extract -Destination $versionRoot

  $installed = & $binary --version
  if ($installed -ne $Version) { throw "Version mismatch after install: wanted $Version got $installed" }
  Write-Output "pi $installed installed at $binary"
} finally {
  $resolvedStage = [System.IO.Path]::GetFullPath($stage)
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedStage.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
