$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture = Join-Path $taskRoot ('artifacts\portable-build-test-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $fixture) { throw 'Use a fresh artifacts/portable-build-test directory for this test.' }
New-Item -ItemType Directory -Path (Join-Path $fixture 'webview2'), (Join-Path $fixture 'data') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $fixture 'webview2\old-runtime.txt') -Value 'disposable test fixture'
Set-Content -LiteralPath (Join-Path $fixture 'data\preserve.txt') -Value 'preserve user data'
& (Join-Path $PSScriptRoot 'build-portable.ps1') -SkipBuild -OutputDirectory $fixture
if (-not (Test-Path -LiteralPath (Join-Path $fixture 'SLH.exe'))) { throw 'Missing launcher executable.' }
if (-not (Test-Path -LiteralPath (Join-Path $fixture 'data\preserve.txt'))) { throw 'Existing data was deleted.' }
if (Test-Path -LiteralPath (Join-Path $fixture 'webview2')) { throw 'Legacy runtime was not removed (this test requires installed Evergreen).' }
$probe = Start-Process -FilePath (Join-Path $fixture 'SLH.exe') -ArgumentList '--check-webview-runtime' -WindowStyle Hidden -Wait -PassThru
if ($probe.ExitCode -ne 0) { throw 'Packaged launcher could not detect Evergreen.' }
$buildProbe = Start-Process -FilePath (Join-Path $fixture 'SLH.exe') -ArgumentList '--check-build-mode' -WindowStyle Hidden -Wait -PassThru
if ($buildProbe.ExitCode -ne 0) { throw 'Packaged launcher would try to connect to the development server.' }

# Simulate an open executable inside a different output directory. No app is launched.
$guardFixture = Join-Path $taskRoot ('artifacts\portable-guard-test-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $guardFixture) { throw 'Use a fresh portable-guard-test directory.' }
function Get-CimInstance { [pscustomobject]@{ ExecutablePath = (Join-Path $guardFixture 'SLH.exe') } }
$blocked = $false
try { & (Join-Path $PSScriptRoot 'build-portable.ps1') -SkipBuild -OutputDirectory $guardFixture }
catch { if ($_.Exception.Message -notmatch 'running from the output directory') { throw }; $blocked = $true }
if (-not $blocked -or (Test-Path -LiteralPath $guardFixture)) { throw 'The running-output guard modified the output directory.' }
Write-Host 'Portable regression tests passed: embedded frontend, Evergreen probe, legacy cleanup, data preservation, running-output guard.'
