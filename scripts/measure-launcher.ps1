param(
    [Parameter(Mandatory)][int]$LauncherId,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateRange(0, 3600)][int]$WarmupSeconds = 60,
    [ValidateRange(1, 3600)][int]$DurationSeconds = 180,
    [string]$Scenario = 'unspecified',
    [switch]$IncludeGpu
)
$ErrorActionPreference = 'Stop'
$measurementLauncher = Get-Process -Id $LauncherId -ErrorAction SilentlyContinue
if (-not $measurementLauncher) { throw 'Launcher is not running; no measurement was taken.' }
$measurementStartTime = $measurementLauncher.StartTime
$measurementMetadata = [ordered]@{
    Scenario = $Scenario
    LauncherPath = $measurementLauncher.Path
    LauncherSha256 = (Get-FileHash -LiteralPath $measurementLauncher.Path -Algorithm SHA256).Hash
    LogicalProcessors = [Environment]::ProcessorCount
    WarmupSeconds = $WarmupSeconds
    RequestedDurationSeconds = $DurationSeconds
    IncludeGpu = [bool]$IncludeGpu
}
function Assert-LauncherRunning {
    $current = Get-Process -Id $LauncherId -ErrorAction SilentlyContinue
    if (-not $current -or $current.StartTime -ne $measurementStartTime) { throw 'Launcher exited during measurement; discard this run.' }
}
function Get-LauncherIds {
    Assert-LauncherRunning
    $all = Get-CimInstance Win32_Process
    $ids = @($LauncherId)
    do {
        $children = @($all | Where-Object {
            $_.Name -eq 'msedgewebview2.exe' -and $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids
        })
        $ids += @($children.ProcessId)
    } while ($children.Count -gt 0)
    return $ids
}
Start-Sleep -Seconds $WarmupSeconds
$ids = @(Get-LauncherIds)
$previous = @{}
Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { $previous[$_.Id] = $_.CPU }
$clock = [Diagnostics.Stopwatch]::StartNew()
$measurementMetadata.StartedUtc = [DateTime]::UtcNow.ToString('o')
$last = 0.0
$discovered = 0.0
$rows = @()
$gpuAt = -10.0
$gpu = @{}
while ($clock.Elapsed.TotalSeconds -lt $DurationSeconds) {
    Start-Sleep -Seconds 3
    Assert-LauncherRunning
    if ($clock.Elapsed.TotalSeconds - $discovered -ge 10) {
        $ids = @(Get-LauncherIds)
        $discovered = $clock.Elapsed.TotalSeconds
    }
    $processes = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
    $now = $clock.Elapsed.TotalSeconds
    $delta = $now - $last
    if ($IncludeGpu -and $now - $gpuAt -ge 5) {
        $gpu = @{}
        try {
            $counters = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)
            foreach ($group in @('launcher', 'webview')) {
                $pids = @($processes | Where-Object { ($_.Id -eq $LauncherId) -eq ($group -eq 'launcher') } | Select-Object -ExpandProperty Id)
                $selected = @($counters | Where-Object { $_.Name -match '^pid_(\d+)_' -and [int]$Matches[1] -in $pids })
                if ($selected.Count -gt 0) {
                    $gpu[$group] = ($selected | Group-Object { $_.Name -replace '^pid_\d+_', '' } | ForEach-Object { ($_.Group | Measure-Object UtilizationPercentage -Sum).Sum } | Measure-Object -Maximum).Maximum
                }
            }
        } catch { }
        $gpuAt = $now
    }
    foreach ($group in @('launcher', 'webview')) {
        $members = @($processes | Where-Object { ($_.Id -eq $LauncherId) -eq ($group -eq 'launcher') })
        $cpu = ($members | ForEach-Object { if ($previous.ContainsKey($_.Id)) { [Math]::Max(0.0, [double]($_.CPU - $previous[$_.Id])) } } | Measure-Object -Sum).Sum
        $rows += [pscustomobject]@{
            Seconds = [Math]::Round($now, 2); Group = $group
            IntervalSeconds = $delta
            GpuPercent = if ($gpu.ContainsKey($group)) { $gpu[$group] } else { $null }
            CpuPercent = 100 * $cpu / $delta / [Environment]::ProcessorCount
            WorkingSetMiB = ($members | Measure-Object WorkingSet64 -Sum).Sum / 1MB
            PrivateBytesMiB = ($members | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
            ProcessCount = $members.Count
        }
    }
    $previous = @{}
    $processes | ForEach-Object { $previous[$_.Id] = $_.CPU }
    $last = $now
}
$parent = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
[IO.Directory]::CreateDirectory($parent) | Out-Null
$rows | ConvertTo-Json | Set-Content -LiteralPath $OutputPath -Encoding UTF8
$measurementMetadata.CompletedUtc = [DateTime]::UtcNow.ToString('o')
$measurementMetadata.ActualDurationSeconds = $clock.Elapsed.TotalSeconds
$measurementMetadata.WebviewRuntimeVersions = @($processes | Where-Object Id -ne $LauncherId | ForEach-Object {
    try { $_.FileVersionInfo.FileVersion } catch { } # A child may exit just after the last sample.
} | Sort-Object -Unique)
$measurementMetadata | ConvertTo-Json | Set-Content -LiteralPath ($OutputPath + '.metadata.json') -Encoding UTF8
foreach ($group in @('launcher', 'webview')) {
    $members = @($rows | Where-Object Group -eq $group)
    [pscustomobject]@{
        Group = $group; Samples = $members.Count
        CpuPercent = [Math]::Round(($members | Measure-Object CpuPercent -Average).Average, 3)
        WorkingSetMiB = [Math]::Round(($members | Measure-Object WorkingSetMiB -Average).Average, 1)
        PrivateBytesMiB = [Math]::Round(($members | Measure-Object PrivateBytesMiB -Average).Average, 1)
    } | ConvertTo-Json -Compress
}
