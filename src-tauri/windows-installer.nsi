Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define APP_NAME "Hermes Panel"
!define APP_VERSION "0.1.1"
!define APP_PUBLISHER "qt.cool"
!define APP_EXE "Hermes Panel.exe"
!define APP_DLL "WebView2Loader.dll"
!define UNINSTALL_EXE "Uninstall Hermes Panel.exe"
!define INSTALL_DIR "$LOCALAPPDATA\Programs\Hermes Panel"
!define REG_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hermes Panel"

!ifndef APP_SOURCE
  !error "APP_SOURCE must be defined"
!endif

!ifndef WEBVIEW2_SOURCE
  !error "WEBVIEW2_SOURCE must be defined"
!endif

!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE must be defined"
!endif

!ifndef APP_ICON
  !error "APP_ICON must be defined"
!endif

Name "${APP_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKCU "${REG_UNINSTALL}" "InstallLocation"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
XPStyle on
BrandingText "${APP_NAME}"

!include "MUI2.nsh"

Function IsAppRunning
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C ""$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /I /C:"${APP_EXE}""'
  Pop $0
  Pop $1
  StrCmp $0 "0" 0 not_running
  Push "1"
  Return

not_running:
  Push "0"
FunctionEnd

Function CloseRunningApp
  DetailPrint "Closing running ${APP_NAME} processes if needed..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${APP_EXE}" /F /T'
  Sleep 1000
FunctionEnd

Function EnsureAppClosedForSetup
  Call IsAppRunning
  Pop $0
  StrCmp $0 "1" 0 done

  MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL \
    "检测到旧版 ${APP_NAME} 正在运行。$\r$\n$\r$\n点击“确定”将自动彻底关闭旧版应用及相关进程，然后继续安装。$\r$\n点击“取消”将终止本次安装。$\r$\n$\r$\nAn older ${APP_NAME} is still running.$\r$\nClick OK to fully close the app and its related processes, then continue setup.$\r$\nClick Cancel to stop this installation." \
    IDOK close_app IDCANCEL cancel_setup

close_app:
  Call CloseRunningApp
  Call IsAppRunning
  Pop $0
  StrCmp $0 "1" still_running done

still_running:
  MessageBox MB_ICONSTOP|MB_OK \
    "未能自动关闭旧版 ${APP_NAME}。请先退出托盘中的应用并结束相关进程后，再重新运行安装程序。$\r$\n$\r$\nSetup could not close the older ${APP_NAME} automatically. Please exit the tray app and stop its processes, then run this installer again."
  Abort

cancel_setup:
  Abort

done:
FunctionEnd

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SectionIn RO
  Call EnsureAppClosedForSetup
  SetOutPath "$INSTDIR"
  File "/oname=${APP_EXE}" "${APP_SOURCE}"
  File "/oname=${APP_DLL}" "${WEBVIEW2_SOURCE}"
  WriteUninstaller "$INSTDIR\${UNINSTALL_EXE}"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REG_UNINSTALL}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${REG_UNINSTALL}" "UninstallString" '"$INSTDIR\${UNINSTALL_EXE}"'
  WriteRegStr HKCU "${REG_UNINSTALL}" "QuietUninstallString" '"$INSTDIR\${UNINSTALL_EXE}" /S'
  WriteRegDWORD HKCU "${REG_UNINSTALL}" "NoModify" 1
  WriteRegDWORD HKCU "${REG_UNINSTALL}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Call CloseRunningApp
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\${APP_DLL}"
  Delete "$INSTDIR\${UNINSTALL_EXE}"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${REG_UNINSTALL}"
SectionEnd
