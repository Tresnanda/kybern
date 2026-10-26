# Installs the built Kybern GPUIX installer silently on this machine and checks what
# it promises, then uninstalls it. CI runs it on windows-2022 before the installer is
# uploaded (desktop.yml, job `gpuix-windows`); it also works on a
# Windows PC. It changes the current user's profile (install folder, shortcuts, user
# Path, HKCU keys) and removes all of it again, so do not run it on a machine whose
# Kybern GPUIX you use.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-install.ps1 -Installer <path>
#   ... -Launch    also start the installed app against a scratch data folder
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [switch]$Launch
)
$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path -LiteralPath $Installer).Path

$name = 'Kybern GPUIX'
$aumid = 'dev.kybern.gpuix'
$dir = Join-Path $env:LOCALAPPDATA "Programs\$name"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$name"
$bin = Join-Path $dir 'bin'
$aumidKey = "HKCU:\Software\Classes\AppUserModelId\$aumid"
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$name.lnk"
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"

function Check([bool]$ok, [string]$what) {
  if (-not $ok) { throw "FAILED: $what" }
  Write-Host "ok: $what"
}
function UserPathEntries { @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | ForEach-Object { $_.TrimEnd('\') }) }
function UserPathHasBin { return (UserPathEntries) -contains $bin }
function UserPathHasDir { return (UserPathEntries) -contains $dir }
function RunSilently([string]$file, [string[]]$arguments) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -Wait -PassThru
  Check ($process.ExitCode -eq 0) "$([IO.Path]::GetFileName($file)) $($arguments -join ' ') exited 0"
}
function WaitUntil([scriptblock]$condition, [int]$seconds, [string]$what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $condition)) {
    if ((Get-Date) -gt $deadline) { throw "FAILED: timed out waiting for $what" }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "ok: $what"
}
function Uninstall {
  RunSilently (Join-Path $dir 'uninstall.exe') @('/S')
  # The uninstaller copies itself to %TEMP% and returns at once; wait for it to finish.
  WaitUntil { -not (Test-Path -LiteralPath $uninstallKey) } 60 'the uninstaller to finish'
}
function InstalledProcesses([string]$name) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir + '\', [StringComparison]::OrdinalIgnoreCase) -and (-not $name -or $_.ProcessName -eq $name) })
}
# A daemon started from the install folder, against a scratch data folder.
function StartDaemon([string]$data) {
  New-Item -ItemType Directory -Path $data -Force | Out-Null
  $process = Start-Process -FilePath (Join-Path $dir 'kybernd.exe') -ArgumentList @('--data-dir', "`"$data`"", '--port', '0') -PassThru -WindowStyle Hidden
  WaitUntil { (Test-Path -LiteralPath (Join-Path $data 'daemon.port')) -or $process.HasExited } 60 'the installed kybernd.exe to start'
  Check (-not $process.HasExited) 'the installed kybernd.exe is running'
  return $process
}
function StopInstalledProcesses {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
}

Check (-not (Test-Path -LiteralPath $uninstallKey)) 'no earlier Kybern GPUIX install on this machine'
$pathBefore = [Environment]::GetEnvironmentVariable('Path', 'User')

try {
  RunSilently $Installer @('/S')

  foreach ($file in 'Kybern GPUIX.exe', 'kybernd.exe', 'bin\kybern.exe', 'gpuix-native.win32-x64-msvc.node', 'version', 'icon.ico', 'uninstall.exe', 'tools\path.ps1', 'tools\shortcut.ps1', 'tools\stop.ps1', 'vcruntime140.dll', 'bin\vcruntime140.dll') {
    Check (Test-Path -LiteralPath (Join-Path $dir $file)) "installed $file"
  }
  Check ((Get-ChildItem -LiteralPath (Join-Path $dir 'src\assets\fonts') -File).Count -gt 0) 'installed the bundled fonts'

  $version = (Get-Content -LiteralPath (Join-Path $dir 'version') -Raw).Trim()
  $entry = Get-ItemProperty -LiteralPath $uninstallKey
  Check ($entry.DisplayName -eq $name) 'Add/Remove Programs name'
  Check ($entry.DisplayVersion -eq $version) "Add/Remove Programs version is $version"
  Check ($entry.InstallLocation -eq $dir) 'Add/Remove Programs install location'
  Check ($entry.QuietUninstallString -like '*uninstall.exe" /S') 'quiet uninstall command'
  Check ((Get-ItemProperty -LiteralPath $aumidKey).DisplayName -eq $name) 'AppUserModelId registration'

  Check (Test-Path -LiteralPath $startMenu) 'Start menu shortcut'
  $id = (& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'tools\shortcut.ps1') -Path $startMenu -Read | Out-String).Trim()
  Check ($id -eq $aumid) "Start menu shortcut carries AppUserModelID $aumid (read back: '$id')"
  Check (-not (Test-Path -LiteralPath $desktop)) 'no desktop shortcut by default'
  Check (UserPathHasBin) 'the bin folder was added to the user Path'
  Check (-not (UserPathHasDir)) 'the install folder itself (uninstall.exe, kybernd.exe, the runtime DLLs) is not on the user Path'
  Check (-not (Test-Path -LiteralPath (Join-Path $dir 'kybern.exe'))) 'kybern.exe lives only in bin'
  Check ((Get-ChildItem -LiteralPath $bin -File | ForEach-Object Name) -contains 'kybern.exe') 'bin holds kybern.exe'

  $cli = (& (Join-Path $bin 'kybern.exe') --version | Out-String).Trim()
  Check ($cli -like 'kybern *') "kybern.exe runs from bin ($cli)"

  # The installed app must load its native addon (with every DLL it needs) and import its whole module
  # graph and resources. This is the blocking check; -Launch below only watches a real start.
  $smokeData = Join-Path ([IO.Path]::GetTempPath()) "kybern-gpuix-smoke-$PID"
  $smokeOut = "$smokeData.txt"
  New-Item -ItemType Directory -Path $smokeData | Out-Null
  $env:KYBERN_DATA_DIR = $smokeData; $env:KYBERN_GPUIX_SMOKE = '1'; $env:KYBERN_GPUIX_SMOKE_OUT = $smokeOut
  try {
    $smoke = Start-Process -FilePath (Join-Path $dir 'Kybern GPUIX.exe') -PassThru
    $null = $smoke.Handle
    if (-not $smoke.WaitForExit(120000)) { $smoke.Kill(); throw 'FAILED: the installed app did not finish its smoke run in 120 s' }
    $detail = if (Test-Path -LiteralPath $smokeOut) { Get-Content -LiteralPath $smokeOut -Raw } else { '(no output)' }
    Check ($smoke.ExitCode -eq 0) "the installed app loads its native addon and modules (smoke run exit $($smoke.ExitCode): $detail)"
  } finally {
    Remove-Item Env:\KYBERN_DATA_DIR, Env:\KYBERN_GPUIX_SMOKE, Env:\KYBERN_GPUIX_SMOKE_OUT -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $smokeData -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $smokeOut -Force -ErrorAction SilentlyContinue
  }

  if ($Launch) {
    $data = Join-Path ([IO.Path]::GetTempPath()) "kybern-gpuix-launch-$PID"
    New-Item -ItemType Directory -Path $data | Out-Null
    $env:KYBERN_DATA_DIR = $data
    try {
      $app = Start-Process -FilePath (Join-Path $dir 'Kybern GPUIX.exe') -PassThru
      try {
        WaitUntil { (Test-Path -LiteralPath (Join-Path $data 'daemon.port')) -or $app.HasExited } 90 'the packaged app to start its bundled daemon'
        Check (-not $app.HasExited) 'the packaged app is still running after startup'
        Check (Test-Path -LiteralPath (Join-Path $data 'daemon.port')) 'the bundled kybernd wrote daemon.port'
      } finally {
        if (Test-Path -LiteralPath (Join-Path $data 'daemon.log')) { Get-Content -LiteralPath (Join-Path $data 'daemon.log') -Tail 20 }
      }
    } finally {
      Remove-Item Env:\KYBERN_DATA_DIR -ErrorAction SilentlyContinue
      StopInstalledProcesses
      Start-Sleep -Seconds 2
      Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  # An update with the daemon running from the install folder: the installer replaces the files around it.
  # A running exe cannot be deleted but can be renamed, so kybernd.exe moves aside to kybernd.exe.old and the
  # daemon is not killed (the next app launch restarts it when its version differs).
  $daemonData = Join-Path ([IO.Path]::GetTempPath()) "kybern-gpuix-daemon-$PID"
  $daemon = StartDaemon $daemonData
  Remove-Item -LiteralPath (Join-Path $dir 'version')
  Remove-Item -LiteralPath (Join-Path $bin 'kybern.exe')
  RunSilently $Installer @('/S')
  Check (Test-Path -LiteralPath (Join-Path $dir 'version')) 'a silent reinstall restores replaced files'
  Check (Test-Path -LiteralPath (Join-Path $bin 'kybern.exe')) 'a silent reinstall restores bin\kybern.exe'
  Check (Test-Path -LiteralPath (Join-Path $dir 'kybernd.exe')) 'the update wrote a new kybernd.exe beside the running one'
  Check (Test-Path -LiteralPath (Join-Path $dir 'kybernd.exe.old')) 'the running kybernd.exe was moved aside, not overwritten'
  Check (-not $daemon.HasExited) 'the update did not kill the running daemon'
  Check (@(UserPathEntries | Where-Object { $_ -eq $bin }).Count -eq 1) 'the Path entry is not duplicated'
  Check (-not (UserPathHasDir)) 'the install folder is still not on the user Path'
  Check (-not (Test-Path -LiteralPath $desktop)) 'the desktop shortcut choice is kept'

  # Uninstalling while that daemon still runs must leave nothing behind: it stops the daemon (through
  # kybern.exe stop-daemon, then by ending what is left in the folder) before deleting.
  Check (@(InstalledProcesses 'kybernd').Count -ge 1) 'a daemon is running from the install folder before the uninstall'
  $env:KYBERN_DATA_DIR = $daemonData
  try { Uninstall } finally { Remove-Item Env:\KYBERN_DATA_DIR -ErrorAction SilentlyContinue }
  try { WaitUntil { -not (Test-Path -LiteralPath $dir) } 60 'the uninstaller to remove the install folder' }
  catch {
    # Say what kept the folder: files the uninstaller does not list, or a process still holding one.
    Write-Host "left in ${dir}:"; Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $($_.FullName)" }
    Write-Host 'still running from it:'; InstalledProcesses $null | ForEach-Object { Write-Host "  $($_.Id) $($_.Path)" }
    Write-Host "the update's daemon: exited $($daemon.HasExited)"
    throw
  }
  Check ($daemon.HasExited) 'the uninstaller stopped the running daemon'
} finally {
  StopInstalledProcesses
  if ($daemon -and -not $daemon.HasExited) { try { $daemon.Kill() } catch { } }
  if ($daemonData) { Remove-Item -LiteralPath $daemonData -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $uninstallKey) { Uninstall }
}

Check (-not (Test-Path -LiteralPath $dir)) 'uninstall removed the install folder, with no kybernd.exe or .old files left'
Check (-not (Test-Path -LiteralPath $startMenu)) 'uninstall removed the Start menu shortcut'
Check (-not (Test-Path -LiteralPath $aumidKey)) 'uninstall removed the AppUserModelId registration'
Check (-not (Test-Path -LiteralPath 'HKCU:\Software\Kybern GPUIX')) 'uninstall removed the app key'
Check (-not (UserPathHasBin)) 'uninstall removed the Path entry'
# path.ps1 drops empty entries, so compare without them.
function Entries([string]$path) { ($path -split ';' | Where-Object { $_.Trim() -ne '' }) -join ';' }
Check ((Entries ([Environment]::GetEnvironmentVariable('Path', 'User'))) -eq (Entries $pathBefore)) 'the user Path is as before'
Write-Host 'All installer checks passed.'
