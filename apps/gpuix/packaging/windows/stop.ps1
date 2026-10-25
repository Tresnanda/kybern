# Waits for, or stops, the Kybern GPUIX processes that run from one install folder.
# Run by the NSIS installer and uninstaller. Only processes whose image path is inside
# -Dir are touched: a Kybern GPUIX or kybernd.exe running from another folder (the Tauri
# desktop app's daemon, a development build) is never waited for, asked to stop or killed.
#
#   -Action wait-app   wait up to -Seconds for the app ("Kybern GPUIX.exe") to exit
#   -Action stop-all   ask the daemon to shut down through the bundled kybern.exe, wait, then end
#                      whatever is still running from -Dir (the uninstaller, so nothing locks the files)
#
# Exit code: 0 when nothing is left running from -Dir (wait-app: when the app is gone),
# 1 when something is, anything else on a script error. The installer treats only 1 as "still running".
param(
  [Parameter(Mandatory = $true)][ValidateSet('wait-app', 'stop-all')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$Seconds = 0
)
$ErrorActionPreference = 'Stop'

# "C:\" and "C:" both mean the drive root; anything else loses its trailing backslash first.
$root = $Dir.TrimEnd('\') + '\'

function Running([string]$name) {
  $found = @()
  foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
    if ($process.Id -eq $PID -or ($name -and $process.ProcessName -ne $name)) { continue }
    # A process of another user or a protected one has no readable path; it is not ours.
    try { $path = $process.Path } catch { continue }
    if ($path -and $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $found += $process }
  }
  return $found
}
function WaitUntilGone([string]$name, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Running $name).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  return (Running $name).Count -eq 0
}

if ($Action -eq 'wait-app') {
  if (WaitUntilGone 'Kybern GPUIX' $Seconds) { exit 0 } else { exit 1 }
}

# The daemon first, gracefully: its agents get to close. `kybern stop-daemon` talks to the daemon in the
# user's data folder (KYBERN_DATA_DIR, else ~/.kybern); one daemon runs per data folder, so when a kybernd
# runs from -Dir it is that one, and the command is sent only then.
if ((Running 'kybernd').Count -gt 0) {
  $cli = Join-Path $root 'bin\kybern.exe'
  if (Test-Path -LiteralPath $cli) {
    $arguments = @('stop-daemon')
    if ($env:KYBERN_DATA_DIR) { $arguments = @('--data-dir', $env:KYBERN_DATA_DIR) + $arguments }
    try { & $cli @arguments *> $null } catch { }
    [void](WaitUntilGone 'kybernd' ([Math]::Max($Seconds, 1)))
  }
}
# Whatever is left (the app, a daemon that did not stop in time, agent processes it started from here).
foreach ($process in Running $null) { try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { } }
if (WaitUntilGone $null 10) { exit 0 } else { exit 1 }
