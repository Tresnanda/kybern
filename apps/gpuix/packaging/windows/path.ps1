# Add a folder to, or remove it from, the current user's Path (HKCU\Environment).
# Run by the NSIS installer and uninstaller. Edits the registry value directly so
# entries like %USERPROFILE%\bin stay unexpanded (SetEnvironmentVariable would
# rewrite the value as plain text), and appends at the end so a `kybern` that is
# already on Path (the Tauri app's, cargo's) keeps winning. The installer
# broadcasts WM_SETTINGCHANGE afterwards; new terminals pick the change up.
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir
)
$ErrorActionPreference = 'Stop'

function Normalize([string]$entry) { $entry.Trim().TrimEnd('\').ToLowerInvariant() }

$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($raw -split ';' | Where-Object { $_.Trim() -ne '' })
  $wanted = Normalize $Dir
  $present = @($entries | Where-Object { (Normalize $_) -eq $wanted }).Count -gt 0
  if ($Action -eq 'add' -and -not $present) {
    $entries += $Dir.TrimEnd('\')
  } elseif ($Action -eq 'remove' -and $present) {
    $entries = @($entries | Where-Object { (Normalize $_) -ne $wanted })
  } else {
    exit 0
  }
  $key.SetValue('Path', ($entries -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
} finally {
  $key.Close()
}
