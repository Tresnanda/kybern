; Kybern GPUIX for Windows x64: a per-user installer (no administrator prompt).
;
; Built by scripts/package-windows.ts, which passes the defines below and writes
; the two generated includes (one line per payload file):
;   APP_VERSION     0.15.1                       VERSION_QUAD  0.15.1.0
;   PAYLOAD_DIR     the staged app folder        GENERATED_DIR install-files.nsh, uninstall-files.nsh
;   OUT_FILE        kybern-gpuix_<v>_x64-setup.exe
;   WEBVIEW2_BOOTSTRAPPER  (optional) Microsoft's Evergreen WebView2 bootstrapper,
;                   MicrosoftEdgeWebview2Setup.exe, run only when the runtime is missing
; Layout and choices are documented in packaging/README.md ("Windows").
;
; Silent mode (`/S`) is the updater's path (src/platform/update.ts): it reuses the
; previous install folder (or takes `/D=<folder>`, the running copy's), keeps the
; optional choices, waits for the running app to exit, and with `/UPDATE` starts
; the new app when it is done. Only processes that run from the install folder are
; waited for or stopped (tools\stop.ps1); the daemon is left running on an update
; (its locked exe is moved aside) and stopped on uninstall.

; Unicode is what ships. Homebrew's makensis 3.13 on macOS aborts writing a Unicode installer,
; so a local compile check on a Mac passes -DANSI (package-windows.ts --nsis-ansi).
!ifdef ANSI
  Unicode false
!else
  Unicode true
!endif
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"

!insertmacro GetSize
!insertmacro GetParameters
!insertmacro GetOptions

!define APP_NAME "Kybern GPUIX"
!define APP_EXE "Kybern GPUIX.exe"
!define PUBLISHER "Kybern"
!define URL "https://github.com/Tresnanda/kybern"
; The id toasts and the taskbar group the app under. The Tauri app is dev.kybern.desktop.
!define AUMID "dev.kybern.gpuix"
!define REG_APP "Software\Kybern GPUIX"
!define REG_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kybern GPUIX"
!define REG_AUMID "Software\Classes\AppUserModelId\${AUMID}"
; The 64-bit PowerShell (FindPowerShell): this installer is a 32-bit program, and the 32-bit PowerShell
; that $SYSDIR names cannot read a 64-bit process's image path, so tools\stop.ps1 would see no kybernd.exe
; or app running from the install folder, stop nothing, and leave the folder locked.
!define POWERSHELL "$PowerShell"
; The Microsoft Edge WebView2 Runtime's EdgeUpdate client key (Microsoft's documented install check).
!define WEBVIEW2_CLIENT "Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${REG_APP}" "InstallDir"
BrandingText "${APP_NAME} ${APP_VERSION}"

VIProductVersion "${VERSION_QUAD}"
VIAddVersionKey /LANG=1033 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=1033 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1033 "FileDescription" "${APP_NAME} installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Kybern"

!define MUI_ICON "${PAYLOAD_DIR}\icon.ico"
!define MUI_UNICON "${PAYLOAD_DIR}\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP_NAME}"

!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var UpdateMode
Var PowerShell

; Replace a file even while it is in use. Windows lets a running exe or loaded
; DLL be renamed but not deleted, so a locked file moves aside to `.old` (the
; next install or uninstall removes it). That is how a daemon that outlives the
; app is replaced without being killed.
!macro MoveAside NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}"
    Delete "$INSTDIR\${NAME}"
    ${If} ${FileExists} "$INSTDIR\${NAME}"
      Delete "$INSTDIR\${NAME}.old"
      Rename "$INSTDIR\${NAME}" "$INSTDIR\${NAME}.old"
    ${EndIf}
  ${EndIf}
!macroend

; Fail the install (exit code 2, also with /S) when a file could not be written, instead of
; finishing with a half-replaced folder and reporting success.
!macro CheckWrite NAME
  ${If} ${Errors}
    DetailPrint "Could not write ${NAME}"
    Abort "Could not write $INSTDIR\${NAME}. Close Kybern GPUIX, then run the installer again."
  ${EndIf}
!macroend

!macro InstallFile NAME SOURCE
  !insertmacro MoveAside "${NAME}"
  SetOverwrite try
  ClearErrors
  File "/oname=${NAME}" "${SOURCE}"
  !insertmacro CheckWrite "${NAME}"
!macroend

