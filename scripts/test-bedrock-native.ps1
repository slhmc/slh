$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$leviRoot = Join-Path $projectRoot 'vendor\LeviLauncher'
$nativePatch = Join-Path $projectRoot 'patches\levilauncher-native-xuid.patch'
$goCommand = Get-Command go.exe -ErrorAction SilentlyContinue
if (-not $goCommand) {
    throw "Go 1.25.3 or newer is required for the LeviLauncher native helper tests."
}

$patchApplied = $false
try {
    & git -C $leviRoot apply --check --whitespace=nowarn $nativePatch
    if ($LASTEXITCODE -ne 0) {
        throw "The pinned LeviLauncher checkout does not match patches\levilauncher-native-xuid.patch."
    }
    & git -C $leviRoot apply --whitespace=nowarn $nativePatch
    if ($LASTEXITCODE -ne 0) {
        throw "Could not apply the SLH Bedrock helper patch for tests."
    }
    $patchApplied = $true
    Push-Location $leviRoot
    try {
        & $goCommand.Source test '.\internal\nativeinstall' '.\internal\xbox' '.\cmd\msixvc-native'
        if ($LASTEXITCODE -ne 0) {
            throw "Bedrock native helper tests failed (exit code $LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
} finally {
    if ($patchApplied) {
        & git -C $leviRoot apply --reverse --whitespace=nowarn $nativePatch
        if ($LASTEXITCODE -ne 0) {
            throw "The temporary LeviLauncher test patch could not be reverted."
        }
    }
}
