# Antigravity (agy) 設定

集中管理 Google Antigravity (agy) 的自訂設定。依「作用範圍（scope）」分成兩份，各自帶一個獨立的 `.agents/`；Antigravity 執行時會自動尋找階層設定（全域 `~/.gemini/config/` 與專案根目錄 `.agents/`），兩邊的 hook 與 skill 同時生效。

| Scope       | 目錄               | 套用位置                                                        | 內容                                                           |
| ----------- | ------------------ | --------------------------------------------------------------- | -------------------------------------------------------------- |
| **User**    | `user/.agents/`    | 同步到 `%USERPROFILE%\.gemini\config`，對該帳號所有專案生效      | 與專案無關的機器層級設定：PowerShell 偏好規則、危險指令攔截 hook、共用子代理 |
| **Project** | `project/.agents/` | 疊進某個 repo 的 `.agents/`，只對該 repo 生效                   | 依賴專案工具鏈的設定：寫檔/編輯後的 format / lint hook         |

## 結構

```text
user/.agents/
├─ GEMINI.md                                         # PowerShell 優先的環境規則（全域 Rule）
├─ hooks.json                                        # PreToolUse：攔截危險指令之 Hook 定義
├─ hooks/block-dangerous.js                          # PreToolUse 執行腳本（符合 Antigravity stdin/stdout 協定）
└─ agents/generic-test-quality-reviewer/agent.md     # 語言/框架無關的測試品質審查子代理
project/.agents/
├─ hooks.json                                        # PostToolUse：針對 replace_file_content / write_to_file 觸發
└─ hooks/format-lint.js                              # 寫檔後自動執行 prettier / eslint --fix
tests/
└─ block-dangerous.test.js                           # block-dangerous 的單元測試（node:test）
scripts/sync-agy-scope.ps1                           # 同步腳本（支援 User 與 Project Scope）
```

## 測試

使用 Node.js 內建測試 runner（Node 18+），無需安裝額外套件：

```powershell
node --test
```

測試涵蓋遞迴旗標、刪除目標路徑（專案內放行、專案外/磁碟根/家目錄擋下）、`.git` 保護、git 規則、引號與跳脫、外殼巢狀呼叫、固定規則與 fail-closed 異常輸入。支援以環境變數 `$env:HOOK_PATH = '...'` 指定測試其他 hook 實體。

## 同步腳本 `scripts/sync-agy-scope.ps1`

需要 PowerShell 7+。所有模式都不會改動來源檔案。

`-WhatIf` / `-Diff` / `-Force` / `-Uninstall` 對兩種 scope 皆適用；其中 `-WhatIf`、`-Diff`、`-Uninstall` 三者互斥。同步後會在目標寫入 `.agy-scope-sync.json`（受管理檔案 + SHA-256），供 `-Uninstall` 判斷；被使用者改過的檔案不會被移除。

### User Scope

同步 `user/.agents/` 到 `%USERPROFILE%\.gemini\config`。由於 Antigravity 執行 hook 時工作目錄固定為 `hooks.json` 所在目錄，因此腳本使用乾淨的相對路徑 `node hooks/block-dangerous.js`。

```powershell
pwsh -NoProfile -File .\scripts\sync-agy-scope.ps1 -Scope User -WhatIf     # 預覽
pwsh -NoProfile -File .\scripts\sync-agy-scope.ps1 -Scope User -Diff       # 看差異
pwsh -NoProfile -File .\scripts\sync-agy-scope.ps1 -Scope User             # 同步（內容不同又沒 -Force 的會跳過）
pwsh -NoProfile -File .\scripts\sync-agy-scope.ps1 -Scope User -Force       # 覆蓋，先備份到 .agy-scope-backups\<時間戳>\
pwsh -NoProfile -File .\scripts\sync-agy-scope.ps1 -Scope User -Uninstall   # 移除本腳本管理的檔案
```

目標預設 `%USERPROFILE%\.gemini\config`，可用 `-UserScopePath <路徑>` 覆寫。

### Project Scope

疊 `project/.agents/` 進指定 repo 的 `.agents/`，`-TargetRepo` 必填。

```powershell
pwsh -NoProfile -File .\scripts\sync-agy-scope.ps1 -Scope Project -TargetRepo C:\path\to\repo
```

### 本 repo 開發

根目錄 `.agents/` 已被 `.gitignore` 忽略。要在本 repo 內啟用 format-lint hook：

```powershell
pwsh -NoProfile -File .\scripts\sync-agy-scope.ps1 -Scope Project -TargetRepo .
```

## Hook 行為

- **`block-dangerous.js`**（PreToolUse，matcher: `run_command`）：
  指令執行前由 Antigravity 透過 stdin 傳入 `{ toolCall: { name: "run_command", args: { CommandLine: "...", Cwd: "..." } } }`（亦相容 `tool_input.command`）。
  - **刪除指令目標判斷**：解析 PowerShell（`Remove-Item`、`ri`、`rm`、`rmdir`、`del`、`rd` 等）與 cmd（`del /s`、`rd /s`）的遞迴旗標與目標路徑。磁碟根、家目錄、專案目錄本身或其上層、專案外路徑、`.git`、變數與萬用字元一律阻斷；明確位於專案目錄內的子路徑（如 `dist`、`build`、測試目錄）放行。
  - **Git 不可逆操作**：阻斷 `git clean -f`（不含 `-n`）、`git reset --hard`、`git push --force`（含 `-f`、`+refspec`）；放行 `git push --force-with-lease` 與 `git clean -n`。
  - **外殼與子運算式**：遞迴檢查 `pwsh`、`cmd`、`bash` 外殼包裝與括號子運算式中的指令。
  - **固定規則**：攔截 `Clear-Disk`、`Format-Volume`、`Stop-Computer`、`Restart-Computer`、`shutdown`、`reboot`、`dd of=/dev/`、`mkfs`。
  - **fail-closed**：stdin 為空、格式錯誤、缺少指令或 hook 內部異常時，一律以 exit code 2 阻斷並輸出 `{"decision":"deny","reason":"..."}` 與 stderr 錯誤訊息。
- **`format-lint.js`**（PostToolUse，matcher: `replace_file_content|write_to_file`）：
  檔案寫入完成後觸發。偵測不到 `package.json` 或 `pnpm` 則自動略過。對目標檔案執行 `pnpm prettier --write`（失敗不阻斷），若是 js/ts/svelte 則再執行 `pnpm eslint --fix`；若修復後仍有 error，輸出錯誤訊息並以 exit 2 要求修正。

## 維護

- 設定依性質放進對應 scope 目錄，不要混進同一份檔案。
- 改動後同步更新本 README。
