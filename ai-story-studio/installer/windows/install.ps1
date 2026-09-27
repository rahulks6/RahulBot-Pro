# AI Story Studio - Windows installer (v1.3.0)
#
# Safe to run more than once. It:
#   1. checks Node.js (>= 22.18) and FFmpeg (required) and Python (>= 3.11, optional: only for the
#      Advanced LOCAL GPU mode), and installs one with WinGet ONLY when it is missing or too old;
#      if WinGet fails (e.g. MSI error 1603) it explains how to install it by hand;
#   2. installs the app's dependencies and builds it;
#   3. creates the Python virtual environment for the optional local worker (when Python is present);
#   4. creates .env if none exists (real AI on RunPod; the key is entered in the app) - an existing
#      .env is never changed;
#   5. restricts the data folder (keys, database) to your Windows user;
#   6. creates the desktop and Start Menu shortcuts, registers "AI Story Studio" in
#      Settings > Apps (with Uninstall), and runs installation checks.
# It never installs CUDA, NVIDIA drivers, AI models or anything GPU-related: AI generation runs on a
# rented RunPod GPU, so this PC does not need an NVIDIA graphics card.
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
  # Optional: only the Advanced LOCAL GPU mode runs the AI worker on this PC. RunPod needs no Python here.
  $py = Get-PythonCommand
  if ($py) {
    Write-Log "Python $($py.Version) found - OK (optional, for LOCAL GPU mode)." 'Green'
  } else {
    Write-Log "Python $MinPython or newer was not found (optional: only needed for the Advanced LOCAL GPU mode)." 'Yellow'
    if ($Install) { [void](Install-WithWinget 'Python.Python.3.11' 'Python 3.11') }
    $py = Get-PythonCommand
    if ($py) {
      Write-Log "Python $($py.Version) is now available - OK." 'Green'
    } else {
      Write-Log 'Continuing without Python: making videos on RunPod works; LOCAL GPU mode stays unavailable.' 'Yellow'
    }
  }

  # --- FFmpeg (required: it builds every final MP4, Short, caption burn-in and thumbnail) -----------
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
      $ok = $false
      Show-ManualHelp 'FFmpeg' 'https://www.gyan.dev/ffmpeg/builds/' 'Download "ffmpeg-release-essentials.zip", unzip it (e.g. to C:\ffmpeg) and add its "bin" folder to PATH (Settings > System > About > Advanced system settings > Environment Variables), or set FFMPEG_PATH and FFPROBE_PATH in the .env file.'
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

  if ($pre.Python) {
    Invoke-Step 'Creating the Python environment for the optional local worker' {
      $py = $pre.Python
      if (-not (Test-Path 'worker\.venv\Scripts\python.exe')) { & $py.Exe @($py.Args + @('-m', 'venv', 'worker\.venv')) }
      & 'worker\.venv\Scripts\python.exe' -m pip install --upgrade pip --disable-pip-version-check -q
      & 'worker\.venv\Scripts\python.exe' -m pip install -r 'worker\requirements.txt' --disable-pip-version-check -q
    }
  }

  Write-Log '== Configuration' 'Cyan'
  if (Test-Path '.env') {
    Write-Log '.env already exists - left unchanged.' 'Green'
  } else {
    Copy-Item '.env.example' '.env'
    Write-Log 'Created .env (real AI; connect your RunPod key in the app: Settings -> AI Engine).' 'Green'
  }
  New-Item -ItemType Directory -Force -Path 'data' | Out-Null
  try {
    # The data folder holds the database and the cloud API key: only this Windows user may read it.
    & icacls 'data' /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" /grant:r 'SYSTEM:(OI)(CI)F' | Out-Null
    Write-Log 'Data folder restricted to your Windows user.' 'Green'
  } catch {
    Write-Log 'Could not restrict the data folder permissions (continuing).' 'Yellow'
  }

  $version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
  $uninstallCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$AppDir\installer\windows\uninstall.ps1`""
  if (-not $NoShortcut) {
    Write-Log '== Shortcuts (desktop and Start Menu)' 'Cyan'
    $shell = New-Object -ComObject WScript.Shell
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'AI Story Studio'
    New-Item -ItemType Directory -Force -Path $menu | Out-Null
    foreach ($path in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI Story Studio.lnk'), (Join-Path $menu 'AI Story Studio.lnk'))) {
      $lnk = $shell.CreateShortcut($path)
      $lnk.TargetPath = Join-Path $AppDir 'installer\windows\Start-AI-Story-Studio.bat'
      $lnk.WorkingDirectory = $AppDir
      $lnk.Description = 'AI Story Studio'
      $lnk.Save()
      Write-Log "Shortcut created: $path" 'Green'
    }
    $un = $shell.CreateShortcut((Join-Path $menu 'Uninstall AI Story Studio.lnk'))
    $un.TargetPath = 'powershell.exe'
    $un.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$AppDir\installer\windows\uninstall.ps1`""
    $un.WorkingDirectory = $env:TEMP
    $un.Description = 'Uninstall AI Story Studio (your data is kept)'
    $un.Save()
  }

  Write-Log '== Settings > Apps entry (for Uninstall)' 'Cyan'
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AIStoryStudio'
  New-Item -Path $key -Force | Out-Null
  $entry = @{
    DisplayName     = 'AI Story Studio'
    DisplayVersion  = $version
    Publisher       = 'AI Story Studio'
    InstallLocation = $AppDir
    UninstallString = $uninstallCmd
    DisplayIcon     = 'powershell.exe'
  }
  foreach ($k in $entry.Keys) { New-ItemProperty -Path $key -Name $k -Value $entry[$k] -PropertyType String -Force | Out-Null }
  New-ItemProperty -Path $key -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
  Write-Log "Registered AI Story Studio $version in Settings > Apps." 'Green'

  Write-Log '== Installation checks' 'Cyan'
  $checks = @(
    @{ Name = 'Built server'; Ok = (Test-Path 'dist\src\web\server.js') },
    @{ Name = '.env present'; Ok = (Test-Path '.env') },
    @{ Name = '.env readable'; Ok = ((Get-Content '.env' -Raw) -match '(?m)^MOCK_GENERATION=') },
    @{ Name = 'Worker environment (optional)'; Ok = (-not $pre.Python) -or (Test-Path 'worker\.venv\Scripts\python.exe') },
    @{ Name = 'Database migrations'; Ok = (Test-Path 'migrations\0008_story_format.sql') },
    @{ Name = 'Uninstaller'; Ok = (Test-Path 'installer\windows\uninstall.ps1') }
  )
  $failed = 0
  foreach ($c in $checks) {
    if ($c.Ok) { Write-Log "  [OK]   $($c.Name)" 'Green' } else { Write-Log "  [FAIL] $($c.Name)" 'Red'; $failed++ }
  }
  if ($failed -gt 0) { throw "$failed installation check(s) failed. See $LogFile" }
  Write-Log '' 'Gray'
  Write-Log 'AI Story Studio is installed. Start it from the desktop or Start Menu shortcut (it opens http://127.0.0.1:3000/).' 'Green'
  Write-Log 'The first start opens the setup wizard: choose storage, connect RunPod, test the AI Engine.' 'Green'
} catch {
  Write-Log "INSTALLATION FAILED: $($_.Exception.Message)" 'Red'
  Write-Log 'See docs\TROUBLESHOOTING_WINDOWS.md' 'Red'
  exit 1
} finally {
  Pop-Location
}
exit 0
