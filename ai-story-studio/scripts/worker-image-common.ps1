# Shared helpers for the worker-image scripts (dot-sourced; not run directly).
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.
# No credentials live in these files: the GitHub token is typed in at push time, hidden.

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkerDir = Join-Path $AppDir 'worker'
$ImageRepoName = 'ai-story-studio-worker'
# The image AI Story Studio uses by default (Cloud GPU -> Advanced -> Worker image).
$DefaultImage = 'ghcr.io/rahulks6/ai-story-studio-worker:1.1.0'

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

# Runs a native command and returns its trimmed standard output ('' on failure).
function Get-NativeOutput([string]$Exe, [string[]]$Arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return ([string]($out -join "`n")).Trim()
  } catch {
    return ''
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Get-AppVersion {
  $pkg = Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json
  return [string]$pkg.version
}

# Which image to build/push/check: -Image, else -Owner/-Tag, else CLOUD_WORKER_IMAGE in .env,
# else the app's default (ghcr.io/rahulks6/ai-story-studio-worker:1.1.0).
function Resolve-Image([string]$Image, [string]$Owner, [string]$Tag) {
  if (-not $Image -and ($Owner -or $Tag)) {
    if (-not $Owner) { $Owner = 'rahulks6' }
    if (-not $Tag) { $Tag = Get-AppVersion }
    $Image = 'ghcr.io/{0}/{1}:{2}' -f $Owner, $ImageRepoName, $Tag
  }
  if (-not $Image) {
    $envFile = Join-Path $AppDir '.env'
    if (Test-Path $envFile) {
      $line = Select-String -Path $envFile -Pattern '^\s*CLOUD_WORKER_IMAGE\s*=\s*(\S+)\s*$' | Select-Object -First 1
      if ($line) { $Image = $line.Matches[0].Groups[1].Value }
    }
  }
  if (-not $Image) { $Image = $DefaultImage }
  $Image = $Image.Trim().ToLowerInvariant()
  if ($Image -notmatch '^ghcr\.io/([a-z0-9](?:[a-z0-9-]{0,38}))/([a-z0-9._-]+):([a-z0-9_][a-z0-9._-]{0,127})$') {
    Stop-WithError "'$Image' is not a GitHub Container Registry image name like ghcr.io/<github-user>/ai-story-studio-worker:1.1.0"
  }
  return [pscustomobject]@{ Name = $Image; Owner = $Matches[1]; Repo = $Matches[2]; Tag = $Matches[3] }
}

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Warn 'Docker is not installed.'
    Write-Warn '  1. Download Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/'
    Write-Warn '  2. Install it with the default options (WSL 2). Restart Windows if it asks.'
    Write-Warn '  3. Start Docker Desktop and wait until it shows "Engine running".'
    Write-Warn '  4. Run this script again.'
    Write-Warn 'No Docker? GitHub can build the image instead: docs\RUNPOD_SETUP.md, step 3, option A.'
    exit 1
  }
  $os = Get-NativeOutput 'docker' @('info', '--format', '{{.OSType}}')
  if (-not $os) {
    Stop-WithError 'Docker is installed but not running. Start Docker Desktop, wait until it shows "Engine running", then run this script again.'
  }
  if ($os -ne 'linux') {
    Stop-WithError 'Docker Desktop is set to Windows containers. Right-click the Docker icon near the clock -> "Switch to Linux containers...", then run this script again.'
  }
}

# Free space on the drive Docker Desktop stores images on (normally C:).
function Test-FreeSpace([int]$NeedGb) {
  try {
    $drive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction Stop
    $freeGb = [math]::Floor($drive.Free / 1GB)
    if ($freeGb -lt $NeedGb) {
      Write-Warn "Only $freeGb GB free on $($env:SystemDrive). The build needs about $NeedGb GB; it may fail with 'no space left on device'."
      $answer = Read-Host 'Continue anyway? [y/N]'
      if ($answer -notmatch '^[Yy]') { exit 1 }
    } else {
      Write-Ok "$freeGb GB free on $($env:SystemDrive) - OK."
    }
  } catch { }
}

# Anonymous pull check (no credentials), the same check as the app's dry run.
# Returns 0 = public, 1 = not pullable, 2 = registry unreachable.
function Invoke-ImageCheck([string]$ImageName) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warn 'Node.js was not found, so the anonymous check cannot run. Run the AI Story Studio installer first.'
    return 2
  }
  # Out-Host: the check's text goes to the screen, not into this function's return value.
  & node --disable-warning=ExperimentalWarning (Join-Path $AppDir 'src\cli\check-worker-image.ts') $ImageName | Out-Host
  return [int]$LASTEXITCODE
}
