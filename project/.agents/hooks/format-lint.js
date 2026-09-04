#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

async function readStdinJson() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString().trim();

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

async function main() {
  const input = await readStdinJson();
  // Antigravity PostToolUse contract provides toolCall or tool_input
  const toolArgs = input.toolCall?.args || input.tool_input || {};
  const filePath = toolArgs.TargetFile || toolArgs.targetFile || toolArgs.filePath || toolArgs.file_path;

  if (!filePath) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // hooks.json 的執行工作目錄是 .agents 目錄本身；
  // 因此專案根目錄優先從 input.workspacePaths[0] 取得，或退回上一層目錄 (..)
  const projectRoot =
    (input.workspacePaths && input.workspacePaths[0]) ||
    path.resolve(process.cwd(), '..');

  const hasPackageJson = fs.existsSync(path.join(projectRoot, 'package.json'));
  const pnpmExists =
    spawnSync('pnpm', ['--version'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
      cwd: projectRoot,
    }).status === 0;

  if (!hasPackageJson || !pnpmExists) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const isFormatTarget =
    /\.(js|jsx|ts|tsx|mjs|cjs|json|css|scss|html|md|mdx|yaml|yml|svelte)$/i.test(
      filePath,
    );
  const isLintTarget = /\.(js|jsx|ts|tsx|svelte)$/i.test(filePath);

  const runOptions = {
    shell: process.platform === 'win32',
    cwd: projectRoot,
  };

  // Prettier：純粹「盡力而為」，格式化失敗不阻斷、不回報給 Agent
  if (isFormatTarget) {
    spawnSync('pnpm', ['prettier', '--write', filePath], {
      ...runOptions,
      stdio: 'ignore',
    });
  }

  // ESLint：先 --fix，再用 --format json 檢查「修不掉」的殘留 error
  if (isLintTarget) {
    const eslintResult = spawnSync(
      'pnpm',
      ['eslint', '--fix', '--format', 'json', filePath],
      { ...runOptions, encoding: 'utf-8' },
    );

    let lintReports = [];
    try {
      lintReports = JSON.parse(eslintResult.stdout || '[]');
    } catch {
      // eslint 本身跑不起來（設定錯誤、套件缺失等），只記錄，不阻斷
      if (eslintResult.stderr) {
        console.error(`[format-lint] eslint 執行異常：${eslintResult.stderr.slice(0, 500)}`);
      }
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const fileReport = lintReports.find((r) => r.filePath === filePath) ?? lintReports[0];

    if (fileReport && fileReport.errorCount > 0) {
      const summary = fileReport.messages
        .filter((m) => m.severity === 2) // 2 = error, 1 = warning
        .slice(0, 10)
        .map((m) => `  L${m.line}:${m.column} [${m.ruleId ?? 'unknown-rule'}] ${m.message}`)
        .join('\n');

      console.error(
        `[format-lint] ${path.basename(filePath)} 仍有 ${fileReport.errorCount} 個 ESLint 無法自動修復的錯誤：\n${summary}\n請修正這些問題。`,
      );

      process.stdout.write(JSON.stringify({}));
      process.exit(2);
    }
  }

  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

main().catch((error) => {
  console.error(`[format-lint Hook Error] ${error.message}`);
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
});