; MoveAside for every file directly in $INSTDIR\DIR (`bin` holds the command a terminal may be running).
!macro MoveAsideFiles DIR
  FindFirst $R6 $R7 "$INSTDIR\${DIR}\*.*"
  ${DoWhile} $R7 != ""
    ${IfNot} ${FileExists} "$INSTDIR\${DIR}\$R7\*.*"
      !insertmacro MoveAside "${DIR}\$R7"
    ${EndIf}
    FindNext $R6 $R7
  ${Loop}
  FindClose $R6
!macroend

; Wait for the app to exit: silently for up to 30 s (the updater quits right
; after starting this installer), interactively until the user closes it. Only
; copies running from the install folder count (tools\stop.ps1 exits 1 while one
; runs); any other result, a blocked PowerShell included, lets the install go on.
!macro DefineFindPowerShell PREFIX
Function ${PREFIX}FindPowerShell
  ; Sysnative reaches the real System32 from a 32-bit process on 64-bit Windows.
  StrCpy $PowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} $PowerShell
    StrCpy $PowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
FunctionEnd
!macroend
!insertmacro DefineFindPowerShell ""
!insertmacro DefineFindPowerShell "un."

!macro DefineCheckAppClosed PREFIX SCRIPT
Function ${PREFIX}CheckAppClosed
  loop:
    Call ${PREFIX}InstDirNoSlash
    ${If} ${Silent}
      StrCpy $R0 30
    ${Else}
      StrCpy $R0 0
    ${EndIf}
    nsExec::Exec '"${POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SCRIPT}" -Action wait-app -Dir "$R9" -Seconds $R0'
    Pop $R1
    ${If} $R1 S!= "1"
      Return
    ${EndIf}
    ${If} ${Silent}
      Return
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${APP_NAME} is running. Close it, then choose Retry." IDRETRY loop
    Abort
FunctionEnd
!macroend

