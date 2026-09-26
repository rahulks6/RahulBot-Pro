# AI Story Studio - uninstaller (v1.2.0)
#
# Started from Settings > Apps > AI Story Studio > Uninstall, or the Start Menu entry
# "Uninstall AI Story Studio". It removes the app files, the shortcuts and the Apps entry.
#
# YOUR DATA IS KEPT: the data folder (projects, characters, videos, exports, database, encrypted
# keys) and your .env stay where they are, unless you explicitly choose to delete them.
#
# Usage:  powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Yes] [-RemoveData]
#   -Yes         no questions (keeps your data)
#   -RemoveData  ALSO delete the data folder; asks you to type DELETE (never with -Yes alone)

param(
  [switch]$Yes,
  [switch]$RemoveData,
  [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AIStoryStudio'

if (-not $AppDir) { $AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$AppDir = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')

# Run from a temporary copy, so the app folder (which contains this script) can be removed.
if ($PSScriptRoot -and $PSScriptRoot.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase)) {
  $copy = Join-Path $env:TEMP "ai-story-studio-uninstall-$PID.ps1"
  Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force
  $argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $copy, '-AppDir', $AppDir)
  if ($Yes) { $argsList += '-Yes' }
  if ($RemoveData) { $argsList += '-RemoveData' }
  & powershell.exe @argsList
  exit $LASTEXITCODE
}
Set-Location $env:TEMP

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

if (-not (Test-Path (Join-Path $AppDir 'package.json'))) {
  Say "No AI Story Studio installation found in $AppDir." 'Red'
  exit 1
}
$pkg = Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json
if ($pkg.name -ne 'ai-story-studio') {
  Say "$AppDir is not an AI Story Studio folder; nothing was removed." 'Red'
  exit 1
}

# The data folder: DATA_DIR from .env, else <app>\data.
$dataDir = Join-Path $AppDir 'data'
$envFile = Join-Path $AppDir '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*DATA_DIR\s*=\s*(.+?)\s*$' | Select-Object -First 1
  if ($m) {
    $v = $m.Matches[0].Groups[1].Value.Trim('"')
    $dataDir = if ([IO.Path]::IsPathRooted($v)) { $v } else { Join-Path $AppDir $v }
  }
}
# Normalise (".\data" -> "data") so the comparison below cannot miss it.
$dataDir = [IO.Path]::GetFullPath($dataDir).TrimEnd('\')

# Refuse while the app is running (it would hold files open).
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 3
  if ($r.StatusCode -eq 200) {
    Say 'AI Story Studio is running. Close its window first, then uninstall again.' 'Yellow'
    exit 2
  }
} catch {}

Say "Uninstall AI Story Studio $($pkg.version) from $AppDir" 'White'
Say "Your data stays in: $dataDir (projects, characters, videos, exports, database, keys)" 'Green'
if (-not $Yes) {
  $a = Read-Host 'Remove the app? (Y/N)'
  if ($a -notmatch '^[Yy]') { Say 'Nothing was removed.'; exit 0 }
}

$deleteData = $false
if ($RemoveData) {
  Say ''
  Say "You asked to ALSO DELETE ALL YOUR DATA in $dataDir." 'Red'
  Say 'This deletes every project, character, video and export. It cannot be undone.' 'Red'
  $typed = Read-Host 'Type DELETE to delete your data too, or press Enter to keep it'
  $deleteData = ($typed -ceq 'DELETE')
  if (-not $deleteData) { Say 'Your data will be kept.' 'Green' }
}

# 1. Shortcuts and the Apps entry.
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
foreach ($lnk in @(
    (Join-Path $desktop 'AI Story Studio.lnk'),
    (Join-Path $programs 'AI Story Studio\AI Story Studio.lnk'),
    (Join-Path $programs 'AI Story Studio\Uninstall AI Story Studio.lnk')
  )) {
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Say "Removed shortcut $lnk" }
}
$menu = Join-Path $programs 'AI Story Studio'
if ((Test-Path $menu) -and -not (Get-ChildItem $menu)) { Remove-Item $menu -Force }
if (Test-Path $UninstallKey) { Remove-Item $UninstallKey -Recurse -Force; Say 'Removed from Settings > Apps.' }

# 2. App files. The data folder and .env (with its backups) are kept unless deleting data was confirmed.
# Safety net: the default 'data' folder, the configured one, and any folder that holds a database or
# keys are never removed without the typed DELETE confirmation.
$keep = @('.env', 'data')
$dataInside = $dataDir.StartsWith($AppDir + '\', [StringComparison]::OrdinalIgnoreCase)
if ($dataInside) { $keep += ($dataDir.Substring($AppDir.Length + 1) -split '[\\/]')[0] }
function Test-HoldsUserData([IO.FileSystemInfo]$Item) {
  if (-not ($Item -is [IO.DirectoryInfo])) { return $false }
  foreach ($marker in @('studio.sqlite', 'secrets.json', 'secrets.key')) {
    if (Test-Path -LiteralPath (Join-Path $Item.FullName $marker)) { return $true }
  }
  return $false
}
foreach ($item in Get-ChildItem -LiteralPath $AppDir -Force) {
  $name = $item.Name
  if (-not $deleteData) {
    if ($keep -contains $name -or $name -like '.env.backup-*') { continue }
    if (Test-HoldsUserData $item) { Say "Kept $($item.FullName) (it holds your data)." 'Green'; continue }
  }
  Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
if ($deleteData -and -not $dataInside -and (Test-Path $dataDir)) {
  Remove-Item -LiteralPath $dataDir -Recurse -Force
}
if (-not (Get-ChildItem -LiteralPath $AppDir -Force -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $AppDir -Force -ErrorAction SilentlyContinue
}

Say ''
Say 'AI Story Studio was removed.' 'Green'
if ($deleteData) {
  Say 'Your data was deleted as you asked.' 'Yellow'
} else {
  Say "Your data is still in $dataDir. Installing AI Story Studio again (same folder) uses it again." 'Green'
}
Say 'Programs installed separately (Node.js, Python, FFmpeg) were not removed.' 'Gray'
exit 0
