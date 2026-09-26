# Shared helpers for the worker-image scripts (dot-sourced; not run directly).
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkerDir = Join-Path $AppDir 'worker'
$ImageRepoName = 'ai-story-studio-worker'

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host $Text -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host $Text -ForegroundColor Yellow }
function Stop-WithError([string]$Text) {
  Write-Host ''
  Write-Host $Text -ForegroundColor Red
  exit 1
}

# Runs a native command with all output discarded and returns $true when it exits with 0.
# (Windows PowerShell 5.1 turns redirected stderr into terminating errors under 'Stop'.)
function Test-NativeQuiet([string]$Exe, [string[]]$Arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments *> $null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Get-AppVersion {
  $pkg = Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json
  return [string]$pkg.version
}

# The GitHub user (or organisation) that owns the image: -Owner, else the image named in .env,
# else the git remote, else ask.
function Resolve-Owner([string]$Owner) {
  if (-not $Owner) {
    $envFile = Join-Path $AppDir '.env'
    if (Test-Path $envFile) {
      $line = Select-String -Path $envFile -Pattern '^\s*CLOUD_WORKER_IMAGE\s*=\s*ghcr\.io/([^/\s]+)/' | Select-Object -First 1
      if ($line) { $Owner = $line.Matches[0].Groups[1].Value }
    }
  }
  if (-not $Owner -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $url = [string](& git -C $AppDir remote get-url origin 2>$null)
      if ($url -match 'github\.com[:/]([^/]+)/') { $Owner = $Matches[1] }
    } catch { } finally { $ErrorActionPreference = $prev }
  }
  if (-not $Owner) { $Owner = Read-Host 'Your GitHub user name (the owner of the image)' }
  $Owner = $Owner.Trim()
  if ($Owner -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$') {
    Stop-WithError "'$Owner' is not a valid GitHub user name."
  }
  return $Owner
}

function Get-ImageName([string]$Owner, [string]$Tag) {
  if (-not $Tag) { $Tag = Get-AppVersion }
  if ($Tag -notmatch '^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$') { Stop-WithError "'$Tag' is not a valid image tag." }
  # Container image names must be lower case.
  return ('ghcr.io/{0}/{1}:{2}' -f $Owner.ToLowerInvariant(), $ImageRepoName, $Tag)
}

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Warn 'Docker is not installed.'
    Write-Warn '  1. Download Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/'
    Write-Warn '  2. Install it with the default options (it uses WSL 2; restart Windows if it asks).'
    Write-Warn '  3. Start Docker Desktop and wait until it shows "Engine running".'
    Write-Warn '  4. Run this script again.'
    Write-Warn 'No Docker? Use the GitHub Actions route instead (docs\RUNPOD_SETUP.md, step 3, option A).'
    exit 1
  }
  if (-not (Test-NativeQuiet 'docker' @('info', '--format', '{{.ServerVersion}}'))) {
    Stop-WithError 'Docker is installed but not running. Start Docker Desktop, wait until it shows "Engine running", then run this script again.'
  }
}
