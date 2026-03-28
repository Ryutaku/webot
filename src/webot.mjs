import fs from "node:fs";
import path from "node:path";

import { buildAdminActionReply, detectAdminAction } from "./admin-actions.mjs";
import { runCodexPrompt } from "./codex-runner.mjs";
import {
  appendCodexUsage,
  appendUserMemoryTurn,
  clearCodexSession,
  buildUserMemoryPrompt,
  getCodexSession,
  clearUserWorkspace,
  getUserSession,
  getUserWorkspace,
  pruneUserSessions,
  rememberMessage,
  rememberUserSession,
  saveState,
  updateCodexSessionUsage,
  setUserWorkspace,
} from "./state.mjs";
import { extractPlainText, getUpdates, sendTextMessage } from "./weixin-api.mjs";
import { sendLocalMediaFile } from "./weixin-media.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkText(text, maxLen = 3800) {
  if (!text) return [""];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

function shortenCommand(command, maxLen = 100) {
  if (!command) return "";
  return command.length <= maxLen ? command : `${command.slice(0, maxLen - 3)}...`;
}

function sanitizeProgressText(text, maxLen = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxLen ? normalized : `${normalized.slice(0, maxLen - 3)}...`;
}

function formatTokenCount(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatHitRate(cachedTokens, inputTokens) {
  const input = Number(inputTokens || 0);
  if (!input) return "0.0%";
  const cached = Number(cachedTokens || 0);
  return `${((cached / input) * 100).toFixed(1)}%`;
}

function normalizeNewSessionDirective(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { requested: false, prompt: "" };
  }

  const match = raw.match(
    /^(?:请|帮我|麻烦)?(?:重新|再次)?(?:新开|新建|开启|打开|重开)(?:一个|个)?(?:codex)?(?:会话|新会话|对话)(?:吧|一下|一下子)?[：:，,\s。-]*/i,
  );
  if (!match) {
    return { requested: false, prompt: raw };
  }

  return {
    requested: true,
    prompt: raw.slice(match[0].length).trim(),
  };
}

function resolveWorkspace(cfg, state, fromUserId, rawText) {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("/repo ")) {
    const [, workspaceKey, ...rest] = trimmed.split(/\s+/);
    return {
      workspaceKey,
      prompt: rest.join(" ").trim(),
    };
  }
  return {
    workspaceKey: getUserWorkspace(state, fromUserId, cfg.defaultWorkspace),
    prompt: trimmed,
  };
}

function resolveDirectMediaRequest(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  if (!/(发给我|传给我|发我|传我|send me)/i.test(text)) return null;

  const directPathMatch = text.match(/([A-Za-z]:\\[^\r\n]+?\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|mkv|webm|pdf|txt|json|zip))/i);
  if (directPathMatch?.[1]) return directPathMatch[1];

  const rootDriveMatch = text.match(/([A-Za-z])盘根目录(?:下)?(?:的)?([^\s，。！？]+?\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|mkv|webm|pdf|txt|json|zip))/i);
  if (rootDriveMatch?.[1] && rootDriveMatch?.[2]) {
    return `${rootDriveMatch[1].toUpperCase()}:\\${rootDriveMatch[2]}`;
  }

  return null;
}

function buildHelp(cfg) {
  const workspaceList = Object.keys(cfg.workspaces).join(", ");
  return [
    "Available commands:",
    "/help Show this help",
    "/repos List workspaces",
    "/use <name> Set the current chat workspace",
    "/where Show the current workspace",
    "/reset Clear the current chat workspace preference",
    "/repo <name> <prompt> Run a prompt in a specific workspace",
    "/stop Stop Webot locally",
    "/status Show Webot runtime status",
    "Plain text messages are treated as prompts in the current workspace.",
    "Send '新开会话' / '新建会话' / '开启新会话' to force a fresh Codex session.",
    `Workspaces: ${workspaceList}`,
  ].join("\n");
}

