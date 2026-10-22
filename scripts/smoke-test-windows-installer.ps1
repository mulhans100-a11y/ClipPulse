param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

if (-not $env:RUNNER_TEMP) {
  throw 'This smoke test is intended for a disposable GitHub Actions runner (RUNNER_TEMP is missing).'
}

$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$installer = [System.IO.Path]::GetFullPath($InstallerPath)
$installRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp 'clippulse-installed'))
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Installer not found: $installer"
}
if (-not $installRoot.StartsWith($runnerTemp + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Install destination is outside RUNNER_TEMP: $installRoot"
}

Get-Command ffmpeg -ErrorAction Stop | Out-Null
Get-Command ffprobe -ErrorAction Stop | Out-Null

$install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
if ($install.ExitCode -ne 0) {
  throw "Silent NSIS installation failed with exit code $($install.ExitCode)."
}

$appPath = Join-Path $installRoot 'OpenMontage AI.exe'
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
  throw "Installed application was not found at $appPath"
}

$app = Start-Process -FilePath $appPath -PassThru -WindowStyle Hidden
if ($app.WaitForExit(12000)) {
  throw "Installed editor exited during startup with code $($app.ExitCode)."
}
Stop-Process -Id $app.Id -Force
Write-Output 'NSIS installed the app and its Electron window stayed open for 12 seconds.'
