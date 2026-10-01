# improve-block-dangerous-hook（新功能：調整既有 hook 行為並補齊自動化測試）

## 為什麼做

`user/.agents/hooks/block-dangerous.js` 是 Antigravity User Scope 的危險指令攔截 hook（PreToolUse，matcher: `run_command`），目前有三個問題：

- **誤擋**：`Remove-Item` 只要同時帶 `-Recurse` 與 `-Force` 就擋，不論刪除目標是否為專案內的測試或構建目錄（例如 `Remove-Item dist -Recurse -Force` 會被當成刪除 `C:\` 對待）。
- **漏擋**：規則只比對字面的 `Remove-Item` 與完整旗標。別名（`ri`、`rm`、`rmdir`、`del`、`rd`）、旗標縮寫（`-fo`、`-Recurse:$true`）、cmd 的 `del /s`、`rd /s` 都不會被擋；`git clean -fdx`、`git reset --hard`、`git push --force`（含 `+refspec`）這類不可逆操作也不在清單內。
- **fail-open**：hook 內部出錯（例如 stdin JSON 解析失敗或缺少必要參數）時以 `exit 0` 且輸出 `{ decision: "allow" }` 放行，保護悄悄失效卻沒有警示。

此外，專案目前缺乏自動化測試套件，改動 hook 邏輯時容易產生迴歸或破壞現有保護機制。

## 要改什麼

1. **依目標路徑判斷刪除指令**：解析 `Remove-Item` 與其別名（`ri`、`rm`、`rmdir`、`del`、`erase`、`rd`）的遞迴／強制旗標（含縮寫與 `-Recurse:$true` 寫法）及目標路徑，只在目標危險時才擋。
   - 危險目標：磁碟根目錄、家目錄（`~`、`$env:USERPROFILE`）、`*`、`.`、`..`、專案目錄本身或其上層、專案目錄以外的絕對路徑、`.git`（含不分大小寫、尾端點與 `GIT~1` 短檔名）。
   - 目標含變數、萬用字元或無法解析時，一律視為危險（保守策略）。
   - 目標明確位於專案目錄內的子路徑時，放行。
   - 專案目錄取自 Antigravity 的 `toolCall.args.Cwd`，並兼顧 `workspacePaths`、`tool_input.cwd` 或 `process.cwd()`。
2. **補齊漏擋規則**：
   - cmd 風格的 `del /s`、`rd /s`（`rmdir /s`）套用同一套目標判斷。
   - 新增 `git clean`（不含 `-n` / `--dry-run`）、`git reset --hard`、`git push --force`（含 `-f`、`+refspec`）規則；`--force-with-lease` 與 `--force-if-includes` 放行。
   - 外殼指令（`pwsh`、`cmd`、`bash` 等）與括號子運算式之遞迴拆解檢查。
3. **符合 Antigravity 協定與 fail-closed**：
   - 輸入相容 Antigravity `toolCall: { name, args: { CommandLine, Cwd } }` 與舊版 `tool_input`。
   - 阻斷時回傳 `{"decision":"deny","reason":"..."}` 並 `process.exit(2)`；放行時回傳 `{"decision":"allow"}` 並 `process.exit(0)`。
   - 內部異常或輸入格式錯誤時改為 fail-closed：輸出 `decision: "deny"`、stderr 印出錯誤訊息，並 `process.exit(2)`。
4. **新增自動化測試套件**：
   - 新增 `tests/block-dangerous.test.js`，使用 Node 內建 `node:test`，不引入任何 npm 依賴。
   - 涵蓋刪除指令（該擋／該放行）、git 規則、引號與跳脫、`.git` 保護、外殼與 cd、固定規則、fail-closed。
   - 支援 `HOOK_PATH` 環境變數以供比對測試。
5. **更新文件**：更新 `README.md` 的結構樹、測試說明與 hook 行為描述。

## 影響範圍

修改：
- `user/.agents/hooks/block-dangerous.js`
- `README.md`

新增：
- `tests/block-dangerous.test.js`

不動：
- `user/.agents/hooks.json`
- `scripts/sync-agy-scope.ps1`
- `project/` 目錄下的所有檔案

`tests/` 位於 repo 根目錄，不會被 `sync-agy-scope.ps1` 同步至 `%USERPROFILE%\.gemini\config`。

## 待確認的假設

- 本機 Node.js 版本支援 `node:test`（目前為 v22.17.0）。
- 專案目錄依序由 `toolCall.args.Cwd` -> `workspacePaths[0]` -> `tool_input.cwd` -> `process.cwd()` 解析。
- 實際同步到 `%USERPROFILE%\.gemini\config` 僅在驗收階段由使用者確認或由腳本預覽（`-WhatIf` / `-Diff`），不自行複寫使用者全域設定。
