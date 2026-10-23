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

$appPath = Join-Path $installRoot 'ClipPulse.exe'
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
  throw "Installed application was not found at $appPath"
}
$resources = Join-Path $installRoot 'resources'
$appArchive = Join-Path $resources 'app.asar'
$licenseNotices = Join-Path $resources 'third-party-licenses\THIRD_PARTY_NOTICES.md'
$onnxBinding = Join-Path $resources 'app.asar.unpacked\node_modules\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime_binding.node'
foreach ($requiredFile in @($appArchive, $licenseNotices, $onnxBinding)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Installed package is missing a required application/dependency file: $requiredFile"
  }
}
if ((Get-Item -LiteralPath $licenseNotices).Length -eq 0) {
  throw 'Installed third-party license notices are empty.'
}

$mcpEntry = Join-Path $appArchive 'dist\src\main\cli.js'
& node (Join-Path $PSScriptRoot 'smoke-test-packaged-mcp.cjs') $appPath $mcpEntry
if ($LASTEXITCODE -ne 0) {
  throw "Installed application's MCP stdio smoke test failed with exit code $LASTEXITCODE."
}

$env:APPDATA = Join-Path $runnerTemp 'clippulse-smoke-appdata'
$env:LOCALAPPDATA = Join-Path $runnerTemp 'clippulse-smoke-localappdata'
New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null

$app = Start-Process -FilePath $appPath -PassThru -WindowStyle Hidden
if ($app.WaitForExit(12000)) {
  throw "Installed editor exited during startup with code $($app.ExitCode)."
}
Stop-Process -Id $app.Id -Force
Write-Output 'NSIS installed the Electron app, production archive, ONNX native binding, and license notices; its window stayed open for 12 seconds.'