; $R9 = $INSTDIR without its trailing backslash (a drive root "C:\" gives "C:"): a quoted "C:\" would
; end in \" and swallow the closing quote of the argument.
!macro DefineInstDirNoSlash PREFIX
Function ${PREFIX}InstDirNoSlash
  StrCpy $R9 "$INSTDIR"
  StrCpy $R5 $R9 1 -1
  ${If} $R5 == "\"
    StrCpy $R9 $R9 -1
  ${EndIf}
FunctionEnd
!macroend
!insertmacro DefineInstDirNoSlash ""
!insertmacro DefineInstDirNoSlash "un."
!insertmacro DefineCheckAppClosed "" "$PLUGINSDIR\stop.ps1"
!insertmacro DefineCheckAppClosed "un." "$INSTDIR\tools\stop.ps1"

; Run one of the helper scripts in $INSTDIR\tools. $0 = script, $1 = arguments; the exit code is left in $2.
Function RunTool
  nsExec::ExecToLog '"${POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\tools\$0" $1'
  Pop $2
FunctionEnd
Function un.RunTool
  nsExec::ExecToLog '"${POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\tools\$0" $1'
  Pop $2
FunctionEnd

; $R8 = the .lnk to write. Carries the AppUserModelID; a plain shortcut if that fails.
Function CreateAppShortcut
  Call InstDirNoSlash
  ; "C:" alone would mean the current folder on C:; "C:\." is the root without a trailing backslash.
  StrCpy $R5 $R9 1 -1
  ${If} $R5 == ":"
    StrCpy $R9 "$R9\."
  ${EndIf}
  StrCpy $0 "shortcut.ps1"
  StrCpy $1 '-Path "$R8" -Target "$INSTDIR\${APP_EXE}" -WorkingDirectory "$R9" -Icon "$INSTDIR\icon.ico" -AppId "${AUMID}" -Description "${APP_NAME}"'
  Call RunTool
  ${If} $2 S!= "0"
    DetailPrint "The AppUserModelID could not be set ($2); creating a plain shortcut."
    CreateShortCut "$R8" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico" 0
  ${EndIf}
FunctionEnd

; The embedded web view (previews, interactive visuals, artifacts; native/webview-win) needs the Microsoft Edge
; WebView2 Runtime. Windows 11 and most Windows 10 machines have it; otherwise Microsoft's Evergreen bootstrapper
; (pinned by SHA-256, packaging/windows/webview2.ts) installs it, per-user (this installer is not elevated, so no UAC
; prompt) and silently. It downloads the runtime, so it needs the internet. It gets at most 5 minutes, 2 in a silent
; install (an update, /S); a silent install that fails or times out records it, and later silent updates skip the
; bootstrapper rather than wait on it again (an interactive install always tries, and a success clears the record).
; A failure never fails the install: the app opens pages in the browser and says how to get the runtime. The runtime
; is Microsoft's and updates itself; uninstall leaves it.
!ifdef WEBVIEW2_BOOTSTRAPPER
!define WEBVIEW2_FAILED "WebView2BootstrapperFailed"
Function InstallWebView2
  ; NSIS reads the 32-bit view, which is HKLM\SOFTWARE\WOW6432Node on 64-bit Windows: the per-machine key.
  ReadRegStr $0 HKLM "SOFTWARE\${WEBVIEW2_CLIENT}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "Software\${WEBVIEW2_CLIENT}" "pv"
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    DetailPrint "Microsoft Edge WebView2 Runtime $0 is installed."
    DeleteRegValue HKCU "${REG_APP}" "${WEBVIEW2_FAILED}"
    Return
  ${EndIf}
  ${If} ${Silent}
    ReadRegStr $1 HKCU "${REG_APP}" "${WEBVIEW2_FAILED}"
    ${If} $1 != ""
      DetailPrint "Skipping the WebView2 Runtime install, which did not work before ($1)."
      Return
    ${EndIf}
  ${EndIf}
  DetailPrint "Installing the Microsoft Edge WebView2 Runtime..."
  File "/oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2_BOOTSTRAPPER}"
  ; nsExec ends the bootstrapper after the timeout and returns "timeout" (or "error", or the exit code).
  ${If} ${Silent}
    nsExec::Exec /TIMEOUT=120000 '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'
  ${Else}
    nsExec::Exec /TIMEOUT=300000 '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'
  ${EndIf}
  Pop $1
  ${If} $1 == "0"
    DeleteRegValue HKCU "${REG_APP}" "${WEBVIEW2_FAILED}"
    DetailPrint "The WebView2 Runtime is installed."
  ${Else}
    WriteRegStr HKCU "${REG_APP}" "${WEBVIEW2_FAILED}" "${APP_VERSION}: $1"
    DetailPrint "The WebView2 Runtime was not installed ($1). ${APP_NAME} opens pages in your browser until it is."
  ${EndIf}
FunctionEnd
!endif

Function BroadcastEnvironment
  System::Call 'user32::SendMessageTimeoutW(p 0xffff, i ${WM_SETTINGCHANGE}, p 0, w "Environment", i 2, i 5000, *p .r0)'
FunctionEnd
Function un.BroadcastEnvironment
  System::Call 'user32::SendMessageTimeoutW(p 0xffff, i ${WM_SETTINGCHANGE}, p 0, w "Environment", i 2, i 5000, *p .r0)'
FunctionEnd

Section "${APP_NAME}" SecApp
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  Delete "$INSTDIR\*.old"
  Delete "$INSTDIR\bin\*.old"
  !insertmacro MoveAsideFiles "bin"

  !include "${GENERATED_DIR}\install-files.nsh"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${REG_APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REG_APP}" "Version" "${APP_VERSION}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${REG_UNINSTALL}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REG_UNINSTALL}" "URLInfoAbout" "${URL}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${REG_UNINSTALL}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${REG_UNINSTALL}" "NoModify" 1
  WriteRegDWORD HKCU "${REG_UNINSTALL}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${REG_UNINSTALL}" "EstimatedSize" $0

  ; Toasts for an unpackaged app resolve their name and icon from here.
  WriteRegStr HKCU "${REG_AUMID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${REG_AUMID}" "IconUri" "$INSTDIR\icon.ico"

  StrCpy $R8 "$SMPROGRAMS\${APP_NAME}.lnk"
  Call CreateAppShortcut
  Call ApplyOptions
!ifdef WEBVIEW2_BOOTSTRAPPER
  Call InstallWebView2
!endif
SectionEnd

; Checkboxes only: ApplyOptions acts on them.
Section /o "Desktop shortcut" SecDesktop
SectionEnd

Section "Add the kybern command to PATH" SecPath
SectionEnd

