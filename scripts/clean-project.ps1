param([switch]$Apply)

# Windows PowerShell 5.1 cannot reliably remove Minecraft's deeply nested
# library paths. Run the entire cleanup in PowerShell 7, including validation.
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $modernPowerShell = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    $modernPowerShellPath = if ($modernPowerShell) { $modernPowerShell.Source } else {
        Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'
    }
    if (-not (Test-Path -LiteralPath $modernPowerShellPath)) {
        throw 'PowerShell 7 is required for long Minecraft paths. Run this script from PowerShell 7.'
    }
    Write-Host 'Switching to PowerShell 7 for long-path support...'
    $cleanupArguments = @('-NoProfile', '-File', $PSCommandPath)
    if ($Apply) { $cleanupArguments += '-Apply' }
    & $modernPowerShellPath @cleanupArguments
    if ($LASTEXITCODE -ne 0) { throw "Cleanup failed with exit code $LASTEXITCODE" }
    return
}

# Preview by default. Pass -Apply to remove only the reviewed paths below.
# Keep dependencies, source models, releases, game data and performance evidence.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$relativePaths = @(
    'src-tauri/target'
    'crates/slh-core/target'
    'crates/slh-native/target'
    'dist'
    'test-results'
    'node_modules/.vite'
    'node_modules/.vite-temp'
    'artifacts/onboarding-preview-20260815'
    'artifacts/onboarding-screenshots'
    'artifacts/cf-proxy-zip-verify-20260809'
    'artifacts/portable-build-test'
    'artifacts/portable-build-test-3c1448df50064707a5cb84cf94a7a6ea'
    'artifacts/webview2'
    'artifacts/Microsoft.WebView2.FixedVersionRuntime.151.0.4129.86.x64.cab'
    'artifacts/Microsoft.WebView2.FixedVersionRuntime.151.0.4129.86.x86.cab'
    'artifacts/nasm-3.02-win64.zip'
    'artifacts/build-win10-x86.stderr.log'
    'artifacts/build-win10-x86.stdout.log'
    'artifacts/browser-discover.png'
    'artifacts/browser-library-selected.png'
    'artifacts/browser-library.png'
    'artifacts/native-preview.png'
    'visual-discover.png'
    'visual-downloads.png'
    'visual-install-dialog.png'
    'visual-library.png'
    'visual-servers.png'
    'visual-storage.png'
    'public/vite.svg'
    'public/tauri.svg'
    'src/assets/react.svg'
    'src/assets/brand/SLH_fw.png'
    'src/assets/brand/SmileLauncHer.png'
)

# Validate every target before deleting anything. Refuse links anywhere along
# the path or inside a directory so cleanup cannot escape the checkout.
$plan = @(foreach ($relativePath in $relativePaths) {
    $path = [IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
    if (-not $path.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup target is outside the project: $path"
    }
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $ancestor = $path
    while ($ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Cleanup target has a linked ancestor: $ancestor"
        }
        $ancestor = Split-Path -Parent $ancestor
    }
    $item = Get-Item -LiteralPath $path -Force
    $children = if ($item.PSIsContainer) {
        @(Get-ChildItem -LiteralPath $path -Recurse -Force)
    } else { @($item) }
    if ($children | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        throw "Cleanup target contains links: $path"
    }
    $measure = $children | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum
    [PSCustomObject]@{ RelativePath=$relativePath; Path=$path; Bytes=[long]$measure.Sum; Files=$measure.Count }
})

$plan | Select-Object RelativePath, @{Name='GiB';Expression={[math]::Round($_.Bytes / 1GB, 3)}}, Files | Format-Table -AutoSize
$bytes = ($plan | Measure-Object Bytes -Sum).Sum
Write-Host ('Selected: {0:N3} GiB. Protected: release/, game data, backups, vendor/, node_modules/ dependencies.' -f ($bytes / 1GB))
if (-not $Apply) {
    Write-Host 'Preview only. Run this script with -Apply to delete the listed files.'
    return
}

# Refuse removal while the project launcher or a compiler is running.
$busy = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(cargo|rustc)\.exe$' -or
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}
if ($busy) { throw 'Close the project launcher, development server and Rust builds before cleanup.' }

$auditPath = Join-Path ([IO.Path]::GetTempPath()) ('slh-cleanup-' + [guid]::NewGuid().ToString('N') + '.json')
$plan | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $auditPath -Encoding UTF8
Write-Host "Cleanup manifest: $auditPath"
foreach ($entry in $plan) {
    Remove-Item -LiteralPath $entry.Path -Recurse -Force
    if (Test-Path -LiteralPath $entry.Path) { throw "Cleanup failed: $($entry.Path)" }
    Write-Host "Removed: $($entry.RelativePath)"
}
Write-Host ('Removed {0:N3} GiB. The next Rust build will recreate its build cache.' -f ($bytes / 1GB))
