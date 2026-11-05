; ===== 自定义 NSIS 行为 =====
; electron-builder 默认安装到 %ProgramFiles%，这里改成指定目录。
; 安装向导的「选择安装位置」页面仍可手动修改目录。
; 优先级：/D= 命令行参数 > 已安装目录（升级） > 下面的默认目录。
!include LogicLib.nsh

!macro customInit
  ; GetDParameter 由 electron-builder 的 multiUser.nsh 提供，用于读取 /D= 参数
  !insertmacro GetDParameter $R0
  ${If} $R0 == ""
    ; 已安装过则沿用原来的位置，避免升级时把程序装到另一处
    ReadRegStr $R1 HKLM "Software\${APP_GUID}" InstallLocation
    ${If} $R1 == ""
      StrCpy $INSTDIR "D:\Program Files\RaccoonQuant\Browser\PcAsMobile"
    ${EndIf}
  ${EndIf}
!macroend
