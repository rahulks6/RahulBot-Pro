# Checks WITHOUT any password whether RunPod can pull the worker image (the same check as the
# app's dry-run diagnostics). Docker is not needed.
#
#   scripts\Verify-Worker-Image.bat
#   powershell -ExecutionPolicy Bypass -File scripts\verify-worker-image.ps1 [-Owner <github-user>] [-Tag 1.1.0] [-Image <full name>]
param(
  [string]$Owner,
  [string]$Tag,
  [string]$Image,
  [switch]$NoPause
)
. (Join-Path $PSScriptRoot 'worker-image-common.ps1')

if (-not $Image) {
  $Owner = Resolve-Owner $Owner
  $Image = Get-ImageName $Owner $Tag
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithError 'Node.js is needed for this check. Run the AI Story Studio installer first.'
}
Write-Step "Checking $Image anonymously"
& node --disable-warning=ExperimentalWarning (Join-Path $AppDir 'src\cli\check-worker-image.ts') $Image
$code = $LASTEXITCODE
Write-Host ''
switch ($code) {
  0 { Write-Ok 'OK: RunPod can pull this image. Run the dry-run diagnostics in AI Story Studio again.' }
  2 { Write-Warn 'The registry could not be reached from this PC. Check your internet connection and try again.' }
  default { Write-Warn 'Not pullable yet. Follow the advice above (build and push, then make the package public).' }
}
exit $code
