import fs from "node:fs";
import path from "node:path";

const HOME_DIR = process.env.USERPROFILE || process.cwd();
const DEFAULT_STATE_DIR = path.join(HOME_DIR, ".webot");
const LEGACY_STATE_DIR = path.join(HOME_DIR, ".weixin-codex-bridge");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (!isObject(base) || !isObject(override)) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isObject(value) && isObject(base[key]) ? mergeDeep(base[key], value) : value;
  }
  return merged;
}

export function resolveConfigPath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.WX_CODEX_CONFIG) return path.resolve(process.env.WX_CODEX_CONFIG);
  const webotConfig = path.resolve(process.cwd(), "webot.config.json");
  if (fs.existsSync(webotConfig)) return webotConfig;
  return path.resolve(process.cwd(), "bridge.config.json");
}

export function loadConfig(explicitPath) {
  const configPath = resolveConfigPath(explicitPath);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}. Copy webot.config.example.json to webot.config.json first.`);
  }

  const raw = readJson(configPath);
  const defaults = {
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
    botType: "3",
    routeTag: "",
    allowedSenders: [],
    defaultWorkspace: "",
    workspaces: {},
    codex: {
      command: "codex",
      sandbox: "read-only",
      model: "",
      extraArgs: ["--skip-git-repo-check"],
    },
    behavior: {
      maxPromptChars: 12000,
      allowPlainTextPrompt: true,
      busyNotice: "Webot is already processing another request. Please try again shortly.",
      memory: {
        enabled: true,
        maxTurns: 12,
        maxChars: 4000,
        snippetChars: 280,
      },
      systemPreamble: [
        "You are operating inside Webot, a WeChat-facing Codex workflow.",
        "The user interacts with you through WeChat, not through the terminal.",
        "Your useful final result must reach the user in WeChat.",
        "You may have access to Webot MCP tools: webot_get_session_context, webot_send_text, webot_send_file, webot_send_image, webot_send_video, webot_send_paths, and webot_resolve_workspace_path.",
        "When the user expects to receive a file, image, video, screenshot, or other artifact in WeChat, you must use the Webot MCP delivery tools when available.",
        "When you send a file, image, video, or screenshot through Webot MCP, do not send an extra confirmation like 'sent to WeChat' or '已发到微信' unless the user explicitly asked for confirmation text.",
        "For media delivery, prefer sending the media itself without a caption unless a short caption is necessary for clarity.",
        "Do not treat a task as complete just because a file exists locally.",
        "Do not reply that a file is only in the workspace unless the user explicitly asked only for the local path.",
        "If you create or identify a local file that should be returned to the user and MCP delivery is unavailable, include one line per file exactly as: SEND_FILE: <path>.",
        "A task that requires delivery to the user is incomplete until the delivery tool call succeeds, or until you clearly provide a fallback path if tool delivery is unavailable.",
        "Prefer concise, result-oriented replies because the user is reading in WeChat.",
      ].join(" "),
      progressUpdates: {
        enabled: true,
        minIntervalMs: 4000,
        maxMessages: 8,
      },
    },
    media: {
      enabled: true,
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      upload: {
        mode: "auto",
        endpoint: "https://transfer.sh",
        maxBytes: 10 * 1024 * 1024,
      },
    },
    stateDir: DEFAULT_STATE_DIR,
  };

  const cfg = mergeDeep(defaults, raw);
  cfg.configPath = configPath;
  cfg.stateDir = path.resolve(cfg.stateDir || DEFAULT_STATE_DIR);
  cfg.legacyStateDir = LEGACY_STATE_DIR;
  if (!cfg.defaultWorkspace) {
    cfg.defaultWorkspace = Object.keys(cfg.workspaces)[0] || "";
  }
  if (!cfg.defaultWorkspace || !cfg.workspaces[cfg.defaultWorkspace]) {
    throw new Error("Config must define at least one workspace and a valid defaultWorkspace.");
  }
  return cfg;
}