function writeMcpSessionContext({ cfg, state, message, workspacePath }) {
  const stateDir = cfg.stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  const sessionFile = path.join(stateDir, "mcp-session.json");
  const session = getUserSession(state, message.from_user_id);
  const payload = {
    apiBaseUrl: state.account.baseUrl || cfg.apiBaseUrl,
    token: state.account.token,
    routeTag: cfg.routeTag || "",
    toUserId: message.from_user_id,
    contextToken: cfg.behavior?.outboundContextToken === true
      ? (message.context_token || session?.contextToken || "")
      : "",
    cdnBaseUrl: cfg.media?.cdnBaseUrl || "",
    workspacePath,
    accountId: state.account.accountId || "",
    stateDir,
    configPath: cfg.configPath,
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function resolveMessageContextToken(state, message) {
  return message.context_token || getUserSession(state, message.from_user_id)?.contextToken || "";
}

function resolveOutboundContextToken(cfg, state, message) {
  if (cfg.behavior?.outboundContextToken !== true) return "";
  return resolveMessageContextToken(state, message);
}

function getConversationMemory(cfg, state, fromUserId) {
  const settings = cfg.behavior?.memory || {};
  if (settings.enabled === false) return "";
  return buildUserMemoryPrompt(state, fromUserId, settings);
}

function formatUsageForLog(usage) {
  if (!usage) return "";
  return [
    `input=${usage.inputTokens}`,
    `cached=${usage.cachedInputTokens}`,
    `uncached=${usage.uncachedInputTokens}`,
    `output=${usage.outputTokens}`,
    `total=${usage.totalTokens}`,
    `hit=${formatHitRate(usage.cachedInputTokens, usage.inputTokens)}`,
  ].join(" ");
}

async function runCodexWithSession({
  cfg,
  state,
  fromUserId,
  workspaceKey,
  workspacePath,
  prompt,
  conversationMemory,
  onEvent,
  forceNewSession = false,
}) {
  const reuseEnabled = cfg.codex?.sessionReuse !== false;
  const existingSession = reuseEnabled && !forceNewSession ? getCodexSession(state, fromUserId, workspaceKey) : null;

  try {
    const result = await runCodexPrompt({
      cfg,
      workspacePath,
      prompt,
      conversationMemory: existingSession ? "" : conversationMemory,
      resumeSessionId: existingSession?.id || "",
      onEvent,
    });
    return result;
  } catch (error) {
    if (existingSession && error?.resumeFailed) {
      clearCodexSession(state, fromUserId, workspaceKey);
      const retry = await runCodexPrompt({
        cfg,
        workspacePath,
        prompt,
        conversationMemory,
        onEvent,
      });
      return retry;
    }
    throw error;
  }
}

function summarizeMcpDelivery(events = []) {
  const toolCalls = events
    .filter((event) => event?.type === "item.completed" && event?.item?.type === "mcp_tool_call" && event?.item?.server === "webot")
    .map((event) => event.item.tool)
    .filter(Boolean);

  return {
    sentText: toolCalls.includes("webot_send_text"),
    sentMedia: toolCalls.some((tool) => [
      "webot_send_file",
      "webot_send_image",
      "webot_send_video",
      "webot_send_paths",
    ].includes(tool)),
  };
}

function createProgressReporter({ cfg, state, message }) {
  const settings = cfg.behavior?.progressUpdates || {};
  const enabled = settings.enabled !== false;
  const minIntervalMs = Number(settings.minIntervalMs || 4000);
  const maxMessages = Number(settings.maxMessages || 8);
  let sentCount = 0;
  let lastSentAt = 0;
  let lastText = "";
  let sentCommandProgress = false;

  async function send(text, force = false) {
    if (!enabled) return;
    const normalized = sanitizeProgressText(text);
    if (!normalized) return;
    if (normalized === lastText) return;

    const now = Date.now();
    if (!force && sentCount > 0 && now - lastSentAt < minIntervalMs) {
      return;
    }
    if (!force && sentCount >= maxMessages) {
      return;
    }

    await sendTextMessage({
      apiBaseUrl: state.account.baseUrl || cfg.apiBaseUrl,
      token: state.account.token,
      routeTag: cfg.routeTag,
      toUserId: message.from_user_id,
      contextToken: message.context_token,
      text: normalized,
    });
    sentCount += 1;
    lastSentAt = now;
    lastText = normalized;
  }

  return {
    async onEvent(_event) {
      if (!enabled) return;
      return;
    },
  };
}

async function sendReply(cfg, state, message, text) {
  const contextToken = resolveOutboundContextToken(cfg, state, message);
  for (const chunk of chunkText(text)) {
    const response = await sendTextMessage({
      apiBaseUrl: state.account.baseUrl || cfg.apiBaseUrl,
      token: state.account.token,
      routeTag: cfg.routeTag,
      toUserId: message.from_user_id,
      contextToken,
      text: chunk,
    });
    console.log([
      "[wechat-send]",
      `to=${message.from_user_id}`,
      `context=${contextToken ? "yes" : "no"}`,
      `len=${chunk.length}`,
      `resp=${JSON.stringify(response || {})}`,
    ].join(" "));
  }
}

async function handleCommand({ cfg, state, message, rawText }) {
  const fromUserId = message.from_user_id;
  const [command, ...rest] = rawText.trim().split(/\s+/);

  switch (command) {
    case "/help":
      await sendReply(cfg, state, message, buildHelp(cfg));
      return true;
    case "/repos":
      await sendReply(
        cfg,
        state,
        message,
        `Workspaces:\n${Object.entries(cfg.workspaces).map(([name, dir]) => `${name}: ${dir}`).join("\n")}`,
      );
      return true;
    case "/use": {
      const workspace = rest[0];
      if (!workspace || !cfg.workspaces[workspace]) {
        await sendReply(cfg, state, message, "Workspace not found. Use /repos to see the available names.");
        return true;
      }
      setUserWorkspace(state, fromUserId, workspace);
      saveState(cfg.stateDir, state);
      await sendReply(cfg, state, message, `Current workspace for this chat is now ${workspace}.`);
      return true;
    }
    case "/where": {
      const workspace = getUserWorkspace(state, fromUserId, cfg.defaultWorkspace);
      await sendReply(cfg, state, message, `Current workspace: ${workspace}\nPath: ${cfg.workspaces[workspace]}`);
      return true;
    }
    case "/reset":
      clearUserWorkspace(state, fromUserId);
      saveState(cfg.stateDir, state);
      await sendReply(cfg, state, message, `Workspace preference cleared. Default workspace is ${cfg.defaultWorkspace}.`);
      return true;
    default:
      return false;
  }
}

function ensureAllowedSender(cfg, fromUserId) {
  return !cfg.allowedSenders?.length || cfg.allowedSenders.includes(fromUserId);
}

export async function processIncomingMessage({ cfg, state, message, busyRef }) {
  if (message?.message_type === 2) return;
  if (rememberMessage(state, message?.message_id)) return;

  const fromUserId = message?.from_user_id || "";
  if (!fromUserId) return;
  if (!ensureAllowedSender(cfg, fromUserId)) return;

  rememberUserSession(state, fromUserId, {
    contextToken: message?.context_token || "",
    lastMessageId: String(message?.message_id || ""),
  });
  pruneUserSessions(state);

  const rawText = extractPlainText(message);
  if (!rawText) return;

  const adminAction = detectAdminAction(rawText);
  if (adminAction) {
    try {
      const reply = buildAdminActionReply({ cfg, state, action: adminAction.action });
      if (reply) {
        await sendReply(cfg, state, message, reply);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await sendReply(cfg, state, message, `Admin action failed:\n${detail}`);
    }
    return;
  }

  if (rawText.startsWith("/")) {
    const handled = await handleCommand({ cfg, state, message, rawText });
    if (handled) return;
  }

  const { workspaceKey, prompt: rawPrompt } = resolveWorkspace(cfg, state, fromUserId, rawText);
  const resolvedNewSession = normalizeNewSessionDirective(rawPrompt);

  if (resolvedNewSession.requested && !resolvedNewSession.prompt) {
    if (workspaceKey && cfg.workspaces[workspaceKey]) {
      clearCodexSession(state, fromUserId, workspaceKey);
      saveState(cfg.stateDir, state);
    }
    await sendReply(cfg, state, message, "已清空当前 Codex 会话。下一条消息会使用新会话。");
    return;
  }

  const directMediaPath = resolveDirectMediaRequest(rawText);
  if (directMediaPath) {
    if (!directMediaPath || !/\.[A-Za-z0-9]+$/.test(directMediaPath)) {
      await sendReply(cfg, state, message, "I could not resolve the file path.");
      return;
    }
    try {
      const contextToken = resolveOutboundContextToken(cfg, state, message);
      await sendLocalMediaFile({
        apiBaseUrl: state.account.baseUrl || cfg.apiBaseUrl,
        token: state.account.token,
        routeTag: cfg.routeTag,
        toUserId: message.from_user_id,
        contextToken,
        filePath: directMediaPath,
        cdnBaseUrl: cfg.media?.cdnBaseUrl,
      });
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await sendReply(cfg, state, message, `Direct send failed:\n${detail}`);
      return;
    }
  }

  if (!cfg.behavior.allowPlainTextPrompt && !rawText.startsWith("/repo ")) {
    await sendReply(cfg, state, message, "Plain text prompts are disabled. Use /repo <name> <prompt> instead.");
    return;
  }

  if (!workspaceKey || !cfg.workspaces[workspaceKey]) {
    await sendReply(cfg, state, message, "No valid workspace is configured. Check webot.config.json.");
    return;
  }
  const sessionRequested = resolvedNewSession.requested;
  const prompt = sessionRequested ? resolvedNewSession.prompt : rawPrompt;
  if (!prompt) {
    if (sessionRequested) {
      await sendReply(cfg, state, message, "已准备新会话，但没有检测到可执行的提示词。下一条消息会使用新会话。");
      return;
    }
    await sendReply(cfg, state, message, "The prompt is empty.");
    return;
  }
  if (prompt.length > cfg.behavior.maxPromptChars) {
    await sendReply(cfg, state, message, `The prompt is too long. Current limit: ${cfg.behavior.maxPromptChars} characters.`);
    return;
  }
  if (busyRef.busy) {
    await sendReply(cfg, state, message, cfg.behavior.busyNotice);
    return;
  }

  if (sessionRequested) {
    clearCodexSession(state, fromUserId, workspaceKey);
  }

  busyRef.busy = true;
  const workspacePath = cfg.workspaces[workspaceKey];
  const progress = createProgressReporter({ cfg, state, message });
  const conversationMemory = getConversationMemory(cfg, state, fromUserId);

  try {
    writeMcpSessionContext({ cfg, state, message, workspacePath });
    const result = await runCodexWithSession({
      cfg,
      state,
      fromUserId,
      workspaceKey,
      workspacePath,
      prompt,
      conversationMemory,
      onEvent: (event) => progress.onEvent(event),
      forceNewSession: sessionRequested,
    });
    const delivery = summarizeMcpDelivery(result.events);
    if (result.usage) {
      appendCodexUsage(state, {
        fromUserId,
        workspaceKey,
        sessionId: result.sessionId || "",
        ...result.usage,
      });
      console.log(`[codex-usage] user=${fromUserId} workspace=${workspaceKey} ${formatUsageForLog(result.usage)}`);
    }
    if (result.usage || result.sessionId) {
      const sessionRecord = updateCodexSessionUsage(
        state,
        fromUserId,
        workspaceKey,
        {
          id: result.sessionId || "",
          workspacePath,
        },
        result.usage || {},
      );
      if (result.usage) {
        sessionRecord.lastTurnUsage = { ...result.usage };
      }
    }
    appendUserMemoryTurn(state, fromUserId, "user", prompt, cfg.behavior?.memory || {});
    appendUserMemoryTurn(state, fromUserId, "assistant", result.text, cfg.behavior?.memory || {});
    // If Codex already delivered media through Webot MCP, do not mirror the
    // model's final text back into WeChat. That final text is often just a
    // tool/action acknowledgment such as "send_file".
    if (!delivery.sentText && !delivery.sentMedia) {
      await sendReply(cfg, state, message, result.text);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await sendReply(cfg, state, message, `Execution failed:\n${detail}`);
  } finally {
    busyRef.busy = false;
  }
}

export async function startWebot({ cfg, state }) {
  if (!state.account?.token) {
    throw new Error("No linked Weixin account found. Run login first.");
  }

  const busyRef = { busy: false };
  console.log(`Listening as ${state.account.accountId} ...`);

  while (true) {
    try {
      const resp = await getUpdates({
        apiBaseUrl: state.account.baseUrl || cfg.apiBaseUrl,
        token: state.account.token,
        routeTag: cfg.routeTag,
        cursor: state.cursor,
      });

      if (resp?.get_updates_buf) {
        state.cursor = resp.get_updates_buf;
        saveState(cfg.stateDir, state);
      }

      for (const message of resp?.msgs || []) {
        await processIncomingMessage({ cfg, state, message, busyRef });
        saveState(cfg.stateDir, state);
      }
    } catch (error) {
      console.error(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(3000);
    }
  }
}
