#!/usr/bin/env node
const os = require('node:os');
const path = require('node:path');

const MAX_DEPTH = 3;

// 與目標無關、一律攔截的指令
const ALWAYS_DANGEROUS_RULES = [
  /\bdd\s+.*\bof=\/dev\//,
  /\bmkfs(\.\w+)?\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bClear-Disk\b/i,
  /\bFormat-Volume\b/i,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,
];

// Remove-Item 及其別名（PowerShell）與 del / rd / rmdir（cmd）
const DELETE_COMMANDS = new Set(['remove-item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase']);
// 會改變工作目錄的指令：之後的相對路徑無法可靠解析
const LOCATION_COMMANDS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
// 會把字串當成指令執行的外殼
const WRAPPER_COMMANDS = new Set([
  'pwsh',
  'powershell',
  'cmd',
  'bash',
  'sh',
  'wsl',
  'iex',
  'invoke-expression',
]);

// 依未加引號的 ; & | { } 與換行切成多個敘述
// 反引號是 PowerShell 的跳脫字元（單引號字串內除外）；引號未配對時無法可靠解析，直接拋錯擋下
function splitStatements(command) {
  const statements = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (char === '`' && quote !== "'" && i + 1 < command.length) {
      current += char + command[++i];
    } else if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (';&|{}\r\n'.includes(char)) {
      statements.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quote) throw new Error('引號未配對，無法安全解析指令');
  statements.push(current);

  return statements.map((statement) => statement.trim()).filter(Boolean);
}

