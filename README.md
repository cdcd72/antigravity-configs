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
scripts/sync-agy-scope.ps1                           # 同步腳本（支援 User 與 Project Scope）
```

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
  指令執行前由 Antigravity 透過 stdin 傳入 `{ toolCall: { name: "run_command", args: { CommandLine: "..." } } }`。若命中危險特徵，以 stdout 回傳 `{"decision":"deny","reason":"..."}` 並以 exit code 2 阻斷。
  涵蓋：`rm -rf`、`dd of=/dev/*`、`mkfs`、`shutdown`/`reboot`、`Remove-Item -Recurse -Force`、`Format-Volume`、`Clear-Disk`、`Stop-Computer`/`Restart-Computer`。
- **`format-lint.js`**（PostToolUse，matcher: `replace_file_content|write_to_file`）：
  檔案寫入完成後觸發。偵測不到 `package.json` 或 `pnpm` 則自動略過。對目標檔案執行 `pnpm prettier --write`（失敗不阻斷），若是 js/ts/svelte 則再執行 `pnpm eslint --fix`；若修復後仍有 error，輸出錯誤訊息並以 exit 2 要求修正。

## 維護

- 設定依性質放進對應 scope 目錄，不要混進同一份檔案。
- 改動後同步更新本 README。
