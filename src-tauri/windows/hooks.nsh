; 魔唱 NSIS 安裝檔 hooks（tauri.conf.json → bundle.windows.nsis.installerHooks）
; 這個檔案要存成 UTF-8 with BOM，不然 makensis 會用系統字碼頁讀中文

!define OLD_PRODUCT "強尼練歌坊"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCT}"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

Var OldAutostart

; v0.3.0 以前叫「強尼練歌坊」，產品名稱不同，NSIS 不會當成升級。
; 偵測到舊版就問要不要先移除，免得兩個版本同時開機啟動、搶快捷鍵。
; 舊資料在 %APPDATA%\JohnnyKaraoke\，舊版解除安裝不會刪它，魔唱第一次啟動時會複製過來。
!macro NSIS_HOOK_PREINSTALL
  StrCpy $OldAutostart ""
  ReadRegStr $R0 HKCU "${OLD_UNINSTKEY}" "UninstallString"
  ${If} $R0 != ""
    MessageBox MB_YESNO|MB_ICONQUESTION "偵測到舊版「${OLD_PRODUCT}」。$\n魔唱就是它的新版本，要先移除舊版嗎？$\n$\n歌詞快取與設定會自動帶到魔唱，不會遺失。" /SD IDYES IDNO magising_old_done
    ReadRegStr $OldAutostart HKCU "${RUNKEY}" "${OLD_PRODUCT}"
    ; UninstallString 是 "路徑\uninstall.exe"（含引號）→ 去掉引號，再取出資料夾
    StrCpy $R1 $R0 "" 1
    StrCpy $R1 $R1 -1
    StrCpy $R2 $R1 -14
    ; _?= 讓解除安裝程式在原地執行並等它結束（不加的話會複製到暫存資料夾後立刻返回）
    ExecWait '"$R1" /S _?=$R2'
    Delete "$R1"
    RMDir "$R2"
    magising_old_done:
  ${EndIf}
!macroend

; 舊版原本有開機啟動 → 魔唱也開（格式和 tauri-plugin-autostart 寫的一樣，名稱用 PRODUCTNAME）
!macro NSIS_HOOK_POSTINSTALL
  ${If} $OldAutostart != ""
    WriteRegStr HKCU "${RUNKEY}" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe" --minimized'
  ${EndIf}
!macroend

; 解除安裝時勾了「刪除應用程式資料」：Tauri 只刪 identifier 命名的資料夾，
; 魔唱的設定、歌詞快取、紀錄檔在 %APPDATA%\MagiSing\，這裡一併刪掉
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\MagiSing"
  ${EndIf}
!macroend
