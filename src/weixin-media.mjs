import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv } from "node:crypto";

import { getUploadUrl, sendFileMessage, sendImageMessage, sendVideoMessage } from "./weixin-api.mjs";

export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

const UPLOAD_MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
};

export function getMimeFromFilename(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    case ".webm":
      return "video/webm";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl.replace(/\/+$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadBufferToCdn({ buf, uploadParam, filekey, cdnBaseUrl, aeskey }) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const response = await fetch(buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }), {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(ciphertext),
  });

  if (response.status !== 200) {
    const detail = response.headers.get("x-error-message") || (await response.text());
    throw new Error(`CDN upload failed: ${response.status} ${detail}`);
  }

  const downloadParam = response.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN upload response missing x-encrypted-param header.");
  }

  return { downloadParam };
}

export function detectResultMediaPaths(text, workspacePath) {
  const targets = new Set();
  const patterns = [
    /!\[[^\]]*]\(([^)]+)\)/g,
    /\[[^\]]+]\(([^)]+)\)/g,
    /`([^`\r\n]+\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|mkv|webm|pdf|txt|json|zip))`/gi,
    /\b([^\s\\/:"*?<>|\r\n]+\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|mkv|webm|pdf|txt|json|zip))\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) targets.add(match[1]);
    }
  }

  const extRegex = /([A-Za-z]:\\[^\r\n]+?\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|mkv|webm|pdf|txt|json|zip)|\/[^\s)]+?\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|mkv|webm|pdf|txt|json|zip))/gi;
  for (const match of text.matchAll(extRegex)) {
    if (match[1]) targets.add(match[1]);
  }

  const resolved = [];
  for (const rawTarget of targets) {
    const trimmed = String(rawTarget).trim().replace(/^<|>$/g, "").replace(/^['"]|['"]$/g, "");
    if (!trimmed || /^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) continue;
    const normalized = trimmed.split("#")[0].replace(/%20/g, " ");
    const candidates = path.isAbsolute(normalized)
      ? [normalized]
      : [
          path.resolve(workspacePath, normalized),
          path.resolve(process.cwd(), normalized),
        ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      resolved.push(candidate);
      break;
    }
  }
  return [...new Set(resolved)];
}

function isMediaOrAttachmentPath(filePath) {
  return /\.(png|jpe?g|gif|webp|bmp|mp4|mov|mkv|webm|pdf|txt|json|zip)$/i.test(filePath);
}

function walkWorkspaceMedia(dirPath, sinceMs, acc, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "logs") continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkWorkspaceMedia(fullPath, sinceMs, acc, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isMediaOrAttachmentPath(fullPath)) continue;
    try {
      const stats = fs.statSync(fullPath);
      const touchedAt = Math.max(stats.mtimeMs, stats.birthtimeMs || 0);
      if (touchedAt >= sinceMs) {
        acc.push(fullPath);
      }
    } catch {
      // Ignore disappearing files.
    }
  }
}

export function detectNewWorkspaceMediaFiles(workspacePath, sinceMs) {
  const found = [];
  walkWorkspaceMedia(workspacePath, sinceMs, found, 0);
  return [...new Set(found)];
}

export async function uploadLocalMediaToWeixin({
  apiBaseUrl,
  token,
  routeTag,
  toUserId,
  filePath,
  cdnBaseUrl,
}) {
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const mime = getMimeFromFilename(filePath);

  const mediaType = mime.startsWith("image/")
    ? UPLOAD_MEDIA_TYPE.IMAGE
    : mime.startsWith("video/")
      ? UPLOAD_MEDIA_TYPE.VIDEO
      : UPLOAD_MEDIA_TYPE.FILE;

  const uploadInfo = await getUploadUrl({
    apiBaseUrl,
    token,
    routeTag,
    filekey,
    mediaType,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  });

  if (!uploadInfo?.upload_param) {
    throw new Error(`getUploadUrl returned no upload_param for ${path.basename(filePath)}.`);
  }

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam: uploadInfo.upload_param,
    filekey,
    cdnBaseUrl: cdnBaseUrl || CDN_BASE_URL,
    aeskey,
  });

  return {
    kind: mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file",
    fileName: path.basename(filePath),
    mimeType: mime,
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export async function sendLocalMediaFile({
  apiBaseUrl,
  token,
  routeTag,
  toUserId,
  contextToken,
  filePath,
  text = "",
  cdnBaseUrl,
}) {
  const uploaded = await uploadLocalMediaToWeixin({
    apiBaseUrl,
    token,
    routeTag,
    toUserId,
    filePath,
    cdnBaseUrl,
  });

  if (uploaded.kind === "image") {
    return sendImageMessage({
      apiBaseUrl,
      token,
      routeTag,
      toUserId,
      contextToken,
      text,
      uploaded,
    });
  }

  if (uploaded.kind === "video") {
    return sendVideoMessage({
      apiBaseUrl,
      token,
      routeTag,
      toUserId,
      contextToken,
      text,
      uploaded,
    });
  }

  return sendFileMessage({
    apiBaseUrl,
    token,
    routeTag,
    toUserId,
    contextToken,
    text,
    fileName: uploaded.fileName,
    uploaded,
  });
}
