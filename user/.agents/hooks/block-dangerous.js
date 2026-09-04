#!/usr/bin/env node

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

function isDangerousCommand(command) {
  const rules = [
    /\brm\s+(-[^\s]*r[^\s]*f|-.[^\s]*f[^\s]*r)\b/, // rm -rf / rm -fr
    /\brm\s+-r\s+\/\b/, // rm -r /
    /\bdd\s+.*\bof=\/dev\//,
    /\bmkfs(\.\w+)?\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bRemove-Item\b[^\r\n]*\s-(?:Recurse|r)\b[^\r\n]*\s-(?:Force|f)\b/i,
    /\bRemove-Item\b[^\r\n]*\s-(?:Force|f)\b[^\r\n]*\s-(?:Recurse|r)\b/i,
    /\bClear-Disk\b/i,
    /\bFormat-Volume\b/i,
    /\bStop-Computer\b/i,
    /\bRestart-Computer\b/i,
  ];

  return rules.some((rule) => rule.test(command));
}

async function main() {
  const input = await readStdinJson();
  // Antigravity PreToolUse protocol provides toolCall: { name, args: { CommandLine: "..." } }
  // Also supports tool_input for backward compatibility
  const toolArgs = input.toolCall?.args || input.tool_input || {};
  const command = toolArgs.CommandLine || toolArgs.command;

  if (!command) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  }

  if (isDangerousCommand(command)) {
    const reason = `禁止執行危險指令：${command}`;
    console.error(reason);
    // Return explicit deny decision according to Antigravity PreToolUse specification
    process.stdout.write(JSON.stringify({
      decision: "deny",
      reason: reason
    }));
    process.exit(2);
  }

  process.stdout.write(JSON.stringify({ decision: "allow" }));
  process.exit(0);
}

main().catch((error) => {
  console.error(`[block-dangerous Hook Error] ${error.message}`);
  // In case of hook execution error, fallback to allow so the agent is not completely bricked
  process.stdout.write(JSON.stringify({ decision: "allow" }));
  process.exit(0);
});
