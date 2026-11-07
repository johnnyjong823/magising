# 魔唱 MagiSing

**一邊用電腦，一邊跟著字幕唱。**

用 YouTube Music、Spotify、Apple Music、KKBOX，或瀏覽器裡的 YouTube 播歌時，魔唱會自動找歌詞，在螢幕上顯示 KTV 風格的逐字字幕。字幕浮在所有視窗上面，滑鼠可以直接點穿，不影響你做別的事。

免費、開源（GPL-3.0）、沒有廣告。

## 功能

- **自動找歌詞**：偵測 Windows 媒體控制裡正在播放的歌，依語言到網易雲音樂、酷狗音樂、LRCLIB 找最符合的歌詞。
- **KTV 逐字填色**：有逐字時間的歌詞會一個字一個字變色；只有逐行時間時，會依字數估算每個字的時間來填色。
- **翻譯與羅馬拼音**：日文歌大多附中文翻譯和羅馬拼音，可以分別開關。
- **對時間**：字幕太快或太慢時，用按鈕或快捷鍵微調，每首歌各自記住。
- **換一份歌詞**：自動找到的不對時，可以從候選清單挑、自己輸入關鍵字搜尋，或拖一個 `.lrc` 檔進來。
- **外觀**：位置、大小、像素字或一般粗體、顏色、外框、陰影、不透明度都可以調。
- **簡轉繁**：簡體歌詞自動轉成繁體（日文歌詞不轉，免得改壞漢字）。

## 下載安裝