; The optional parts, applied after the install so that unticking one on a later install removes it.
Function ApplyOptions
  ${If} ${SectionIsSelected} ${SecDesktop}
    StrCpy $R8 "$DESKTOP\${APP_NAME}.lnk"
    Call CreateAppShortcut
    WriteRegStr HKCU "${REG_APP}" "DesktopShortcut" "1"
  ${Else}
    Delete "$DESKTOP\${APP_NAME}.lnk"
    WriteRegStr HKCU "${REG_APP}" "DesktopShortcut" "0"
  ${EndIf}

  ; Only `bin` (kybern.exe) goes on the user's Path, never the folder with uninstall.exe, kybernd.exe and the runtime DLLs.
  Call InstDirNoSlash
  StrCpy $0 "path.ps1"
  ${If} ${SectionIsSelected} ${SecPath}
    StrCpy $1 '-Action add -Dir "$R9\bin"'
    WriteRegStr HKCU "${REG_APP}" "PathCommand" "1"
  ${Else}
    StrCpy $1 '-Action remove -Dir "$R9\bin"'
    WriteRegStr HKCU "${REG_APP}" "PathCommand" "0"
  ${EndIf}
  Call RunTool
  ${If} $2 S!= "0"
    DetailPrint "The user Path could not be updated ($2). Add $R9\bin to it to use the kybern command."
  ${EndIf}
  Call BroadcastEnvironment
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp} "The app, its daemon and the kybern command."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Put a Kybern GPUIX shortcut on your desktop. The Start menu entry is always added."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPath} "Add the install folder's bin folder (kybern.exe only) to your user PATH, after the folders already there, so a kybern from the Kybern desktop app keeps winning."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function .onInit
  Call FindPowerShell
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop.ps1" "${PAYLOAD_DIR}\tools\stop.ps1"

  ; An update or reinstall keeps what the user chose before.
  ReadRegStr $0 HKCU "${REG_APP}" "PathCommand"
  ${If} $0 == "0"
    !insertmacro UnselectSection ${SecPath}
  ${EndIf}
  ReadRegStr $0 HKCU "${REG_APP}" "DesktopShortcut"
  ${If} $0 == "1"
    !insertmacro SelectSection ${SecDesktop}
  ${EndIf}

  StrCpy $UpdateMode 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  Call CheckAppClosed
FunctionEnd

Function .onInstSuccess
  ${If} $UpdateMode == 1
    SetOutPath "$INSTDIR"
    Exec '"$INSTDIR\${APP_EXE}"'
  ${EndIf}
FunctionEnd

; An update must not leave the user without an app: start whatever is installed.
Function .onInstFailed
  ${If} $UpdateMode == 1
  ${AndIf} ${FileExists} "$INSTDIR\${APP_EXE}"
    Exec '"$INSTDIR\${APP_EXE}"'
  ${EndIf}
FunctionEnd

Function un.onInit
  Call un.FindPowerShell
  Call un.CheckAppClosed
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  ; After the confirm page, so cancelling it leaves the daemon alone. A daemon from this folder holds
  ; kybernd.exe and its agents' working files open; stop it (kybern stop-daemon, then end what is left)
  ; before anything is deleted. Processes from other folders are never touched.
  Call un.InstDirNoSlash
  StrCpy $0 "stop.ps1"
  StrCpy $1 '-Action stop-all -Dir "$R9" -Seconds 20'
  Call un.RunTool
  ${If} $2 S!= "0"
    DetailPrint "Some Kybern GPUIX processes are still running ($2); their files are removed at the next restart."
  ${EndIf}

  Call un.InstDirNoSlash
  StrCpy $0 "path.ps1"
  StrCpy $1 '-Action remove -Dir "$R9\bin"'
  Call un.RunTool
  ${If} $2 S!= "0"
    DetailPrint "The user Path could not be updated ($2). Remove $R9\bin from it."
  ${EndIf}
  Call un.BroadcastEnvironment

  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  ; Only what the installer put here: a folder the user chose may hold other files.
  !include "${GENERATED_DIR}\uninstall-files.nsh"
  ; The embedded web view's WebView2 user data (caches only: every page runs InPrivate). Never the install folder.
  RMDir /r /REBOOTOK "$LOCALAPPDATA\kybern-gpuix\WebView2"
  ; Its parent too, but only when nothing else is in it (a plain RMDir leaves a folder that is not empty).
  RMDir "$LOCALAPPDATA\kybern-gpuix"
  Delete "$INSTDIR\*.old"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${REG_UNINSTALL}"
  DeleteRegKey HKCU "${REG_AUMID}"
  DeleteRegKey HKCU "${REG_APP}"
SectionEnd
