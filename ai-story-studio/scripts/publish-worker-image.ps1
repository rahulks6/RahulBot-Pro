# One-click: build, upload and verify the worker image, with a pause for making it public.
#
#   scripts\Publish-Worker-Image.bat
#   powershell -ExecutionPolicy Bypass -File scripts\publish-worker-image.ps1 [-Image ghcr.io/<user>/ai-story-studio-worker:1.1.0]
param(
  [string]$Image,
  [string]$Owner,
  [string]$Tag
)
. (Join-Path $PSScriptRoot 'worker-image-common.ps1')

$img = Resolve-Image $Image $Owner $Tag
Write-Host "This builds, uploads and checks $($img.Name)."
Write-Host 'It needs Docker Desktop, about 30 GB of free disk space, and a GitHub token (classic) with write:packages.'

& (Join-Path $PSScriptRoot 'build-worker-image.ps1') -Image $img.Name
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'push-worker-image.ps1') -Image $img.Name
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$settings = 'https://github.com/users/{0}/packages/container/package/{1}/settings' -f $img.Owner, $img.Repo
Write-Step 'Waiting for you to make the package public'
Write-Host "Opening $settings"
try { Start-Process $settings } catch { }
while ($true) {
  $answer = Read-Host 'After you clicked Change visibility -> Public, press Enter to check (or type Q to stop)'
  if ($answer -match '^[Qq]') { exit 1 }
  $code = Invoke-ImageCheck $img.Name
  if ($code -eq 0) {
    Write-Ok 'IMAGE EXISTS AND PUBLICLY PULLABLE. Run the dry-run diagnostics in AI Story Studio again.'
    exit 0
  }
  Write-Warn 'Not public yet (GitHub may take a minute). Check the visibility setting and try again.'
}
