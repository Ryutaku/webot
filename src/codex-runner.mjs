import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEBOT_MCP_ENTRY = path.join(CURRENT_DIR, "webot-mcp.mjs");

function buildPrompt(systemPreamble, userPrompt, conversationMemory = "") {
  const memorySection = conversationMemory ? `${conversationMemory}\n\n` : "";
  return `${systemPreamble}\n\n${memorySection}User message:\n${userPrompt}\n`;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function summarizeStderr(stderrText) {
  return stderrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n");
}

function readOutputText(outputFile) {
  if (!fs.existsSync(outputFile)) return "";
  try {
    const stats = fs.statSync(outputFile);
    if (!stats.isFile()) return "";
    return fs.readFileSync(outputFile, "utf-8").trim();
  } catch {
    return "";
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

function parseSessionMetaFromFile(filePath) {
  try {
    const firstLine = fs.readFileSync(filePath, "utf-8").split(/\r?\n/, 1)[0];
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || !parsed?.payload?.id) return null;
    return {
      id: parsed.payload.id,
      cwd: parsed.payload.cwd || "",
      source: parsed.payload.source || "",
      timestamp: parsed.payload.timestamp || "",
      filePath,
    };
  } catch {
    return null;
  }
}

function collectSessionFiles(rootDir, bucket = []) {
  if (!fs.existsSync(rootDir)) return bucket;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectSessionFiles(fullPath, bucket);
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      bucket.push(fullPath);
    }
  }
  return bucket;
}

function findLatestSessionForWorkspace(workspacePath, startedAt) {
  const normalizedWorkspace = path.resolve(workspacePath);
  const startedMs = Number(startedAt || 0);
  const candidates = collectSessionFiles(CODEX_SESSIONS_DIR)
    .map((filePath) => {
      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        return null;
      }
      if (startedMs && stats.mtimeMs < startedMs - 15000) {
        return null;
      }
      const meta = parseSessionMetaFromFile(filePath);
      if (!meta) return null;
      if (path.resolve(meta.cwd || "") !== normalizedWorkspace) return null;
      if (meta.source && meta.source !== "exec") return null;
      return {
        ...meta,
        mtimeMs: stats.mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0] || null;
}

function isResumeFailure(stderrText) {
  return /resume|session|not found|unknown session|could not load/i.test(stderrText || "");
}

export async function runCodexPrompt({
  cfg,
  workspacePath,
  prompt,
  conversationMemory = "",
  resumeSessionId = "",
  onEvent,
}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-"));
  const outputFile = path.join(tempDir, "last-message.txt");
  const modelArgs = cfg.codex.model ? ["--model", cfg.codex.model] : [];
  const sessionFile = path.join(cfg.stateDir, "mcp-session.json");
  const mcpConfigArgs = [
    "-c",
    'mcp_servers.webot.transport="stdio"',
    "-c",
    'mcp_servers.webot.command="node"',
    "-c",
    `mcp_servers.webot.args=['${WEBOT_MCP_ENTRY.replace(/\\/g, "\\\\")}']`,
    "-c",
    `mcp_servers.webot.env={WEBOT_SESSION_FILE='${sessionFile.replace(/\\/g, "\\\\")}'}`,
  ];
  const baseArgs = [
    ...mcpConfigArgs,
    ...modelArgs,
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
  ];
  const args = resumeSessionId
    ? ["exec", "resume", resumeSessionId, ...baseArgs, "-"]
    : ["exec", ...baseArgs, "-"];

  const spawnSpec = buildSpawnSpec(cfg.codex.command || "codex", args);
  const input = buildPrompt(cfg.behavior.systemPreamble, prompt, conversationMemory);
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    const child = spawn(spawnSpec.file, spawnSpec.args, {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    const events = [];

    function flushStdoutLines(force = false) {
      const parts = stdoutBuffer.split(/\r?\n/);
      const trailing = force ? parts.pop() ?? "" : "";
      stdoutBuffer = force ? "" : parts.pop() ?? "";
      const lines = force ? parts.filter(Boolean).concat(trailing ? [trailing] : []) : parts.filter(Boolean);
      for (const line of lines) {
        const event = parseJsonLine(line);
        if (!event) continue;
        events.push(event);
        if (onEvent) {
          Promise.resolve(onEvent(event)).catch(() => {});
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutBuffer += text;
      flushStdoutLines(false);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      flushStdoutLines(true);

      const outputText = readOutputText(outputFile);
      const stderrSummary = summarizeStderr(stderr);
      const agentMessages = events
        .filter((event) => event?.type === "item.completed" && event?.item?.type === "agent_message")
        .map((event) => event.item.text)
        .filter(Boolean);
      const lastAgentMessage = agentMessages.at(-1) || "";
      const detectedSession = findLatestSessionForWorkspace(workspacePath, startedAt);

      if (code !== 0) {
        reject(
          Object.assign(
            new Error(`codex exited with code ${code}${stderrSummary ? `\n${stderrSummary}` : ""}`),
            { code, stderr, resumeFailed: Boolean(resumeSessionId && isResumeFailure(stderr)) },
          ),
        );
        return;
      }

      resolve({
        text: outputText || lastAgentMessage || "Codex completed, but no reply text was captured.",
        stdout,
        stderr,
        events,
        sessionId: detectedSession?.id || resumeSessionId || "",
      });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
