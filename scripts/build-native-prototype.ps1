param([Parameter(Mandatory)][string]$DataRoot)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$nativeData = (Resolve-Path -LiteralPath $DataRoot).Path
if (!(Test-Path -LiteralPath (Join-Path $nativeData 'native-prototype.json'))) { throw 'Prepare a separate data copy first.' }
Push-Location $workspace
try {
    cargo build --release --locked --manifest-path crates/slh-native/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
    $destination = Join-Path $workspace 'artifacts/native-prototype'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $workspace 'crates/slh-native/target/release/slh-native.exe') -Destination (Join-Path $destination 'SLH-Native.exe') -Force
    [IO.File]::WriteAllText((Join-Path $destination 'prototype-data-root.txt'), $nativeData, [Text.UTF8Encoding]::new($false))
    Write-Output (Join-Path $destination 'SLH-Native.exe')
} finally { Pop-Location }
