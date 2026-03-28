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
      model: "gpt-5.4-mini",
      sessionReuse: true,
      sessionReset: {
        enabled: false,
        maxInputTokens: 300000,
        maxUncachedInputTokens: 5000,
      },
      extraArgs: ["--skip-git-repo-check"],
    },
    behavior: {
      maxPromptChars: 12000,
      allowPlainTextPrompt: true,
      outboundContextToken: false,
      busyNotice: "Webot is already processing another request. Please try again shortly.",
      memory: {
        enabled: true,
        maxTurns: 6,
        maxChars: 1200,
        snippetChars: 120,
        includeAssistant: false,
      },
      systemPreamble: [
        "You are running inside Webot for a WeChat user.",
        "Reply concisely.",
        "If the user expects a file, image, video, or screenshot in WeChat, use Webot MCP delivery tools when available.",
        "Do not consider the task complete until required delivery succeeds.",
        "Do not mention local-only paths unless the user asked for them.",
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
