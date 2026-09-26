# Uploads the worker image to GitHub Container Registry (ghcr.io), then checks it.
#
#   scripts\Push-Worker-Image.bat
#   powershell -ExecutionPolicy Bypass -File scripts\push-worker-image.ps1 -Owner <github-user> [-Tag 1.1.0] [-KeepLogin]
#
# You need a GitHub token (classic) with the "write:packages" scope. The script asks for it with
# hidden input, hands it to "docker login --password-stdin" (never on the command line, never
# written to a file by this script) and logs out again afterwards unless you pass -KeepLogin.
param(
  [string]$Owner,
  [string]$Tag,
  [switch]$KeepLogin
)
. (Join-Path $PSScriptRoot 'worker-image-common.ps1')

Write-Step 'Checking Docker'
Assert-Docker
$Owner = Resolve-Owner $Owner
$Image = Get-ImageName $Owner $Tag
if (-not (Test-NativeQuiet 'docker' @('image', 'inspect', $Image))) { Stop-WithError "The image $Image is not on this PC yet. Run scripts\Build-Worker-Image.bat first." }
Write-Ok "Found $Image"

Write-Step 'Signing in to GitHub Container Registry'
Write-Host 'Create a token if you do not have one:'
Write-Host '  github.com -> your picture -> Settings -> Developer settings -> Personal access tokens'
Write-Host '  -> Tokens (classic) -> Generate new token (classic). Tick ONLY "write:packages",'
Write-Host '  choose a short expiration (e.g. 7 days), click Generate, and copy the token.'
$secure = Read-Host 'Paste the token here (it is not shown) and press Enter' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if (-not $plain) { Stop-WithError 'No token was entered.' }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue' # docker login prints notices on stderr
  $plain | & docker login ghcr.io --username $Owner --password-stdin
  $loginCode = $LASTEXITCODE
  $ErrorActionPreference = $prev
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $plain = $null
}
if ($loginCode -ne 0) {
  Stop-WithError 'Sign-in failed. Check the user name and that the token has the "write:packages" scope and has not expired.'
}

try {
  Write-Step "Uploading $Image (several GB; this can take a long time)"
  & docker push $Image
  if ($LASTEXITCODE -ne 0) { Stop-WithError "Upload failed (exit code $LASTEXITCODE). Run this script again; finished layers are not uploaded twice." }
  Write-Ok "Uploaded $Image"
} finally {
  if (-not $KeepLogin) {
    [void](Test-NativeQuiet 'docker' @('logout', 'ghcr.io'))
    Write-Host 'Signed out of ghcr.io (the token is no longer stored by Docker).'
  }
}

Write-Step 'Make the image public (once)'
Write-Host ('  1. Open https://github.com/users/{0}/packages/container/package/{1}' -f $Owner, $ImageRepoName)
Write-Host '  2. Package settings (right side) -> Danger Zone -> Change visibility -> Public -> confirm.'
Write-Host '  3. Then run scripts\Verify-Worker-Image.bat - it must say IMAGE EXISTS AND PUBLICLY PULLABLE.'
Write-Host ''
& (Join-Path $PSScriptRoot 'verify-worker-image.ps1') -Owner $Owner -Tag $Tag -NoPause
exit 0
