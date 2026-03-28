import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function pickFirstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function extractEncryptedQueryParamFromUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
  try {
    const parsed = new URL(rawUrl);
    return parsed.searchParams.get("encrypted_query_param")?.trim() || "";
  } catch {
    return "";
  }
}

function extractUploadParam(uploadInfo) {
  if (!uploadInfo || typeof uploadInfo !== "object") return "";
  return pickFirstString([
    uploadInfo.upload_param,
    uploadInfo.uploadParam,
    extractEncryptedQueryParamFromUrl(uploadInfo.upload_full_url),
    extractEncryptedQueryParamFromUrl(uploadInfo.uploadFullUrl),
    uploadInfo?.data?.upload_param,
    uploadInfo?.data?.uploadParam,
    extractEncryptedQueryParamFromUrl(uploadInfo?.data?.upload_full_url),
    extractEncryptedQueryParamFromUrl(uploadInfo?.data?.uploadFullUrl),
    uploadInfo?.upload?.upload_param,
    uploadInfo?.upload?.uploadParam,
    extractEncryptedQueryParamFromUrl(uploadInfo?.upload?.upload_full_url),
    extractEncryptedQueryParamFromUrl(uploadInfo?.upload?.uploadFullUrl),
    uploadInfo?.result?.upload_param,
    uploadInfo?.result?.uploadParam,
    extractEncryptedQueryParamFromUrl(uploadInfo?.result?.upload_full_url),
    extractEncryptedQueryParamFromUrl(uploadInfo?.result?.uploadFullUrl),
  ]);
}

function summarizeUploadInfo(uploadInfo) {
  try {
    const json = JSON.stringify(uploadInfo);
    return json.length <= 400 ? json : `${json.slice(0, 397)}...`;
  } catch {
    return String(uploadInfo);
  }
}

function getUploadMediaType(kind) {
  switch (kind) {
    case "image":
      return UPLOAD_MEDIA_TYPE.IMAGE;
    case "video":
      return UPLOAD_MEDIA_TYPE.VIDEO;
    default:
      return UPLOAD_MEDIA_TYPE.FILE;
  }
}

function canOptimizeImage(mime, filePath) {
  if (!mime.startsWith("image/")) return false;
  const ext = path.extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".bmp"].includes(ext);
}

function buildOptimizedImagePath(filePath) {
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(os.tmpdir(), `webot-${base}-${stamp}.jpg`);
}

function optimizeImageForWechat(filePath, maxDimension = 1600, quality = 85) {
  const optimizedPath = buildOptimizedImagePath(filePath);
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$src = [System.Drawing.Image]::FromFile('${filePath.replace(/'/g, "''")}')`,
    `$ratio = [Math]::Min(1.0, [Math]::Min(${maxDimension}.0 / [double]$src.Width, ${maxDimension}.0 / [double]$src.Height))`,
    "$newWidth = [Math]::Max(1, [int][Math]::Round($src.Width * $ratio))",
    "$newHeight = [Math]::Max(1, [int][Math]::Round($src.Height * $ratio))",
    "$bmp = New-Object System.Drawing.Bitmap($newWidth, $newHeight)",
    "$graphics = [System.Drawing.Graphics]::FromImage($bmp)",
    "$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
    "$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality",
    "$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality",
    "$graphics.Clear([System.Drawing.Color]::White)",
    "$graphics.DrawImage($src, 0, 0, $newWidth, $newHeight)",
    "$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1",
    "$params = New-Object System.Drawing.Imaging.EncoderParameters(1)",
    `$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${quality})`,
    `$bmp.Save('${optimizedPath.replace(/'/g, "''")}', $encoder, $params)`,
    "$params.Dispose()",
    "$graphics.Dispose()",
    "$bmp.Dispose()",
    "$src.Dispose()",
  ].join("; ");

  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return optimizedPath;
}

function prepareImagePathForWechat(filePath, mime, rawsize, maxDimension = 1600, quality = 85) {
  if (!canOptimizeImage(mime, filePath)) {
    return { filePath, cleanupPath: "" };
  }
  if (rawsize <= 1024 * 1024 && maxDimension >= 1600 && quality >= 85) {
    return { filePath, cleanupPath: "" };
  }

  const optimizedPath = optimizeImageForWechat(filePath, maxDimension, quality);
  const optimizedSize = fs.statSync(optimizedPath).size;
  if (optimizedSize >= rawsize) {
    try {
      fs.unlinkSync(optimizedPath);
    } catch {}
    return { filePath, cleanupPath: "" };
  }

  return { filePath: optimizedPath, cleanupPath: optimizedPath };
}

