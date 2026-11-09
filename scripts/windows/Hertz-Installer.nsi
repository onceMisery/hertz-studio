; SPDX-License-Identifier: MIT
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "nsDialogs.nsh"

!ifndef PACKAGE_DIR
!error "PACKAGE_DIR is required"
!endif
!ifndef SETUP_SOURCE
!error "SETUP_SOURCE is required"
!endif
!ifndef OWNER_SOURCE
!error "OWNER_SOURCE is required"
!endif
!ifndef OUTPUT_EXE
!error "OUTPUT_EXE is required"
!endif
!ifndef PRODUCT_VERSION
!error "PRODUCT_VERSION is required"
!endif

Name "Hertz Studio Full"
OutFile "${OUTPUT_EXE}"
InstallDir "$LOCALAPPDATA\Programs\Hertz Studio"
InstallDirRegKey HKCU "Software\HertzStudio\Desktop" "InstallDir"
BrandingText "Hertz Studio"
VIProductVersion "${PRODUCT_VERSION_NUMERIC}"
VIAddVersionKey "ProductName" "Hertz Studio Full"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "FileDescription" "Hertz Studio current-user installer"
VIAddVersionKey "LegalCopyright" "hertz-studio contributors"
!define MUI_ICON "${PRODUCT_ICON}"
!define MUI_UNICON "${PRODUCT_ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TEXT "Hertz Studio 已安装。可从桌面或开始菜单打开播放器。资料保留在当前用户的资料目录；卸载程序不会删除音乐与资料。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PACKAGE_DIR}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
Page custom DataInformation
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Var SetupExit
Var SetupOutput
Var SetupLog

!macro SaveSetupResult ACTION
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  System::Call 'kernel32::GetTickCount() i .r1'
  StrCpy $SetupLog "$TEMP\Hertz-Setup-$0-$1.log"
  FileOpen $0 "$SetupLog" w
  FileWriteUTF16LE /BOM $0 "Action:${ACTION}$\r$\nInstallDir:$INSTDIR$\r$\nExit:$SetupExit$\r$\n$SetupOutput$\r$\n"
  FileClose $0
!macroend

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Hertz Studio 需要 Windows 11 x64。"
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin11}
    MessageBox MB_ICONSTOP "Hertz Studio 需要 Windows 11 x64。"
    Abort
  ${EndIf}
FunctionEnd

Function DataInformation
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "程序位置：$INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0 38u 100% 48u "默认资料位置：$LOCALAPPDATA\hertz-studio$\r$\n音乐、歌单、歌词和设置与程序目录分开保存。卸载保留资料，安装不会自动播放或启用开机启动。"
  Pop $0
  ${NSD_CreateLabel} 0 96u 100% 34u "需要 Microsoft Edge WebView2 Evergreen Runtime。当前安装包不附带运行时，缺少时请先从微软官方页面安装。"
  Pop $0
  ${NSD_CreateLink} 0 140u 100% 18u "打开微软 WebView2 下载页面"
  Pop $0
  ${NSD_OnClick} $0 OpenWebView
  nsDialogs::Show
FunctionEnd

Function OpenWebView
  ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/"
FunctionEnd

Section "Hertz Studio"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\setup"
  File /oname=Install-Hertz.ps1 "${SETUP_SOURCE}"
  File /oname=PackageOwner.ps1 "${OWNER_SOURCE}"
  WriteUninstaller "$PLUGINSDIR\setup\Uninstall-Hertz.exe"
  SetOutPath "$PLUGINSDIR\package"
  File "${PACKAGE_DIR}\*.*"
  nsExec::ExecToStack /MBCS '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\setup\Install-Hertz.ps1" -Action Install -InstallDir "$INSTDIR\." -PackageDir "$PLUGINSDIR\package" -Uninstaller "$PLUGINSDIR\setup\Uninstall-Hertz.exe" -AnsiConsole ${DEVELOPMENT_ARGUMENT}'
  Pop $SetupExit
  Pop $SetupOutput
  !insertmacro SaveSetupResult "Install"
  ${If} $SetupExit != 0
    SetErrorLevel 1
    DetailPrint "$SetupOutput"
    MessageBox MB_ICONSTOP "安装未完成。原有资料保留。请根据下方原因处理后重新运行安装器：$\r$\n$SetupOutput$\r$\n详细日志：$SetupLog" /SD IDOK
    Abort
  ${EndIf}
  DetailPrint "$SetupOutput"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\setup"
  File /oname=Install-Hertz.ps1 "${SETUP_SOURCE}"
  File /oname=PackageOwner.ps1 "${OWNER_SOURCE}"
  nsExec::ExecToStack /MBCS '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\setup\Install-Hertz.ps1" -Action Uninstall -InstallDir "$INSTDIR\." -AnsiConsole ${DEVELOPMENT_ARGUMENT}'
  Pop $SetupExit
  Pop $SetupOutput
  !insertmacro SaveSetupResult "Uninstall"
  ${If} $SetupExit != 0
    SetErrorLevel 1
    DetailPrint "$SetupOutput"
    MessageBox MB_ICONSTOP "卸载未完成，资料仍保留。请关闭使用此程序目录的播放器或按错误说明修复后重试：$\r$\n$SetupOutput$\r$\n详细日志：$SetupLog" /SD IDOK
    Abort
  ${EndIf}
  DetailPrint "$SetupOutput"
SectionEnd
