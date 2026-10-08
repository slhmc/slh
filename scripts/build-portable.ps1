param(
    [switch]$SkipBuild,
    [switch]$CleanData,
    [ValidateSet('x64', 'x86')]
    [string]$Architecture = 'x64',
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$outputRoot = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    Join-Path $projectRoot 'release\SLH-Portable'
} else {
    [System.IO.Path]::GetFullPath($OutputDirectory)
}
$targetTriple = if ($Architecture -eq 'x86') { 'i686-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
$binaryPath = if ($Architecture -eq 'x86') {
    Join-Path $projectRoot "src-tauri\target\$targetTriple\release\slh.exe"
} else {
    Join-Path $projectRoot 'src-tauri\target\release\slh.exe'
}

if (-not $SkipBuild) {
    Push-Location $projectRoot
    try {
        if ($Architecture -eq 'x86') {
            powershell -ExecutionPolicy Bypass -File scripts/build-bedrock-native.ps1 -Architecture x86
            if ($LASTEXITCODE -ne 0) { throw "Bedrock helper build failed with exit code $LASTEXITCODE" }
            npx tauri build --target $targetTriple --no-bundle
            if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
        } else {
            npm run tauri:build
            if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
        }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $binaryPath)) {
    throw "Expected release executable was not produced: $binaryPath"
}
$buildProbe = Start-Process -FilePath $binaryPath -ArgumentList '--check-build-mode' -WindowStyle Hidden -Wait -PassThru
if ($buildProbe.ExitCode -ne 0) { throw 'The executable does not embed the frontend. Build it with npx tauri build --no-bundle before packaging.' }
$resolvedOutput = [IO.Path]::GetFullPath($outputRoot).TrimEnd('\')
if ($resolvedOutput -eq [IO.Path]::GetPathRoot($resolvedOutput).TrimEnd('\')) {
    throw 'A drive root cannot be a portable output directory.'
}
if ($resolvedOutput -eq [IO.Path]::GetFullPath($projectRoot).TrimEnd('\')) {
    throw 'The source repository cannot be a portable output directory.'
}
if ((Test-Path -LiteralPath $resolvedOutput) -and ((Get-Item -LiteralPath $resolvedOutput).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The portable output directory must not be a link.'
}
$live = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($resolvedOutput + '\', [StringComparison]::OrdinalIgnoreCase)
}
if ($live) { throw 'SLH or its runtime is running from the output directory. Close SLH completely before updating it.' }

if (-not (Test-Path -LiteralPath $outputRoot)) {
    New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
}

function Remove-PortableChild([string]$name) {
    $child = [IO.Path]::GetFullPath((Join-Path $resolvedOutput $name))
    if ((Split-Path -Parent $child) -ne $resolvedOutput) { throw "Unsafe portable child: $child" }
    if (Test-Path -LiteralPath $child) {
        if ((Get-Item -LiteralPath $child).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing to remove linked portable directory: $child" }
        if (Get-ChildItem -LiteralPath $child -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop) { throw "Refusing to remove portable directory containing links: $child" }
        Remove-Item -LiteralPath $child -Recurse -Force
    }
}
$resourcesOutput = Join-Path $outputRoot 'resources'
Remove-PortableChild 'resources'
# Same loader as the launcher; the probe never opens a window.
$probe = Start-Process -FilePath $binaryPath -ArgumentList '--check-webview-runtime' -WindowStyle Hidden -Wait -PassThru
$runtimeReady = $probe.ExitCode -eq 0
if ($runtimeReady) {
    Remove-PortableChild 'webview2'
    Remove-PortableChild 'webview2.cab'
} elseif (Test-Path -LiteralPath (Join-Path $outputRoot 'webview2')) {
    Write-Warning 'Evergreen WebView2 is missing. The legacy folder was retained; install Evergreen before cleaning it up.'
}
Remove-PortableChild 'SLH.zip'

Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $outputRoot 'SLH.exe') -Force
Set-Content -LiteralPath (Join-Path $outputRoot 'portable.flag') -Value 'SLH portable data stays beside this executable.'
$nativeHelperPath = Join-Path $projectRoot "src-tauri\binaries\slh-bedrock-native-$targetTriple.exe"
if (-not (Test-Path -LiteralPath $nativeHelperPath)) {
    throw "Expected Bedrock native helper was not produced: $nativeHelperPath"
}
Copy-Item -LiteralPath $nativeHelperPath -Destination (Join-Path $outputRoot 'slh-bedrock-native.exe') -Force
# Only language packs are external, editable portable resources. Brand-source
# contains authoring files and must never be included in a release folder.
New-Item -ItemType Directory -Force -Path $resourcesOutput | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'resources\languages') -Destination (Join-Path $resourcesOutput 'languages') -Recurse
$licensesOutput = Join-Path $outputRoot 'licenses'
New-Item -ItemType Directory -Force -Path $licensesOutput | Out-Null
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'resources\licenses') -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licensesOutput $_.Name) -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $licensesOutput 'THIRD_PARTY_NOTICES.md') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination (Join-Path $licensesOutput 'GPL-3.0.txt') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'src\assets\fonts\OFL.txt') -Destination (Join-Path $licensesOutput 'Pixeloid-OFL.txt') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules\pixelarticons\LICENSE') -Destination (Join-Path $licensesOutput 'Pixelarticons-MIT.txt') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $outputRoot 'README.txt') -Force

if ($CleanData) {
    # Intended for distributable releases only. A personal portable launcher
    # should retain data; a GitHub package must never retain test accounts.
    $dataOutput = Join-Path $outputRoot 'data'
    if (Test-Path -LiteralPath $dataOutput) {
        Remove-PortableChild 'data'
    }
}

# Keep the user extension point visible in every fresh portable release.
New-Item -ItemType Directory -Force -Path (Join-Path $outputRoot 'data\languages') | Out-Null

Write-Host "Portable build created at $outputRoot"
