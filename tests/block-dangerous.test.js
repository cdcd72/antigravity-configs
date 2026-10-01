// block-dangerous.js 的輸入輸出測試：餵 PreToolUse 的 JSON，檢查 exit code、stdout decision 與 stderr。
// 執行：node --test
// 以環境變數 HOOK_PATH 可改測其他版本的 hook（例如修改前的舊版，用來確認測試抓得到退步）。
// 針對 Windows 環境：路徑判斷使用 path.win32。

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const HOOK =
  process.env.HOOK_PATH ??
  path.resolve(
    __dirname,
    "..",
    "user",
    ".agents",
    "hooks",
    "block-dangerous.js",
  );

// 假的專案目錄：hook 只做字串與路徑運算，目錄不必真的存在
const PROJECT = "D:\\Work\\demo";
const HOME = os.homedir();

function runRaw(stdin) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: "utf8",
  });
}

function runCommand(command, cwd = PROJECT) {
  return runRaw(
    JSON.stringify({
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: command,
          Cwd: cwd,
        },
      },
    }),
  );
}

function runLegacyCommand(command, cwd = PROJECT) {
  return runRaw(JSON.stringify({ cwd, tool_input: { command } }));
}

function expectExit(expected, commands, cwd) {
  for (const command of commands) {
    it(command, () => {
      const result = runCommand(command, cwd);
      assert.equal(
        result.status,
        expected,
        `expected exit ${expected} but got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      if (expected === 2) {
        const parsed = JSON.parse(result.stdout || "{}");
        assert.equal(parsed.decision, "deny");
      } else if (expected === 0) {
        const parsed = JSON.parse(result.stdout || "{}");
        assert.equal(parsed.decision, "allow");
      }
    });
  }
}

const blocked = (commands, cwd) => expectExit(2, commands, cwd);
const allowed = (commands, cwd) => expectExit(0, commands, cwd);

describe("基礎骨架與協定相容性", () => {
  it("支援 Antigravity PreToolUse toolCall 協定", () => {
    const res = runCommand("git status");
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).decision, "allow");
  });

  it("相容 Claude Code tool_input 舊協定", () => {
    const res = runLegacyCommand("git status");
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).decision, "allow");
  });
});

describe("刪除指令：遞迴旗標", () => {
  describe("擋下", () => {
    blocked([
      "Remove-Item C:\\x -Recurse -Force",
      "ri -r -fo C:\\x",
      "Remove-Item -Recurse:$true -fo C:\\x",
      "rm -rf C:\\x",
      "rm -rfv C:\\x",
      "rm -rvf C:\\x",
      "rm -rv C:\\x",
      "rm -Ir C:\\x",
      "rm -r -force C:\\x",
      "rm -rf -- C:\\x",
      "rd /s /q C:\\x",
      "rd /s/q C:\\x",
      "rmdir /s /q C:\\x",
      "rmdir /q/s C:\\x",
      "del /s /q C:\\x",
      "del /s/q C:\\x",
    ]);
  });

  describe("放行（沒有遞迴）", () => {
    allowed([
      "Remove-Item C:\\x\\file.txt",
      "Remove-Item C:\\x\\file.txt -Force",
      "Remove-Item C:\\x\\file.txt -Verbose -ErrorAction SilentlyContinue",
      "del C:\\x\\file.txt",
      "Remove-Item x -Recurse:$false",
    ]);
  });
});

describe("刪除指令：目標路徑", () => {
  describe("擋下", () => {
    blocked([
      // 磁碟根、專案本身與其上層、專案之外
      "Remove-Item C:\\ -Recurse -Force",
      "Remove-Item D:\\ -Recurse -Force",
      "rm -rf /",
      "Remove-Item . -Recurse -Force",
      "Remove-Item .. -Recurse -Force",
      "Remove-Item D:\\Work -Recurse -Force",
      "Remove-Item D:\\Work\\demo -Recurse -Force",
      "Remove-Item src\\..\\.. -Recurse -Force",
      "Remove-Item ..\\other -Recurse -Force",
      "Remove-Item E:\\data -Recurse -Force",
      "Remove-Item \\\\server\\share\\x -Recurse -Force",
      // 家目錄
      "rm -rf ~",
      `Remove-Item "${HOME}" -Recurse -Force`,
      `Remove-Item "${HOME}\\foo" -Recurse -Force`,
      // 變數、萬用字元、子運算式、無法解析的路徑
      "Remove-Item $x -Recurse -Force",
      "Remove-Item $env:TEMP\\x -Recurse -Force",
      "ri -r -fo $env:USERPROFILE",
      "Remove-Item %USERPROFILE%\\x -Recurse -Force",
      "Remove-Item * -Recurse -Force",
      "Remove-Item src\\* -Recurse -Force",
      "Remove-Item (Get-Item C:\\) -Recurse -Force",
      "Remove-Item C:foo -Recurse -Force",
      "Remove-Item HKLM:\\Software -Recurse -Force",
      // 多個目標只要有一個危險就擋；-Path 類參數也要解析
      "Remove-Item src\\a, C:\\x -Recurse -Force",
      "Remove-Item -Force -Recurse -LiteralPath C:\\x",
      "Remove-Item -Recurse -Force -Path:C:\\x",
      // 遞迴刪除卻沒有明確目標（pipeline 接收）
      "Get-ChildItem x | Remove-Item -Recurse -Force",
    ]);
  });

  describe("放行（專案內的明確子路徑）", () => {
    allowed([
      "Remove-Item src\\posts\\a -Recurse -Force",
      "Remove-Item src\\a, src\\b -Recurse -Force -Confirm:$false; git status --short",
      "Remove-Item D:\\Work\\demo\\dist -Recurse -Force",
      "Remove-Item D:\\Work\\demo\\dist\\ -Recurse -Force",
      "Remove-Item -Recurse -Force -Path .\\dist",
      'Remove-Item "src\\a b" -Recurse -Force',
      "rm -r node_modules",
      "rm -rfv build",
      "rm -Ir build",
      "rmdir /s /q build",
      "rd /s/q build",
      "del /s/q build\\cache",
    ]);
  });

  describe("專案目錄本身太廣時，所有遞迴刪除都擋", () => {
    blocked(["Remove-Item build -Recurse -Force"], HOME);
    blocked(["Remove-Item build -Recurse -Force"], path.win32.dirname(HOME));
  });
});

describe(".git 保護", () => {
  describe("擋下（不分大小寫、尾端點、短檔名）", () => {
    blocked([
      "Remove-Item .git -Recurse -Force",
      "Remove-Item .GIT -Recurse -Force",
      "rm -rf .Git",
      "Remove-Item .git. -Recurse -Force",
      "Remove-Item GIT~1 -Recurse -Force",
      "Remove-Item src\\..\\.git -Recurse -Force",
      "Remove-Item src\\..\\.GIT\\objects -Recurse -Force",
    ]);
  });

  describe("放行（名稱相近但不是 .git）", () => {
    allowed([
      "Remove-Item .github\\cache -Recurse -Force",
      "Remove-Item .gitignore.bak -Recurse -Force",
      "Remove-Item gitx -Recurse -Force",
    ]);
  });
});

describe("git 規則", () => {
  describe("擋下", () => {
    blocked([
      "git clean -f",
      "git clean -fdx",
      "git -C foo clean -fd",
      "git reset --hard",
      "git reset --hard HEAD~1",
      "git push --force",
      "git push -f origin main",
      "git push origin HEAD --force",
      "git -c x=y push -f",
      "git push origin +main",
      "git status; git push --force",
      "git.exe push -f",
    ]);
  });

  describe("放行", () => {
    allowed([
      "git status",
      "git push",
      "git push origin main",
      "git push --force-with-lease",
      "git push --force-if-includes",
      "git clean -n",
      "git clean -n -f",
      "git clean -fdxn",
      "git reset --soft HEAD~1",
    ]);
  });
});

describe("引號與跳脫", () => {
  describe("擋下（引號未配對或跳脫造成無法可靠解析）", () => {
    blocked([
      'echo "a`"b"; Remove-Item C:\\x -Recurse',
      "echo it's; Remove-Item C:\\x -Recurse",
      'echo "unterminated; Remove-Item C:\\x -Recurse',
      "Remove-Item C:\\x`* -Recurse",
    ]);
  });

  describe("放行", () => {
    allowed([
      'git commit -m "don\'t panic"',
      'git commit -m "docs: rm -rf note"',
      'echo "a`"b"',
      "echo 'it''s fine'",
      'echo "Remove-Item C:\\x -Recurse -Force"',
    ]);
  });
});

