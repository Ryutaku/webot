#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { loadConfig } from "./config.mjs";
import { loadState } from "./state.mjs";
import { sendTextMessage } from "./weixin-api.mjs";
import { sendLocalMediaFile } from "./weixin-media.mjs";

function loadSessionContext() {
  const sessionFile = process.env.WEBOT_SESSION_FILE?.trim();
  let fileSession = {};

  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      fileSession = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    } catch (error) {
      throw new Error(`Failed to read WEBOT_SESSION_FILE ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ...fileSession,
    apiBaseUrl: process.env.WEBOT_API_BASE_URL?.trim() || fileSession.apiBaseUrl || "",
    token: process.env.WEBOT_TOKEN?.trim() || fileSession.token || "",
    routeTag: process.env.WEBOT_ROUTE_TAG?.trim() || fileSession.routeTag || "",
    toUserId: process.env.WEBOT_TO_USER_ID?.trim() || fileSession.toUserId || "",
    contextToken: process.env.WEBOT_CONTEXT_TOKEN?.trim() || fileSession.contextToken || "",
    cdnBaseUrl: process.env.WEBOT_CDN_BASE_URL?.trim() || fileSession.cdnBaseUrl || "",
    workspacePath: process.env.WEBOT_WORKSPACE_PATH?.trim() || fileSession.workspacePath || "",
    accountId: process.env.WEBOT_ACCOUNT_ID?.trim() || fileSession.accountId || "",
    stateDir: process.env.WEBOT_STATE_DIR?.trim() || fileSession.stateDir || "",
    configPath: process.env.WEBOT_CONFIG_PATH?.trim() || fileSession.configPath || "",
  };
}

function buildResolvedContext() {
  const raw = loadSessionContext();
  const cfg = loadConfig(raw.configPath || undefined);
  const stateDir = raw.stateDir || cfg.stateDir;
  const state = loadState(stateDir);

  return {
    apiBaseUrl: raw.apiBaseUrl || state.account?.baseUrl || cfg.apiBaseUrl,
    token: raw.token || state.account?.token || "",
    routeTag: raw.routeTag || cfg.routeTag || "",
    toUserId: raw.toUserId || state.account?.userId || "",
    contextToken: raw.contextToken || "",
    cdnBaseUrl: raw.cdnBaseUrl || cfg.media?.cdnBaseUrl || "",
    workspacePath: raw.workspacePath || cfg.workspaces?.[cfg.defaultWorkspace] || process.cwd(),
    accountId: raw.accountId || state.account?.accountId || "",
    stateDir,
    configPath: cfg.configPath,
  };
}

function assertSendContext(context) {
  if (!context.apiBaseUrl) throw new Error("Missing apiBaseUrl in webot session context.");
  if (!context.token) throw new Error("Missing token in webot session context.");
  if (!context.toUserId) throw new Error("Missing toUserId in webot session context.");
}

function resolveUserPath(inputPath, workspacePath) {
  if (!inputPath) throw new Error("Path is required.");
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(workspacePath || process.cwd(), inputPath);
}

function getFileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".mkv", ".webm"].includes(ext)) return "video";
  return "file";
}

function getPathStatus(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return {
      exists: true,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
    };
  } catch {
    return {
      exists: false,
      isDirectory: false,
      isFile: false,
    };
  }
}

function isLowValueWechatAck(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;

  const exactMatches = new Set([
    "sent",
    "done",
    "ok",
    "sent to wechat",
    "already sent to wechat",
    "send_file",
    "sent_file",
    "send image",
    "sent image",
    "send video",
    "sent video",
    "已发送",
    "已发送。",
  ]);
  if (exactMatches.has(normalized)) return true;

  return [
    "sent to wechat",
    "already sent to wechat",
    "已发到微信",
    "已经发到微信",
    "已发送到微信",
    "已发微信",
    "send_file",
    "sent_file",
    "send image",
    "sent image",
    "send video",
    "sent video",
  ].some((prefix) => normalized.startsWith(prefix));
}

async function sendResolvedFile({ context, resolvedPath, caption = "" }) {
  assertSendContext(context);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  await sendLocalMediaFile({
    apiBaseUrl: context.apiBaseUrl,
    token: context.token,
    routeTag: context.routeTag,
    toUserId: context.toUserId,
    contextToken: context.contextToken,
    filePath: resolvedPath,
    text: caption,
    cdnBaseUrl: context.cdnBaseUrl,
  });

  return {
    ok: true,
    toUserId: context.toUserId,
    resolvedPath,
    kind: getFileKind(resolvedPath),
  };
}

const server = new McpServer({
  name: "webot-mcp",
  version: "0.1.0",
});

server.registerTool(
  "webot_get_session_context",
  {
    description: "Return the current Webot WeChat session context available to the agent, including the active recipient, workspace path, and config path.",
    inputSchema: {},
    outputSchema: {
      accountId: z.string(),
      toUserId: z.string(),
      hasContextToken: z.boolean(),
      workspacePath: z.string(),
      configPath: z.string(),
      stateDir: z.string(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const context = buildResolvedContext();
    const structuredContent = {
      accountId: context.accountId || "",
      toUserId: context.toUserId || "",
      hasContextToken: Boolean(context.contextToken),
      workspacePath: context.workspacePath || "",
      configPath: context.configPath || "",
      stateDir: context.stateDir || "",
    };

    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
);

server.registerTool(
  "webot_send_text",
  {
    description: "Send a plain text message back to the current WeChat user through Webot. Use this only for substantive user-facing content, not for low-value confirmations like 'sent to WeChat'.",
    inputSchema: {
      text: z.string().min(1).describe("Text to send back to the current WeChat user."),
    },
    outputSchema: {
      ok: z.boolean(),
      toUserId: z.string(),
      textLength: z.number(),
      skipped: z.boolean(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ text }) => {
    const context = buildResolvedContext();
    assertSendContext(context);

    if (isLowValueWechatAck(text)) {
      const structuredContent = {
        ok: true,
        toUserId: context.toUserId,
        textLength: 0,
        skipped: true,
      };
      return {
        content: [{ type: "text", text: "Skipped low-value confirmation text." }],
        structuredContent,
      };
    }

    await sendTextMessage({
      apiBaseUrl: context.apiBaseUrl,
      token: context.token,
      routeTag: context.routeTag,
      toUserId: context.toUserId,
      contextToken: context.contextToken,
      text,
    });

    const structuredContent = {
      ok: true,
      toUserId: context.toUserId,
      textLength: text.length,
      skipped: false,
    };

    return {
      content: [{ type: "text", text: `Sent text to ${context.toUserId}.` }],
      structuredContent,
    };
  },
);

server.registerTool(
  "webot_send_file",
  {
    description: "Send a local file, image, or video back to the current WeChat user through Webot. Relative paths are resolved against the active workspace.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path, or a path relative to the active workspace."),
      caption: z.string().optional().describe("Optional caption to send before the file."),
    },
    outputSchema: {
      ok: z.boolean(),
      toUserId: z.string(),
      resolvedPath: z.string(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ filePath, caption }) => {
    const context = buildResolvedContext();
    const resolvedPath = resolveUserPath(filePath, context.workspacePath);
    const structuredContent = await sendResolvedFile({
      context,
      resolvedPath,
      caption: caption || "",
    });

    return {
      content: [{ type: "text", text: `Sent file ${resolvedPath} to ${context.toUserId}.` }],
      structuredContent,
    };
  },
);

server.registerTool(
  "webot_send_image",
  {
    description: "Send a local image back to the current WeChat user. Use this when the result is specifically an image.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path, or a path relative to the active workspace."),
      caption: z.string().optional().describe("Optional caption to send before the image."),
    },
    outputSchema: {
      ok: z.boolean(),
      toUserId: z.string(),
      resolvedPath: z.string(),
      kind: z.literal("image"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ filePath, caption }) => {
    const context = buildResolvedContext();
    const resolvedPath = resolveUserPath(filePath, context.workspacePath);
    if (getFileKind(resolvedPath) !== "image") {
      throw new Error(`Path is not an image file: ${resolvedPath}`);
    }
    const structuredContent = await sendResolvedFile({
      context,
      resolvedPath,
      caption: caption || "",
    });
    return {
      content: [{ type: "text", text: `Sent image ${resolvedPath} to ${context.toUserId}.` }],
      structuredContent,
    };
  },
);

server.registerTool(
  "webot_send_video",
  {
    description: "Send a local video back to the current WeChat user. Use this when the result is specifically a video.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path, or a path relative to the active workspace."),
      caption: z.string().optional().describe("Optional caption to send before the video."),
    },
    outputSchema: {
      ok: z.boolean(),
      toUserId: z.string(),
      resolvedPath: z.string(),
      kind: z.literal("video"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ filePath, caption }) => {
    const context = buildResolvedContext();
    const resolvedPath = resolveUserPath(filePath, context.workspacePath);
    if (getFileKind(resolvedPath) !== "video") {
      throw new Error(`Path is not a video file: ${resolvedPath}`);
    }
    const structuredContent = await sendResolvedFile({
      context,
      resolvedPath,
      caption: caption || "",
    });
    return {
      content: [{ type: "text", text: `Sent video ${resolvedPath} to ${context.toUserId}.` }],
      structuredContent,
    };
  },
);

server.registerTool(
  "webot_send_paths",
  {
    description: "Send multiple local files back to the current WeChat user in order. Relative paths are resolved against the active workspace.",
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).describe("List of absolute or workspace-relative file paths."),
      caption: z.string().optional().describe("Optional caption sent before the first file only."),
    },
    outputSchema: {
      ok: z.boolean(),
      count: z.number(),
      toUserId: z.string(),
      sent: z.array(z.object({
        resolvedPath: z.string(),
        kind: z.enum(["image", "video", "file"]),
      })),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ paths, caption }) => {
    const context = buildResolvedContext();
    const sent = [];

    for (let i = 0; i < paths.length; i += 1) {
      const resolvedPath = resolveUserPath(paths[i], context.workspacePath);
      const result = await sendResolvedFile({
        context,
        resolvedPath,
        caption: i === 0 ? (caption || "") : "",
      });
      sent.push({
        resolvedPath: result.resolvedPath,
        kind: result.kind,
      });
    }

    const structuredContent = {
      ok: true,
      count: sent.length,
      toUserId: context.toUserId,
      sent,
    };

    return {
      content: [{ type: "text", text: `Sent ${sent.length} file(s) to ${context.toUserId}.` }],
      structuredContent,
    };
  },
);

server.registerTool(
  "webot_resolve_workspace_path",
  {
    description: "Resolve a possibly relative path against the active workspace and report whether it exists. Use this before sending a file if you are unsure about the final path.",
    inputSchema: {
      filePath: z.string().min(1).describe("Absolute path, or a path relative to the active workspace."),
    },
    outputSchema: {
      inputPath: z.string(),
      resolvedPath: z.string(),
      exists: z.boolean(),
      isDirectory: z.boolean(),
      isFile: z.boolean(),
      kind: z.enum(["image", "video", "file"]),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath }) => {
    const context = buildResolvedContext();
    const resolvedPath = resolveUserPath(filePath, context.workspacePath);
    const status = getPathStatus(resolvedPath);
    const structuredContent = {
      inputPath: filePath,
      resolvedPath,
      exists: status.exists,
      isDirectory: status.isDirectory,
      isFile: status.isFile,
      kind: getFileKind(resolvedPath),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
