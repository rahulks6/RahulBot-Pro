# AI Story Studio - Windows installer (v1.1.0)
#
# Safe to run more than once. It:
#   1. checks Node.js (>= 22.18), Python (>= 3.11) and FFmpeg, and installs one with WinGet
#      ONLY when it is missing or too old; if WinGet fails (e.g. MSI error 1603) it explains
#      how to install it by hand, then checks again;
#   2. installs the app's dependencies and builds it;
#   3. creates the Python virtual environment for the optional local worker;
#   4. creates a safe .env (mock mode, cloud GPU off) if none exists - an existing .env is never changed;
#   5. restricts the data folder (API key, database) to your Windows user;
#   6. creates a desktop shortcut and runs installation checks.
# It never installs CUDA, NVIDIA drivers or anything GPU-related: AI generation runs on a
# rented cloud GPU, so this PC does not need an NVIDIA graphics card.
#
# Usage (from this folder):  Install-AI-Story-Studio.bat
#    or:  powershell -ExecutionPolicy Bypass -File install.ps1 [-CheckOnly] [-NoShortcut]

param(
  [switch]$CheckOnly,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$LogFile = Join-Path $PSScriptRoot 'install.log'
$MinNode = [version]'22.18.0'
$MinPython = [version]'3.11.0'

function Write-Log([string]$Message, [string]$Color = 'Gray') {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $LogFile -Value $line
  Write-Host $Message -ForegroundColor $Color
}

function Update-SessionPath {
  # Pick up PATH changes made by an installer without opening a new window.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Get-ToolVersion([string]$Command, [string[]]$Arguments, [string]$Pattern) {
  # Returns a [version] when the command exists AND runs; $null otherwise.
  $cmd = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  # The Microsoft Store "python" alias lives in WindowsApps and does not really run Python.
  if ($cmd.Source -and $cmd.Source -like '*\WindowsApps\*' -and $Command -like 'python*') { return $null }
  try {
    $out = & $cmd.Source @Arguments 2>&1 | Out-String
  } catch {
    return $null
  }
  $m = [regex]::Match($out, $Pattern)
  if (-not $m.Success) { return $null }
  try { return [version]$m.Groups[1].Value } catch { return $null }
}

function Get-NodeVersion { Get-ToolVersion 'node' @('--version') 'v(\d+\.\d+\.\d+)' }

function Get-PythonCommand {
  # Prefer the Python launcher (py -3.11 or newer), then python.exe on PATH.
  foreach ($v in @('3.13', '3.12', '3.11')) {
    $ver = Get-ToolVersion 'py' @("-$v", '--version') 'Python (\d+\.\d+\.\d+)'
    if ($ver -and $ver -ge $MinPython) { return @{ Exe = 'py'; Args = @("-$v"); Version = $ver } }
  }
  $ver = Get-ToolVersion 'python' @('--version') 'Python (\d+\.\d+\.\d+)'
  if ($ver -and $ver -ge $MinPython) { return @{ Exe = (Get-Command python).Source; Args = @(); Version = $ver } }
  return $null
}

function Get-FfmpegVersion { Get-ToolVersion 'ffmpeg' @('-version') 'ffmpeg version (?:n|N-)?(\d+\.\d+(?:\.\d+)?)' }

function Install-WithWinget([string]$Id, [string]$Name) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Log "WinGet is not available on this PC, so $Name cannot be installed automatically." 'Yellow'
    return $false
  }
  Write-Log "Installing $Name with WinGet ($Id)..." 'Cyan'
  & winget install --id $Id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Log "WinGet could not install $Name (exit code $code)." 'Yellow'
    if ($code -eq 1603 -or $code -eq -1978335215) {
      Write-Log '  Error 1603 is a generic Windows Installer failure. Common causes: another installation is running,' 'Yellow'
      Write-Log '  a restart is pending, an older copy is half-installed, or the installer needs administrator rights.' 'Yellow'
    }
    return $false
  }
  Update-SessionPath
  return $true
}