describe("外殼與 cd", () => {
  describe("擋下", () => {
    blocked([
      'cmd /c "rd /s /q C:\\x"',
      'cmd /c cmd /c "rd /s /q C:\\x"',
      'pwsh -NoProfile -Command "Remove-Item C:\\x -Recurse -Force"',
      'pwsh -ExecutionPolicy Bypass -Command "Remove-Item C:\\x -Recurse -Force"',
      "powershell -c Remove-Item C:\\x -Recurse -Force",
      "if ($true) { Remove-Item C:\\x -Recurse -Force }",
      "Get-ChildItem | ForEach-Object { Remove-Item C:\\x -Recurse -Force }",
      // cd 之後相對路徑不可信
      "cd C:\\; Remove-Item foo -Recurse -Force",
      "cd src; rm -rf dist",
    ]);
  });

  describe("放行", () => {
    allowed([
      'pwsh -NoProfile -Command "Remove-Item src\\a -Recurse -Force"',
      "cd src; Get-ChildItem",
    ]);
  });
});

describe("與目標無關的固定規則", () => {
  blocked([
    "shutdown /s",
    "reboot",
    "Stop-Computer",
    "Restart-Computer",
    "Format-Volume -DriveLetter D",
    "Clear-Disk -Number 1",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sda",
  ]);
});

describe("一般指令", () => {
  allowed([
    "git status",
    "Get-ChildItem",
    "pnpm run lint",
    "node --version",
    "Remove-Item file.txt",
  ]);

  it("空字串 command 沒有風險，放行", () => {
    const res = runCommand("");
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).decision, "allow");
  });
});

describe("fail-closed：輸入異常一律擋下並說明原因", () => {
  const abnormalInputs = {
    "空的 stdin": "",
    "只有空白的 stdin": "  \n",
    "無效的 JSON": "not json",
    "JSON null": "null",
    "空陣列": "[]",
    "缺少 toolCall 與 tool_input": JSON.stringify({ Cwd: PROJECT }),
    "缺少 command": JSON.stringify({
      toolCall: { name: "run_command", args: {} },
    }),
    "command 不是字串": JSON.stringify({
      toolCall: { name: "run_command", args: { CommandLine: 123 } },
    }),
  };

  for (const [label, stdin] of Object.entries(abnormalInputs)) {
    it(label, () => {
      const result = runRaw(stdin);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /block-dangerous Hook Error/);
      const parsed = JSON.parse(result.stdout || "{}");
      assert.equal(parsed.decision, "deny");
    });
  }
});
