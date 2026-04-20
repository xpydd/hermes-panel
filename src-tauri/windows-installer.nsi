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
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\${APP_DLL}"
  Delete "$INSTDIR\${UNINSTALL_EXE}"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${REG_UNINSTALL}"
SectionEnd
