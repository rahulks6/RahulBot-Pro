# Builds the AI Story Studio cloud worker image with Docker Desktop (no GPU needed on this PC).
#
#   scripts\Build-Worker-Image.bat
#   powershell -ExecutionPolicy Bypass -File scripts\build-worker-image.ps1 [-Image ghcr.io/<user>/ai-story-studio-worker:1.2.0]
#
# Default image: ghcr.io/rahulks6/ai-story-studio-worker:1.2.0 (or CLOUD_WORKER_IMAGE from .env).
# Needs about 30 GB of free disk space and downloads about 6 GB the first time. Model weights are
# NOT included (they download on the GPU later). No password is used; nothing is uploaded.
param(
  [string]$Image,
  [string]$Owner,
  [string]$Tag
)
. (Join-Path $PSScriptRoot 'worker-image-common.ps1')

Write-Step 'Checking Docker'
Assert-Docker
Write-Ok 'Docker is running (Linux containers).'
Test-FreeSpace 30

$img = Resolve-Image $Image $Owner $Tag
$dockerfile = Join-Path $WorkerDir 'Dockerfile.cuda'
if (-not (Test-Path $dockerfile)) { Stop-WithError "Missing $dockerfile. Run this from the AI Story Studio folder." }

Write-Step "Building $($img.Name) (20-60 minutes the first time)"
$buildArgs = @('build', '--platform', 'linux/amd64', '-f', $dockerfile, '-t', $img.Name, $WorkerDir)
& docker @buildArgs
if ($LASTEXITCODE -ne 0) {
  Stop-WithError "The build failed (exit code $LASTEXITCODE). Read the last lines above; docs\TROUBLESHOOTING_WINDOWS.md lists common causes. Nothing was uploaded and nothing cost money."
}

Write-Step 'Checking the built image'
$cmd = Get-NativeOutput 'docker' @('image', 'inspect', '--format', '{{json .Config.Cmd}} {{json .Config.ExposedPorts}} {{.Architecture}}', $img.Name)
Write-Host "  command, port, architecture: $cmd"
if ($cmd -notmatch 'ais_worker' -or $cmd -notmatch '8765/tcp' -or $cmd -notmatch 'amd64') {
  Stop-WithError 'The image does not have the expected start command (python -m ais_worker), port 8765 or linux/amd64.'
}
Write-Ok "Built $($img.Name)"
Write-Host 'Next: scripts\Push-Worker-Image.bat uploads it to GitHub Container Registry.'
exit 0
