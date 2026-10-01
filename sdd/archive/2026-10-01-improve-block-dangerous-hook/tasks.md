# tasks — improve-block-dangerous-hook

- [x] 1. 確認 Antigravity hook stdin 協定與輸入相容性（解析 `toolCall.args.CommandLine`/`args.command` 與 `args.Cwd`/`workspacePaths`/`cwd`）。
- [x] 2. 建立 `tests/block-dangerous.test.js` 測試框架與執行環境（支援 Antigravity 協定與 `HOOK_PATH` 環境變數）。
- [x] 3. 在 `user/.agents/hooks/block-dangerous.js` 加入多敘述切分與引號跳脫解析（`splitStatements`、`tokenize`）。
- [x] 4. 加入 PowerShell 與 cmd 刪除指令之別名、旗標縮寫與目標路徑解析。
- [x] 5. 加入危險目標路徑判斷（磁碟根、家目錄、`*`、`.`、`..`、專案目錄本身或上層、專案外路徑、`.git`；變數萬用字元保守擋下；專案內子路徑放行）。
- [x] 6. 加入 git 規則攔截（`clean`、`reset --hard`、`push --force`／`-f`／`+refspec`，放行 `--force-with-lease` 與 `-n`）及外殼巢狀呼叫檢查。
- [x] 7. 錯誤處理改為 fail-closed（輸出 `{"decision":"deny",...}` 與 `exit 2`）。
- [x] 8. 補齊所有測試案例分類，以 `node --test` 驗證全部通過。
- [x] 9. 更新 `README.md`，並以 `.\scripts\sync-agy-scope.ps1 -Scope User -WhatIf` 與 `-Diff` 驗證檔案隔離與差異。

## 驗收條件

- 情境：當指令是危險刪除（如 `Remove-Item C:\ -Recurse -Force`、`rm -rf ~`、`ri -r -fo $env:USERPROFILE`、`rd /s /q C:\`），就回傳 `deny` 並以 exit 2 阻斷。
- 情境：當指令是在專案內的明確子路徑（如 `Remove-Item src\posts\a -Recurse -Force`、`rm -rf dist`），就回傳 `allow` 並以 exit 0 放行。
- 情境：當目標含有變數、萬用字元或無法解析（如 `Remove-Item $x -Recurse -Force`、`Remove-Item * -Recurse -Force`），就回傳 `deny` 並阻斷。
- 情境：當指令是 `git clean -fdx`、`git reset --hard`、`git push --force`（或 `+main`），就回傳 `deny` 並阻斷；`git push --force-with-lease` 與 `git clean -n` 放行。
- 情境：當 stdin 為空、非合法 JSON 或缺少指令，就回傳 `deny` 並以 exit 2 阻斷（fail-closed），且在 stderr 印出原因。
- 情境：在 repo 根目錄執行 `node --test`，所有測試案例全數通過，不需要安裝任何外部 npm 套件。
- 情境：`.\scripts\sync-agy-scope.ps1 -Scope User -WhatIf` 的同步清單中不包含 `tests/` 或 `sdd/` 內檔案，且未寫入任何檔案。