// 以空白切成參數，並去掉引號（跳脫用的反引號保留，讓危險目標判斷能看見它）
function tokenize(statement) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < statement.length; i++) {
    const char = statement[i];

    if (char === '`' && quote !== "'" && i + 1 < statement.length) {
      current += char + statement[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error('引號未配對，無法安全解析指令');
  if (started) tokens.push(current);

  return tokens;
}

// PowerShell 參數可縮寫：-fo、-rec、-Recurse:$true 都算
function isParam(token, name, minLength) {
  const match = /^-([a-z]+)(?::.*)?$/i.exec(token);
  if (!match) return false;

  const given = match[1].toLowerCase();
  return given.length >= minLength && name.startsWith(given);
}

// -Recurse:$false / -Recurse:0 視為關閉
function isSwitchOn(token) {
  const match = /:(.*)$/.exec(token);
  return !match || !/^(\$false|0)$/i.test(match[1]);
}

// 回傳 target 相對 base 的路徑；在 base 之外則回傳 null
function relativeInside(base, target) {
  const relative = path.win32.relative(base, target);
  if (relative === '') return '';
  if (path.win32.isAbsolute(relative) || relative.split('\\')[0] === '..') return null;
  return relative;
}

function createContext(projectDir) {
  return {
    projectDir,
    // 專案目錄就是家目錄或其上層（含磁碟根）時，沒有任何目標可視為「專案內」
    tooBroad: relativeInside(projectDir, os.homedir()) !== null,
    relativeUnsafe: false,
  };
}

function isDangerousTarget(rawTarget, context) {
  const target = rawTarget.trim();

  if (!target || context.tooBroad) return true;
  // 變數、萬用字元、子運算式、家目錄縮寫
  if (/[$`*?[\]()%]/.test(target) || target.startsWith('~')) return true;

  // 只允許磁碟機代號的冒號；其他（PowerShell provider、NTFS stream）無法解析
  const colonAt = target.indexOf(':');
  if (colonAt !== -1 && (colonAt !== 1 || !/^[a-z]/i.test(target) || target.indexOf(':', 2) !== -1)) {
    return true;
  }

  // C:foo 這類「磁碟機相對路徑」，以及工作目錄可能已被改變時的相對路徑
  if (!path.win32.isAbsolute(target) && (/^[a-z]:/i.test(target) || context.relativeUnsafe)) {
    return true;
  }

  const relative = relativeInside(context.projectDir, path.win32.resolve(context.projectDir, target));

  // 專案之外、專案本身（含其上層、磁碟根）、或 .git
  if (relative === null || relative === '') return true;
  return relative.split('\\').some(isGitDirName);
}

// Windows 不分大小寫、會忽略尾端的點與空白，且 .git 的短檔名是 GIT~1
function isGitDirName(segment) {
  const name = segment.replace(/[. ]+$/, '').toLowerCase();
  return name === '.git' || /^git~\d+$/.test(name);
}

function isDangerousDelete(args, context) {
  let recurse = false;
  const targets = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // cmd：/s 遞迴，其餘單字母開關（/q /f /a:h …）略過；可連寫成 /s/q
    if (/^(?:\/[a-z](?::[^\s/]*)?)+$/i.test(arg)) {
      if (arg.split('/').some((flag) => /^s$/i.test(flag))) recurse = true;
    } else if (isParam(arg, 'recurse', 1)) {
      if (isSwitchOn(arg)) recurse = true;
    } else if (arg.toLowerCase() === '--recursive' || (/^-[rRfivIdx]{2,}$/.test(arg) && /r/i.test(arg))) {
      // bash 風格：--recursive，以及 -rf、-fr、-rfv、-Ir 等合併短旗標（rm 的單字母選項）
      recurse = true;
    } else if (isParam(arg, 'path', 1) || isParam(arg, 'literalpath', 1)) {
      const colonAt = arg.indexOf(':');
      targets.push(colonAt !== -1 ? arg.slice(colonAt + 1) : (args[++i] ?? ''));
    } else if (
      isParam(arg, 'include', 3) ||
      isParam(arg, 'exclude', 2) ||
      isParam(arg, 'filter', 2) ||
      isParam(arg, 'credential', 2) ||
      isParam(arg, 'stream', 2) ||
      isParam(arg, 'erroraction', 2) ||
      /^-ea$/i.test(arg)
    ) {
      // 這些參數帶值；值不是刪除目標
      if (!arg.includes(':')) i++;
    } else if (!arg.startsWith('-')) {
      // 位置參數就是 -Path；可用逗號列出多個
      targets.push(...(arg === '' ? [''] : arg.split(',').filter(Boolean)));
    }
  }

  if (!recurse) return false;
  // 遞迴刪除卻沒有明確目標（例如從 pipeline 接收）無法判斷範圍
  if (targets.length === 0) return true;

  return targets.some((target) => isDangerousTarget(target, context));
}

function isDangerousGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
  }

  const subcommand = args[i];
  const rest = args.slice(i + 1);
  const hasShortFlag = (letter) =>
    rest.some((arg) => new RegExp(`^-[a-zA-Z]*${letter}[a-zA-Z]*$`).test(arg));

  switch (subcommand) {
    case 'clean':
      if (rest.includes('--dry-run') || hasShortFlag('n')) return false;
      return rest.includes('--force') || hasShortFlag('f');
    case 'reset':
      return rest.includes('--hard');
    case 'push':
      // --force-with-lease 與 --force-if-includes 不算；+refspec 等同強制推送
      return rest.includes('--force') || hasShortFlag('f') || rest.some((arg) => /^\+./.test(arg));
    default:
      return false;
  }
}

function isDangerousCommand(command, parentContext, depth = 0) {
  if (depth > MAX_DEPTH) return true;
  if (ALWAYS_DANGEROUS_RULES.some((rule) => rule.test(command))) return true;

  const statements = splitStatements(command);
  const context = {
    ...parentContext,
    relativeUnsafe:
      parentContext.relativeUnsafe ||
      statements.some((statement) =>
        LOCATION_COMMANDS.has((tokenize(statement)[0] ?? '').toLowerCase()),
      ),
  };

  for (const statement of statements) {
    const tokens = tokenize(statement);
    if (tokens.length === 0) continue;

    const name = tokens[0].toLowerCase().split(/[\\/]/).pop().replace(/\.exe$/, '');
    const args = tokens.slice(1);

    if (DELETE_COMMANDS.has(name) && isDangerousDelete(args, context)) return true;
    if (name === 'git' && isDangerousGit(args)) return true;

    if (WRAPPER_COMMANDS.has(name)) {
      const firstCommandToken = args.findIndex((arg) => !/^[-/][a-z]+$/i.test(arg));
      const nested = firstCommandToken === -1 ? [] : args.slice(firstCommandToken);
      if (
        isDangerousCommand(nested.join(' '), context, depth + 1) ||
        nested.some((arg) => /\s/.test(arg) && isDangerousCommand(arg, context, depth + 1))
      ) {
        return true;
      }
    }

    // 括號內的子運算式：把括號當成分隔再檢查一次
    if (statement.includes('(') && isDangerousCommand(statement.replace(/[()]/g, ';'), context, depth + 1)) {
      return true;
    }
  }

  return false;
}

async function readStdinJson() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString().trim();

  if (!raw) {
    throw new Error('stdin 為空');
  }

  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stdin 不是有效的 JSON 物件');
  }

  return parsed;
}

async function main() {
  const input = await readStdinJson();
  // Antigravity PreToolUse protocol provides toolCall: { name, args: { CommandLine: "...", Cwd: "..." } }
  // Also supports tool_input for backward compatibility
  const toolArgs = input.toolCall?.args || input.tool_input || {};
  const command = toolArgs.CommandLine ?? toolArgs.command;

  // 此 hook 只掛在 run_command；缺少 command 代表輸入異常，不能當成「沒有風險」
  if (typeof command !== 'string') {
    throw new Error('缺少指令參數 (CommandLine / command)');
  }
  if (!command.trim()) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    process.exit(0);
  }

  const rawProjectDir =
    toolArgs.Cwd ||
    toolArgs.cwd ||
    input.cwd ||
    (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) ||
    process.cwd();

  const projectDir = path.win32.resolve(rawProjectDir);

  if (isDangerousCommand(command, createContext(projectDir))) {
    const reason = `禁止執行危險指令：${command}`;
    console.error(reason);
    process.stdout.write(
      JSON.stringify({
        decision: 'deny',
        reason: reason,
      })
    );
    process.exit(2);
  }

  process.stdout.write(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

main().catch((error) => {
  // fail-closed：hook 自己出錯時也要擋下，避免保護悄悄失效
  const reason = `[block-dangerous Hook Error] ${error.message}`;
  console.error(reason);
  process.stdout.write(
    JSON.stringify({
      decision: 'deny',
      reason: reason,
    })
  );
  process.exit(2);
});
