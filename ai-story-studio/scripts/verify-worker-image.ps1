# Checks WITHOUT any password whether RunPod can pull the worker image (the same check as the
# app's dry-run diagnostics). Docker is not needed.
#
#   scripts\Verify-Worker-Image.bat
#   powershell -ExecutionPolicy Bypass -File scripts\verify-worker-image.ps1 [-Image ghcr.io/<user>/ai-story-studio-worker:1.1.0]
param(
  [string]$Image,
  [string]$Owner,
  [string]$Tag
)
. (Join-Path $PSScriptRoot 'worker-image-common.ps1')

$img = Resolve-Image $Image $Owner $Tag
Write-Step "Checking $($img.Name) anonymously (no password)"
$code = Invoke-ImageCheck $img.Name
Write-Host ''
switch ($code) {
  0 { Write-Ok 'OK: RunPod can pull this image. Run the dry-run diagnostics in AI Story Studio again.' }
  2 { Write-Warn 'The registry could not be reached from this PC. Check your internet connection and try again.' }
  default { Write-Warn 'Not pullable yet. Follow the advice above (push the image, then make the package public).' }
}
exit $code
