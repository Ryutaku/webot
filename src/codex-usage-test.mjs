import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";

function parseArgs(argv) {
  const options = {
    prompt: "Reply with exactly: hello",
    workspace: "",
    includeMcp: false,
    ephemeral: true,
    model: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prompt") {
      options.prompt = argv[i + 1] || options.prompt;
      i += 1;
      continue;
    }
    if (arg === "--workspace") {
      options.workspace = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--include-mcp") {
      options.includeMcp = true;
      continue;
    }
    if (arg === "--no-ephemeral") {
      options.ephemeral = false;
      continue;
    }
    if (arg === "--model") {
      options.model = argv[i + 1] || "";
      i += 1;
    }
  }

  return options;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function resolveExecutableMatches(command) {
  if (command.includes("\\") || command.includes("/") || path.extname(command)) {
    return [command];
  }
  try {
    const raw = execFileSync("where.exe", [command], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [command];
  }
}

function quoteForCmd(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/(["])/g, "^$1")}"`;
}

function buildSpawnSpec(command, args) {
  if (process.platform !== "win32") {
    return { file: command, args };
  }

  const matches = resolveExecutableMatches(command);
  const codexShim = matches.find((file) => /[\\/]codex(?:\.cmd)?$/i.test(file));
  if (codexShim) {
    const shimDir = path.dirname(codexShim);
    const jsEntry = path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(jsEntry)) {
      const bundledNode = path.join(shimDir, "node.exe");
      return {
        file: fs.existsSync(bundledNode) ? bundledNode : "node",
        args: [jsEntry, ...args],
      };
    }
  }

  const cmdLike = matches.find((file) => /\.(cmd|bat)$/i.test(file));
  if (cmdLike) {
    const line = [quoteForCmd(cmdLike), ...args.map(quoteForCmd)].join(" ");
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", line],
    };
  }

  const exeLike = matches.find((file) => /\.exe$/i.test(file)) || matches[0] || command;
  return { file: exeLike, args };
}

function extractUsage(events = []) {
  const usage = events
    .filter((event) => event?.type === "turn.completed" && event?.usage)
    .map((event) => event.usage)
    .at(-1);

  if (!usage) return null;

  const inputTokens = Number(usage.input_tokens || 0);
  const cachedInputTokens = Number(usage.cached_input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

async function main() {
  const cfg = loadConfig();
  const options = parseArgs(process.argv.slice(2));
  const workspaceKey = options.workspace || cfg.defaultWorkspace;
  const workspacePath = cfg.workspaces[workspaceKey];

  if (!workspacePath) {
    throw new Error(`Unknown workspace: ${workspaceKey}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-test-"));
  const outputFile = path.join(tempDir, "last-message.txt");
  const model = options.model || cfg.codex.model || "";

  const args = [
    ...(model ? ["--model", model] : []),
    "exec",
    "--json",
    "--color",
    "never",
    "--output-last-message",
    outputFile,
    "--sandbox",
    cfg.codex.sandbox || "read-only",
    "--cd",
    workspacePath,
    ...((cfg.codex.extraArgs || []).filter(Boolean)),
    ...(options.ephemeral ? ["--ephemeral"] : []),
    "-",
  ];

  if (options.includeMcp) {
    const sessionFile = path.join(cfg.stateDir, "mcp-session.json");
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const entryPath = path.join(currentDir, "webot-mcp.mjs");
    args.splice(1, 0,
      "-c",
      'mcp_servers.webot.transport="stdio"',
      "-c",
      'mcp_servers.webot.command="node"',
      "-c",
      `mcp_servers.webot.args=['${entryPath.replace(/\\/g, "\\\\")}']`,
      "-c",
      `mcp_servers.webot.env={WEBOT_SESSION_FILE='${sessionFile.replace(/\\/g, "\\\\")}'}`,
    );
  }

  const spawnSpec = buildSpawnSpec(cfg.codex.command || "codex", args);
  const events = [];
  let stderr = "";
  let stdoutBuffer = "";

  await new Promise((resolve, reject) => {
    const child = spawn(spawnSpec.file, spawnSpec.args, {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const parts = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = parts.pop() ?? "";
      for (const line of parts) {
        const event = parseJsonLine(line);
        if (event) events.push(event);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const tail = parseJsonLine(stdoutBuffer.trim());
      if (tail) events.push(tail);
      if (code !== 0) {
        reject(new Error(`codex exited with code ${code}\n${stderr}`.trim()));
        return;
      }
      resolve();
    });

    child.stdin.write(options.prompt);
    child.stdin.end();
  });

  const text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf-8").trim() : "";
  const usage = extractUsage(events);

  console.log(JSON.stringify({
    workspaceKey,
    workspacePath,
    includeMcp: options.includeMcp,
    ephemeral: options.ephemeral,
    prompt: options.prompt,
    reply: text,
    usage,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
