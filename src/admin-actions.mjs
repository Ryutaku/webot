import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SRC_DIR, "..");

function normalizeText(text) {
  return String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function containsAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function mentionsSelf(text) {
  return containsAny(text, [
    /\bwebot\b/i,
    /\bbot\b/i,
    /自己/,
    /你自己/,
    /机器人/,
    /程序/,
    /服务/,
  ]);
}

export function detectAdminAction(rawText) {
  const text = normalizeText(rawText);
  if (!text) return null;

  if (text === "/stop") return { action: "stop" };
  if (text === "/status") return { action: "status" };

  const wantsStop = containsAny(text, [/\bstop\b/i, /停止/, /停掉/, /关闭/, /关掉/]);
  if (wantsStop && mentionsSelf(text)) {
    return { action: "stop" };
  }

  const wantsStatus = containsAny(text, [/\bstatus\b/i, /状态/, /还活着/, /运行了吗/, /在运行吗/, /在线吗/]);
  if (wantsStatus && mentionsSelf(text)) {
    return { action: "status" };
  }

  return null;
}

function runPowerShellScript(scriptName) {
  const scriptPath = path.join(PROJECT_ROOT, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Maintenance script not found: ${scriptPath}`);
  }

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      cwd: PROJECT_ROOT,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.unref();
}

function getLockStatus(stateDir) {
  const lockPath = path.join(stateDir, "webot.lock");
  if (!fs.existsSync(lockPath)) {
    return { running: false, pid: null };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    const pid = Number(payload?.pid);
    if (!pid) {
      return { running: false, pid: null };
    }
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}

export function buildAdminActionReply({ cfg, state, action }) {
  switch (action) {
    case "stop":
      runPowerShellScript("stop-webot.ps1");
      return "正在停止 Webot。停止后我不会再回复，直到你重新启动。";
    case "status": {
      const lock = getLockStatus(cfg.stateDir);
      const workspace = cfg.defaultWorkspace;
      const workspacePath = cfg.workspaces?.[workspace] || "";
      return [
        `Webot 当前正在运行${lock.pid ? `，PID ${lock.pid}` : ""}。`,
        `已绑定账号：${state.account?.accountId || "未绑定"}`,
        `默认工作区：${workspace || "未配置"}`,
        workspacePath ? `路径：${workspacePath}` : "",
      ].filter(Boolean).join("\n");
    }
    default:
      return "";
  }
}
