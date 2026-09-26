# Uploads the worker image to GitHub Container Registry (ghcr.io), then checks it anonymously.
#
#   scripts\Push-Worker-Image.bat
#   powershell -ExecutionPolicy Bypass -File scripts\push-worker-image.ps1 [-Image ghcr.io/<user>/ai-story-studio-worker:1.1.0] [-KeepLogin]
#
# You need a GitHub token (classic) with the "write:packages" scope. The script asks for it with
# hidden input, hands it to "docker login --password-stdin" (never on the command line, never
# written to a file by this script) and signs out again afterwards unless you pass -KeepLogin.
param(
  [string]$Image,
  [string]$Owner,
  [string]$Tag,
  [switch]$KeepLogin
)
. (Join-Path $PSScriptRoot 'worker-image-common.ps1')

Write-Step 'Checking Docker'
Assert-Docker
$img = Resolve-Image $Image $Owner $Tag
if (-not (Test-NativeQuiet 'docker' @('image', 'inspect', $img.Name))) {
  Stop-WithError "The image $($img.Name) is not on this PC yet. Run scripts\Build-Worker-Image.bat first."
}
Write-Ok "Found $($img.Name)"

Write-Step "Signing in to GitHub Container Registry as '$($img.Owner)'"
Write-Host 'You need a GitHub token (classic) that can upload packages:'
Write-Host '  github.com -> your picture -> Settings -> Developer settings -> Personal access tokens'
Write-Host '  -> Tokens (classic) -> Generate new token (classic). Tick ONLY "write:packages",'
Write-Host '  choose a short expiration (e.g. 7 days), click Generate token, and copy it.'
Write-Host '  (Direct link: https://github.com/settings/tokens/new?scopes=write:packages&description=AI%20Story%20Studio%20worker%20image)'
$secure = Read-Host 'Paste the token here (it is not shown) and press Enter' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$loginCode = 1
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if (-not $plain) { Stop-WithError 'No token was entered.' }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue' # docker login prints notices on stderr
  $plain | & docker login ghcr.io --username $img.Owner --password-stdin
  $loginCode = $LASTEXITCODE
  $ErrorActionPreference = $prev
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $plain = $null
  $secure = $null
}
if ($loginCode -ne 0) {
  Stop-WithError "Sign-in failed. Check the user name ('$($img.Owner)') and that the token is a classic token with 'write:packages' that has not expired."
}

try {
  Write-Step "Uploading $($img.Name) (several GB; this can take a long time)"
  & docker push $img.Name
  if ($LASTEXITCODE -ne 0) { Stop-WithError "Upload failed (exit code $LASTEXITCODE). Run this script again; finished parts are not uploaded twice." }
  Write-Ok "Uploaded $($img.Name)"
} finally {
  if (-not $KeepLogin) {
    [void](Test-NativeQuiet 'docker' @('logout', 'ghcr.io'))
    Write-Host 'Signed out of ghcr.io (Docker no longer stores the token).'
  }
}

$settings = 'https://github.com/users/{0}/packages/container/package/{1}/settings' -f $img.Owner, $img.Repo
Write-Step 'Make the image public (once)'
Write-Host "  1. Open $settings"
Write-Host '  2. Scroll to "Danger Zone" -> "Change visibility" -> Public -> type the name -> confirm.'
Write-Host '  3. Then run scripts\Verify-Worker-Image.bat. It must say IMAGE EXISTS AND PUBLICLY PULLABLE.'
Write-Host ''
Write-Step 'Anonymous check right now (expected: REQUIRES AUTHENTICATION until you make it public)'
[void](Invoke-ImageCheck $img.Name)
exit 0