function isRetMinusOne(uploadInfo) {
  return Number(uploadInfo?.ret) === -1;
}

async function requestUploadUrlWithImageFallback({
  apiBaseUrl,
  token,
  routeTag,
  toUserId,
  sourceFilePath,
  sourceMime,
}) {
  const sourceSize = fs.statSync(sourceFilePath).size;
  const variants = sourceMime.startsWith("image/")
    ? [
        { maxDimension: 1600, quality: 85 },
        { maxDimension: 1280, quality: 75 },
        { maxDimension: 960, quality: 65 },
        { maxDimension: 800, quality: 55 },
      ]
    : [
        { maxDimension: 1600, quality: 85 },
      ];

  let lastAttempt = null;

  for (const variant of variants) {
    const prepared = prepareImagePathForWechat(
      sourceFilePath,
      sourceMime,
      sourceSize,
      variant.maxDimension,
      variant.quality,
    );

    try {
      const plaintext = fs.readFileSync(prepared.filePath);
      const rawsize = plaintext.length;
      const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
      const filesize = aesEcbPaddedSize(rawsize);
      const filekey = crypto.randomBytes(16).toString("hex");
      const aeskey = crypto.randomBytes(16);
      const mime = getMimeFromFilename(prepared.filePath);
      const chosenKind = mime.startsWith("image/")
        ? "image"
        : mime.startsWith("video/")
          ? "video"
          : "file";

      const uploadInfo = await getUploadUrl({
        apiBaseUrl,
        token,
        routeTag,
        filekey,
        mediaType: getUploadMediaType(chosenKind),
        toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        aeskey: aeskey.toString("hex"),
      });
      const uploadParam = extractUploadParam(uploadInfo);

      if (uploadParam) {
        return {
          prepared,
          plaintext,
          rawsize,
          filesize,
          filekey,
          aeskey,
          mime,
          chosenKind,
          uploadInfo,
          uploadParam,
        };
      }

      lastAttempt = {
        prepared,
        rawsize,
        chosenKind,
        uploadInfo,
      };

      if (!(chosenKind === "image" && isRetMinusOne(uploadInfo))) {
        break;
      }
    } catch (error) {
      if (prepared.cleanupPath) {
        try {
          fs.unlinkSync(prepared.cleanupPath);
        } catch {}
      }
      throw error;
    }
  }

  const preparedName = lastAttempt?.prepared?.filePath
    ? path.basename(lastAttempt.prepared.filePath)
    : path.basename(sourceFilePath);
  const chosenKind = lastAttempt?.chosenKind || (sourceMime.startsWith("image/") ? "image" : "file");
  throw new Error(
    `getUploadUrl returned no upload parameter for ${preparedName} as ${chosenKind}. Response: ${summarizeUploadInfo(lastAttempt?.uploadInfo)}`,
  );
}

function getExistingPathType(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
  } catch {
    return "missing";
  }
  return "other";
}

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
      if (getExistingPathType(candidate) !== "file") continue;
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
  const pathType = getExistingPathType(filePath);
  if (pathType === "missing") {
    throw new Error(`Local path does not exist: ${filePath}`);
  }
  if (pathType !== "file") {
    throw new Error(`Local path is not a file: ${filePath}`);
  }

  const originalMime = getMimeFromFilename(filePath);
  const uploadRequest = await requestUploadUrlWithImageFallback({
    apiBaseUrl,
    token,
    routeTag,
    toUserId,
    sourceFilePath: filePath,
    sourceMime: originalMime,
  });

  try {
    const { downloadParam } = await uploadBufferToCdn({
      buf: uploadRequest.plaintext,
      uploadParam: uploadRequest.uploadParam,
      filekey: uploadRequest.filekey,
      cdnBaseUrl: cdnBaseUrl || CDN_BASE_URL,
      aeskey: uploadRequest.aeskey,
    });

    return {
      kind: uploadRequest.chosenKind,
      fileName: path.basename(uploadRequest.prepared.filePath),
      mimeType: uploadRequest.mime,
      filekey: uploadRequest.filekey,
      downloadEncryptedQueryParam: downloadParam,
      aeskey: uploadRequest.aeskey.toString("hex"),
      fileSize: uploadRequest.rawsize,
      fileSizeCiphertext: uploadRequest.filesize,
    };
  } finally {
    if (uploadRequest.prepared.cleanupPath) {
      try {
        fs.unlinkSync(uploadRequest.prepared.cleanupPath);
      } catch {}
    }
  }
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
