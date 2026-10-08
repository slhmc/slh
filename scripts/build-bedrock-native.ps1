param(
    [ValidateSet('x64', 'x86')]
    [string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$leviRoot = Join-Path $projectRoot 'vendor\LeviLauncher'
$binariesRoot = Join-Path $projectRoot 'src-tauri\binaries'
$targetTriple = if ($Architecture -eq 'x86') {
    'i686-pc-windows-msvc'
} else {
    'x86_64-pc-windows-msvc'
}
$goArch = if ($Architecture -eq 'x86') { '386' } else { 'amd64' }
$outputPath = Join-Path $binariesRoot "slh-bedrock-native-$targetTriple.exe"

if (-not (Test-Path -LiteralPath (Join-Path $leviRoot 'go.mod'))) {
    throw "Pinned LeviLauncher source is missing at $leviRoot. Initialize the vendor submodule first."
}

$goCommand = Get-Command go.exe -ErrorAction SilentlyContinue
if (-not $goCommand) {
    throw "Go 1.25.3 or newer is required to build the pinned Bedrock native helper. Install Go, then run npm run build:bedrock-native."
}

$goVersion = (& $goCommand.Source version 2>$null | Select-Object -First 1)
if ($goVersion -notmatch 'go1\.(2[5-9]|[3-9][0-9])') {
    throw "The pinned LeviLauncher helper requires Go 1.25.3 or newer; detected $goVersion."
}

New-Item -ItemType Directory -Force -Path $binariesRoot | Out-Null
$nativePatch = Join-Path $projectRoot 'patches\levilauncher-native-xuid.patch'
$patchApplied = $false
$oldGoos = $env:GOOS
$oldGoarch = $env:GOARCH
$oldCgo = $env:CGO_ENABLED
try {
    if (Test-Path -LiteralPath $nativePatch) {
        & git -C $leviRoot apply --check --whitespace=nowarn $nativePatch
        if ($LASTEXITCODE -ne 0) {
            throw "The pinned LeviLauncher checkout does not match patches\levilauncher-native-xuid.patch."
        }
        & git -C $leviRoot apply --whitespace=nowarn $nativePatch
        if ($LASTEXITCODE -ne 0) {
            throw "Could not apply the SLH Xbox XUID/Store market patch to the pinned LeviLauncher helper."
        }
        $patchApplied = $true
    }
    $env:GOOS = 'windows'
    $env:GOARCH = $goArch
    $env:CGO_ENABLED = '0'
    Push-Location $leviRoot
    try {
        & $goCommand.Source build -trimpath -o $outputPath '.\cmd\msixvc-native'
        if ($LASTEXITCODE -ne 0) {
            throw "Go failed to build the Bedrock native helper (exit code $LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
} finally {
    if ($patchApplied) {
        & git -C $leviRoot apply --reverse --whitespace=nowarn $nativePatch
        if ($LASTEXITCODE -ne 0) {
            throw "The temporary LeviLauncher patch could not be reverted. Restore vendor\LeviLauncher to commit 69bde2e before continuing."
        }
    }
    $env:GOOS = $oldGoos
    $env:GOARCH = $oldGoarch
    $env:CGO_ENABLED = $oldCgo
}

if (-not (Test-Path -LiteralPath $outputPath)) {
    throw "Go reported success but did not create $outputPath."
}

Write-Host "Bedrock native helper built: $outputPath"
