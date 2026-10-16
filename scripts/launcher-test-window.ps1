param(
    [Parameter(Mandatory)][int]$LauncherId,
    [Parameter(Mandatory)][ValidateSet('size','minimize','restore','inspect')][string]$Action,
    [ValidateRange(800,16384)][int]$Width = 1440,
    [ValidateRange(560,16384)][int]$Height = 900
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SlhTestWindow {
    public delegate bool EnumWindowCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, System.Text.StringBuilder text, int count);
    public static IntPtr LauncherWindow(int process) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, parameter) => {
            uint owner; GetWindowThreadProcessId(handle, out owner);
            if (owner != process) return true;
            var title = new System.Text.StringBuilder(256); GetWindowText(handle, title, title.Capacity);
            if (title.ToString() != "SLH - Smile LauncHer") return true;
            found = handle; return false;
        }, IntPtr.Zero);
        return found;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rectangle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
}
'@
[SlhTestWindow]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$launcher = Get-Process -Id $LauncherId -ErrorAction Stop
if ($launcher.ProcessName -ne 'SLH' -or $launcher.Path -notlike '*\artifacts\memory-optimization-*\*') {
    throw 'Window testing is restricted to this task''s isolated SLH executable.'
}
$handle = [SlhTestWindow]::LauncherWindow($LauncherId)
if ($handle -eq [IntPtr]::Zero) { throw 'Native launcher window is not ready.' }
switch ($Action) {
    'size' {
        [SlhTestWindow]::ShowWindow($handle, 9) | Out-Null
        if (-not [SlhTestWindow]::SetWindowPos($handle, [IntPtr]::Zero, 80, 40, $Width, $Height, 0x0004)) { throw 'Could not set the test window size.' }
        [SlhTestWindow]::SetForegroundWindow($handle) | Out-Null
    }
    'minimize' { [SlhTestWindow]::ShowWindow($handle, 6) | Out-Null }
    'restore' { [SlhTestWindow]::ShowWindow($handle, 9) | Out-Null; [SlhTestWindow]::SetForegroundWindow($handle) | Out-Null }
}
$rect = New-Object SlhTestWindow+Rect
[SlhTestWindow]::GetWindowRect($handle, [ref]$rect) | Out-Null
[ordered]@{ Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top; Title = $launcher.MainWindowTitle; Minimized = [SlhTestWindow]::IsIconic($handle); Foreground = [SlhTestWindow]::GetForegroundWindow() -eq $handle } | ConvertTo-Json -Compress
