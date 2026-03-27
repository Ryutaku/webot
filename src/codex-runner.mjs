import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export async function runCodexPrompt({ cfg, workspacePath, prompt, conversationMemory = "", onEvent }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-"));
  const outputFile = path.join(tempDir, "last-message.txt");
  const args = [
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
    "-",
  ];

  if (cfg.codex.model) {
    args.splice(1, 0, "--model", cfg.codex.model);
  }

  const spawnSpec = buildSpawnSpec(cfg.codex.command || "codex", args);
  const input = buildPrompt(cfg.behavior.systemPreamble, prompt, conversationMemory);

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

      const outputText = fs.existsSync(outputFile)
        ? fs.readFileSync(outputFile, "utf-8").trim()
        : "";
      const stderrSummary = summarizeStderr(stderr);
      const agentMessages = events
        .filter((event) => event?.type === "item.completed" && event?.item?.type === "agent_message")
        .map((event) => event.item.text)
        .filter(Boolean);
      const lastAgentMessage = agentMessages.at(-1) || "";

      if (code !== 0) {
        reject(
          new Error(
            `codex exited with code ${code}${stderrSummary ? `\n${stderrSummary}` : ""}`,
          ),
        );
        return;
      }

      resolve({
        text: outputText || lastAgentMessage || "Codex completed, but no reply text was captured.",
        stdout,
        stderr,
        events,
      });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
