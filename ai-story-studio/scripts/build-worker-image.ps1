# Builds the AI Story Studio cloud worker image with Docker Desktop (no GPU needed on this PC).
#
#   scripts\Build-Worker-Image.bat                       (double-click; asks for your GitHub name)
#   powershell -ExecutionPolicy Bypass -File scripts\build-worker-image.ps1 -Owner <github-user> [-Tag 1.1.0]
#
# Needs about 25 GB of free disk space and downloads about 6 GB (the PyTorch + CUDA base image and
# the AI libraries) the first time. Model weights are NOT included: they download on the GPU later.
# Nothing here uses a password, and nothing is uploaded; see push-worker-image.ps1 for that.
param(
  [string]$Owner,
  [string]$Tag,
  [string]$SourceRepo
)
. (Join-Path $PSScriptRoot 'worker-image-common.ps1')

Write-Step 'Checking Docker'
Assert-Docker
Write-Ok 'Docker is running.'

$Owner = Resolve-Owner $Owner
$Image = Get-ImageName $Owner $Tag
$dockerfile = Join-Path $WorkerDir 'Dockerfile.cuda'
if (-not (Test-Path $dockerfile)) { Stop-WithError "Missing $dockerfile. Run this from the AI Story Studio folder." }

$buildArgs = @('build', '--platform', 'linux/amd64', '-f', $dockerfile, '-t', $Image)
if ($SourceRepo) {
  if ($SourceRepo -notmatch '^[A-Za-z0-9._-]+$') { Stop-WithError "'$SourceRepo' is not a valid repository name." }
  # Links the package to your repository on GitHub (optional).
  $buildArgs += @('--build-arg', ('SOURCE_URL=https://github.com/{0}/{1}' -f $Owner, $SourceRepo))
}
$buildArgs += $WorkerDir

Write-Step "Building $Image (20-60 minutes the first time)"
& docker @buildArgs
if ($LASTEXITCODE -ne 0) {
  Stop-WithError "The build failed (exit code $LASTEXITCODE). Read the last lines above; docs\TROUBLESHOOTING_WINDOWS.md lists common causes. Nothing was uploaded and nothing cost money."
}
Write-Ok "Built $Image"
Write-Host 'Next: scripts\Push-Worker-Image.bat uploads it to GitHub Container Registry.'
exit 0