到 [Releases](https://github.com/johnnyjong823/magising/releases) 下載最新的 `MagiSing_Setup_x.y.z.exe` 執行即可。安裝到使用者資料夾，不需要管理員權限。

- 系統需求：Windows 10 21H2 以上或 Windows 11。
- 少數 Windows 10 沒有 WebView2 時，安裝程式會自動從微軟下載安裝。
- 目前安裝檔還沒有程式碼簽章，Windows 可能跳出「Windows 已保護您的電腦」：按「**其他資訊 → 仍要執行**」。簽章正在申請中，見下方 [Code signing policy](#code-signing-policy)。

### 預設快捷鍵

| 快捷鍵 | 功能 |
|---|---|
| `Ctrl+Alt+L` | 顯示 / 隱藏字幕 |
| `Ctrl+Alt+E` | 移動字幕（拖曳位置、拉大小） |
| `Ctrl+Alt+]` / `Ctrl+Alt+[` | 歌詞提早 / 延後 0.25 秒（加 `Shift` 是 0.05 秒） |
| `Ctrl+Alt+0` | 這首歌的偏移歸零 |
| `Ctrl+Alt+R` | 重新搜尋歌詞 |

快捷鍵都可以在「設定」裡改。關掉控制面板不會結束程式，要結束請在系統匣圖示按右鍵 →「結束魔唱」。

## 隱私

- 不用註冊帳號，沒有廣告，不追蹤使用行為。
- 找歌詞時，會把**正在播放的歌名、歌手與歌曲長度**（LRCLIB 另含專輯名稱），以及**手動搜尋時輸入的關鍵字**，送給網易雲音樂、酷狗音樂、LRCLIB。酷狗的歌曲搜尋是未加密的 HTTP 連線。
- 可以在「設定 → 歌詞來源」關掉任何一個或全部歌詞服務。全部關掉時只用電腦裡的 `.lrc` 檔，不會把歌曲資訊傳出去。
- 設定、歌詞快取與紀錄檔只存在你的電腦（`%APPDATA%\MagiSing\`）。
- 啟動時與之後每天一次連到 GitHub 查詢最新的版本號（請求裡只有程式名稱與版本），有新版時提示你，不會自動下載安裝。可以在「設定 → 其他」關掉。

完整的隱私政策與使用聲明見 [`src-tauri/LICENSE.txt`](src-tauri/LICENSE.txt)，安裝時也會顯示。

## 聲明

魔唱是個人開發的非官方工具，和網易雲音樂、酷狗音樂、LRCLIB、YouTube Music、Spotify 等服務沒有任何關係。歌詞的著作權屬於原詞曲作者與權利人，魔唱只在你的電腦上快取，供個人練唱使用。

## 贊助開發者

魔唱完全免費。如果它陪你唱得開心，歡迎斗內請開發者喝杯飲料，支持之後繼續更新！程式裡「關於」頁也有斗內按鈕。斗內完全自願，不影響任何功能。

<!-- DONATE_LINK：綠界實況主收款的斗內網址申請好之後填在這裡，同時填進 src-tauri/src/paths.rs 的 LINKS -->

## 找我做軟體

歡迎大家找我做**軟體、網頁或系統**：<https://johnnyx9487.bdcweb.org/>

## Code signing policy

Windows 安裝檔的程式碼簽章正在向 SignPath Foundation 申請（申請通過後才會生效）：

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [johnnyjong823](https://github.com/johnnyjong823)
- Approvers: [johnnyjong823](https://github.com/johnnyjong823)
- 只有從這個 repo 的原始碼、經 GitHub Actions 自動建置的檔案才會簽章，每次發版都要人工核准。
- Privacy policy：見上面的[隱私](#隱私)段落與 [`src-tauri/LICENSE.txt`](src-tauri/LICENSE.txt) 第六點。程式只在找歌詞時把歌曲資訊送給使用者可以在設定裡關掉的歌詞服務；另外啟動時與之後每天一次向 GitHub 查詢最新版本號（只帶程式名稱與版本，可以在設定裡關掉）。除此之外不會主動把任何資訊傳到其他網路系統。

## 授權

魔唱以 [GNU General Public License v3.0 or later](LICENSE) 授權。你可以自由使用、修改、散布，但修改後的版本也必須以 GPL-3.0 開源。

「魔唱」「MagiSing」名稱與程式圖示代表原作者發行的版本，發行修改版時請改用其他名稱。

使用的開源元件（Tauri、OpenCC、Cubic 11 字型等）與授權全文見 [`src-tauri/THIRD-PARTY-NOTICES.txt`](src-tauri/THIRD-PARTY-NOTICES.txt)。

---

## 開發

需要 Node 20+、Rust（MSVC）、Windows 10 21H2+ / 11。

```
npm install
npm run dev          # 開發模式（Vite + tauri dev，改 TS 立即生效，改 Rust 會自動重編）
npm test             # 單元測試（正規化、歌詞解析、比對評分、時鐘、填色時間）
npm run check        # TypeScript 型別檢查
npx vite-node tests/hitrate.live.ts [songs.json]   # 實際連網測試歌詞命中率（不在 npm test 裡；PROVIDERS=kugou 只測指定來源）
```

### 打包

```
npm run build:win
```

產出 `../dist/MagiSing_Setup_<版本>.exe`（NSIS 安裝檔）。正式版本由 GitHub Actions 建置：推送 `v*` 標籤（例如 `v0.4.0`）會自動建置並建立 Release 草稿，見 `.github/workflows/release.yml`。

### 公開散布用的文件

| 檔案 | 用途 |
|---|---|
| `LICENSE` | GPL-3.0 全文 |
| `src-tauri/LICENSE.txt` | 授權摘要、非官方聲明、歌詞著作權、隱私政策、免責（中英）。安裝時顯示，也會裝進安裝資料夾 |
| `src-tauri/THIRD-PARTY-NOTICES.txt` | 開源元件授權全文（字型、npm、Rust crates），裝進安裝資料夾 |
| `src-tauri/windows/hooks.nsh` | 安裝檔 hooks：移除舊名「強尼練歌坊」、解除安裝時刪資料夾（UTF-8 with BOM） |

**新增或升級套件之後**要重新產生授權清單：`npm run notices`（需要 `cargo install cargo-about --locked --features cli`）。
改了資料傳送方式（例如新增歌詞來源）要同步更新 `LICENSE.txt`、本 README 的隱私段落和控制面板「關於」頁。

### 結構

| 位置 | 內容 |
|---|---|
| `src-tauri/src/smtc.rs` | 每 250 ms 讀 SMTC，有變化才送 `smtc` 事件（另每 2 秒心跳）；換歌時讀封面 |
| `src-tauri/src/windows_ui.rs` | 字幕視窗（透明、點穿、不搶焦點、記住位置）、控制面板（關閉即釋放） |
| `src-tauri/src/hotkeys.rs` `tray.rs` | 全域快捷鍵（可自訂，失敗不中斷）、系統匣 |
| `src-tauri/src/db.rs` `settings.rs` | SQLite 歌詞快取與每首歌偏好、設定 JSON |
| `src-tauri/src/net.rs` | 網易雲（1.5 秒節流、405 冷卻 30 分鐘、備援端點）、酷狗（KRC 解碼）、LRCLIB；單次請求 4 秒逾時 |
| `src-tauri/src/paths.rs` | 資料夾、舊版資料搬移、紀錄檔、外部連結白名單 |
| `src-tauri/src/update.rs` | 新版本提示：啟動 15 秒後與每 24 小時讀 GitHub `releases/latest`，有新版就在面板與系統匣提示（不自動下載） |
| `web/core/` | 正規化、歌詞解析、評分、時鐘、填色時間、歌詞流程 |
| `web/providers/` | 網易雲、酷狗、LRCLIB、本機 LRC 資料夾 |
| `web/sources/smtc.ts` | 認得的播放器清單（`APPS`，要和 `smtc.rs` 一致）、選 Session、時間戳處理 |
| `web/overlay/` | 字幕視窗 = 核心（面板關掉照常運作） |
| `web/panel/` | 控制面板（只顯示與送指令） |

資料存在 `%APPDATA%\MagiSing\`（`settings.json`、`karaoke.db`、`overlay.json`、`app.log`）；exe 同目錄有 `data\` 資料夾時改存那裡（免安裝版）。v0.3.0 以前叫「強尼練歌坊」、資料在 `%APPDATA%\JohnnyKaraoke\`，第一次啟動會自動複製過來。

### 偏移的方向

`顯示時間 = 估計播放位置 + 全域偏移 + 本首偏移`。偏移是**正數 = 歌詞提早**（`Ctrl+Alt+]`），負數 = 延後（`Ctrl+Alt+[`）。

### 換程式圖示

改 `app-icon.svg` → `npx tauri icon app-icon.svg`（產生後可刪掉 `src-tauri/icons/android`、`ios`）→ `touch src-tauri/build.rs` → `npm run build:win`。
不 touch 的話 Cargo 不會重編，exe 裡嵌的還是舊圖示。