function Show-ManualHelp([string]$Name, [string]$Url, [string]$Extra) {
  Write-Log '' 'Gray'
  Write-Log "Please install $Name by hand:" 'Yellow'
  Write-Log "  1. Open $Url" 'Yellow'
  Write-Log "  2. $Extra" 'Yellow'
  Write-Log '  3. Close this window, open a NEW one, and run Install-AI-Story-Studio.bat again.' 'Yellow'
}

function Test-Prerequisites([bool]$Install) {
  $ok = $true

  # --- Node.js -------------------------------------------------------------------------------
  $node = Get-NodeVersion
  if ($node -and $node -ge $MinNode) {
    Write-Log "Node.js $node found - OK (no installation needed)." 'Green'
  } else {
    if ($node) { Write-Log "Node.js $node is too old (need $MinNode or newer)." 'Yellow' } else { Write-Log 'Node.js was not found.' 'Yellow' }
    if ($Install) { [void](Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS') }
    $node = Get-NodeVersion
    if ($node -and $node -ge $MinNode) {
      Write-Log "Node.js $node is now available - OK." 'Green'
    } else {
      $ok = $false
      Show-ManualHelp 'Node.js (LTS)' 'https://nodejs.org/' 'Download the "LTS" Windows Installer (.msi), right-click it and choose "Run as administrator". If it fails with 1603, restart Windows first and uninstall any older Node.js in Settings > Apps.'
    }
  }

  # --- Python ----------------------------------------------------------------------------------
  $py = Get-PythonCommand
  if ($py) {
    Write-Log "Python $($py.Version) found - OK." 'Green'
  } else {
    Write-Log "Python $MinPython or newer was not found." 'Yellow'
    if ($Install) { [void](Install-WithWinget 'Python.Python.3.11' 'Python 3.11') }
    $py = Get-PythonCommand
    if ($py) {
      Write-Log "Python $($py.Version) is now available - OK." 'Green'
    } else {
      $ok = $false
      Show-ManualHelp 'Python 3.11' 'https://www.python.org/downloads/windows/' 'Download "Windows installer (64-bit)" for Python 3.11 and TICK "Add python.exe to PATH" on the first screen.'
    }
  }

  # --- FFmpeg (needed for the final MP4; the app still runs without it) ----------------------------
  $ff = Get-FfmpegVersion
  if ($ff) {
    Write-Log "FFmpeg $ff found - OK." 'Green'
  } else {
    Write-Log 'FFmpeg was not found (needed to build the final MP4).' 'Yellow'
    if ($Install) { [void](Install-WithWinget 'Gyan.FFmpeg' 'FFmpeg') }
    $ff = Get-FfmpegVersion
    if ($ff) {
      Write-Log "FFmpeg $ff is now available - OK." 'Green'
    } else {
      Write-Log 'FFmpeg is still missing. The app works, but BUILD FINAL writes a placeholder instead of an MP4.' 'Yellow'
      Write-Log '  Install it from https://www.gyan.dev/ffmpeg/builds/ (release essentials), unzip it, and either add its' 'Yellow'
      Write-Log '  "bin" folder to PATH or set FFMPEG_PATH and FFPROBE_PATH in the .env file.' 'Yellow'
    }
  }

  Write-Log 'No NVIDIA GPU is needed on this PC: AI generation runs on a rented cloud GPU. CUDA is NOT installed.' 'Gray'
  return @{ Ok = $ok; Python = $py }
}

function Invoke-Step([string]$Title, [scriptblock]$Block) {
  Write-Log "== $Title" 'Cyan'
  & $Block
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "$Title failed (exit code $LASTEXITCODE). See $LogFile" }
}

# ------------------------------------------------------------------------------------------------------
Set-Content -Path $LogFile -Value "AI Story Studio installer log - $(Get-Date)"
Write-Log "AI Story Studio installer - app folder: $AppDir" 'White'

$pre = Test-Prerequisites (-not $CheckOnly)
if ($CheckOnly) {
  if ($pre.Ok) { Write-Log 'All required prerequisites are present.' 'Green'; exit 0 } else { exit 1 }
}
if (-not $pre.Ok) {
  Write-Log 'Stopping: install the missing prerequisites above, then run the installer again.' 'Red'
  exit 1
}

Push-Location $AppDir
try {
  Invoke-Step 'Installing app dependencies (npm)' {
    if (Test-Path 'package-lock.json') { & npm ci --no-audit --no-fund } else { & npm install --no-audit --no-fund }
  }
  Invoke-Step 'Building the app' { & npm run build }

  Invoke-Step 'Creating the Python environment for the local worker' {
    $py = $pre.Python
    if (-not (Test-Path 'worker\.venv\Scripts\python.exe')) { & $py.Exe @($py.Args + @('-m', 'venv', 'worker\.venv')) }
    & 'worker\.venv\Scripts\python.exe' -m pip install --upgrade pip --disable-pip-version-check -q
    & 'worker\.venv\Scripts\python.exe' -m pip install -r 'worker\requirements.txt' --disable-pip-version-check -q
  }

  Write-Log '== Configuration' 'Cyan'
  if (Test-Path '.env') {
    Write-Log '.env already exists - left unchanged.' 'Green'
  } else {
    Copy-Item '.env.example' '.env'
    Write-Log 'Created .env with safe defaults (MOCK_GENERATION=true, ENABLE_CLOUD_GPU=false).' 'Green'
  }
  New-Item -ItemType Directory -Force -Path 'data' | Out-Null
  try {
    # The data folder holds the database and the cloud API key: only this Windows user may read it.
    & icacls 'data' /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" /grant:r 'SYSTEM:(OI)(CI)F' | Out-Null
    Write-Log 'Data folder restricted to your Windows user.' 'Green'
  } catch {
    Write-Log 'Could not restrict the data folder permissions (continuing).' 'Yellow'
  }

  if (-not $NoShortcut) {
    Write-Log '== Desktop shortcut' 'Cyan'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut((Join-Path $desktop 'AI Story Studio.lnk'))
    $lnk.TargetPath = Join-Path $AppDir 'installer\windows\Start-AI-Story-Studio.bat'
    $lnk.WorkingDirectory = $AppDir
    $lnk.Description = 'AI Story Studio'
    $lnk.Save()
    Write-Log "Shortcut created: $desktop\AI Story Studio.lnk" 'Green'
  }

  Write-Log '== Installation checks' 'Cyan'
  $checks = @(
    @{ Name = 'Built server'; Ok = (Test-Path 'dist\src\web\server.js') },
    @{ Name = '.env present'; Ok = (Test-Path '.env') },
    @{ Name = 'Mock mode is the default'; Ok = ((Get-Content '.env' -Raw) -match '(?m)^MOCK_GENERATION=true') },
    @{ Name = 'Worker environment'; Ok = (Test-Path 'worker\.venv\Scripts\python.exe') },
    @{ Name = 'Database migrations'; Ok = (Test-Path 'migrations\0004_cloud_gpu.sql') }
  )
  $failed = 0
  foreach ($c in $checks) {
    if ($c.Ok) { Write-Log "  [OK]   $($c.Name)" 'Green' } else { Write-Log "  [FAIL] $($c.Name)" 'Red'; $failed++ }
  }
  if ($failed -gt 0) { throw "$failed installation check(s) failed. See $LogFile" }
  Write-Log '' 'Gray'
  Write-Log 'AI Story Studio is installed. Start it from the desktop shortcut (it opens http://127.0.0.1:3000/).' 'Green'
  Write-Log 'Cloud GPU is OFF until you follow docs\RUNPOD_SETUP.md.' 'Green'
} catch {
  Write-Log "INSTALLATION FAILED: $($_.Exception.Message)" 'Red'
  Write-Log 'See docs\TROUBLESHOOTING_WINDOWS.md' 'Red'
  exit 1
} finally {
  Pop-Location
}
