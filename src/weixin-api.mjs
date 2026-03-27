import crypto from "node:crypto";

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf-8").toString("base64");
}

async function readJsonResponse(response, label) {
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText} ${rawText}`);
  }
  return rawText ? JSON.parse(rawText) : {};
}

function buildJsonHeaders({ token, body, routeTag }) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routeTag) headers.SKRouteTag = String(routeTag);
  return headers;
}

function buildBaseInfo() {
  return {
    channel_version: "standalone-0.1.0",
  };
}

function normalizeOutboundText(text) {
  let result = String(text || "");
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => String(code || "").trim());
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  result = result.replace(/^#{1,6}\s+/gm, "");
  result = result.replace(/^\s*[-*+]\s+/gm, "• ");
  result = result.replace(/^\s*\d+\.\s+/gm, "");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  result = result.replace(/_([^_]+)_/g, "$1");
  result = result.replace(/\r/g, "");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

function buildBaseMessage({ toUserId, contextToken }) {
  return {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: crypto.randomUUID(),
    message_type: 2,
    message_state: 2,
    context_token: contextToken || undefined,
  };
}

export async function fetchQrCode({ apiBaseUrl, botType, routeTag }) {
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, ensureTrailingSlash(apiBaseUrl));
  const headers = routeTag ? { SKRouteTag: String(routeTag) } : {};
  const response = await fetch(url, { headers });
  return readJsonResponse(response, "fetchQrCode");
}

export async function pollQrStatus({ apiBaseUrl, qrcode, routeTag, timeoutMs = 35000 }) {
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, ensureTrailingSlash(apiBaseUrl));
  const headers = {
    "iLink-App-ClientVersion": "1",
  };
  if (routeTag) headers.SKRouteTag = String(routeTag);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    return await readJsonResponse(response, "pollQrStatus");
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
}

export async function postWeixinJson({
  apiBaseUrl,
  endpoint,
  token,
  routeTag,
  body,
  timeoutMs = 15000,
}) {
  const payload = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(endpoint, ensureTrailingSlash(apiBaseUrl));
    const response = await fetch(url, {
      method: "POST",
      headers: buildJsonHeaders({ token, body: payload, routeTag }),
      body: payload,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await readJsonResponse(response, endpoint);
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${endpoint} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

export async function getUpdates({ apiBaseUrl, token, routeTag, cursor, timeoutMs = 35000 }) {
  return postWeixinJson({
    apiBaseUrl,
    endpoint: "ilink/bot/getupdates",
    token,
    routeTag,
    timeoutMs,
    body: {
      get_updates_buf: cursor || "",
      base_info: buildBaseInfo(),
    },
  });
}

export async function getUploadUrl({
  apiBaseUrl,
  token,
  routeTag,
  filekey,
  mediaType,
  toUserId,
  rawsize,
  rawfilemd5,
  filesize,
  aeskey,
  timeoutMs = 15000,
}) {
  return postWeixinJson({
    apiBaseUrl,
    endpoint: "ilink/bot/getuploadurl",
    token,
    routeTag,
    timeoutMs,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey,
      base_info: buildBaseInfo(),
    },
  });
}

export async function sendTextMessage({
  apiBaseUrl,
  token,
  routeTag,
  toUserId,
  text,
  contextToken,
}) {
  const plainText = normalizeOutboundText(text);
  return postWeixinJson({
    apiBaseUrl,
    endpoint: "ilink/bot/sendmessage",
    token,
    routeTag,
    body: {
      msg: {
        ...buildBaseMessage({ toUserId, contextToken }),
        item_list: [
          {
            type: 1,
            text_item: { text: plainText },
          },
        ],
      },
      base_info: buildBaseInfo(),
    },
  });
}

async function sendMediaMessage({
  apiBaseUrl,
  token,
  routeTag,
  toUserId,
  contextToken,
  text,
  mediaItem,
}) {
  if (text) {
    await sendTextMessage({
      apiBaseUrl,
      token,
      routeTag,
      toUserId,
      contextToken,
      text,
    });
  }

  return postWeixinJson({
    apiBaseUrl,
    endpoint: "ilink/bot/sendmessage",
    token,
    routeTag,
    body: {
      msg: {
        ...buildBaseMessage({ toUserId, contextToken }),
        item_list: [mediaItem],
      },
      base_info: buildBaseInfo(),
    },
  });
}

function encodeAesKeyForMedia(aeskeyHex) {
  return Buffer.from(aeskeyHex, "utf-8").toString("base64");
}

export async function sendImageMessage({
  apiBaseUrl,
  token,
  routeTag,
  toUserId,
  contextToken,
  text = "",
  uploaded,
}) {
  return sendMediaMessage({
    apiBaseUrl,
    token,
    routeTag,
    toUserId,
    contextToken,
    text,
    mediaItem: {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: encodeAesKeyForMedia(uploaded.aeskey),
          encrypt_type: 1,
        },
        mid_size: uploaded.fileSizeCiphertext,
      },
    },
  });
}

export async function sendVideoMessage({
  apiBaseUrl,
  token,
  routeTag,
  toUserId,
  contextToken,
  text = "",
  uploaded,
}) {
  return sendMediaMessage({
    apiBaseUrl,
    token,
    routeTag,
    toUserId,
    contextToken,
    text,
    mediaItem: {
      type: 5,
      video_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: encodeAesKeyForMedia(uploaded.aeskey),
          encrypt_type: 1,
        },
        video_size: uploaded.fileSizeCiphertext,
      },
    },
  });
}

export async function sendFileMessage({
  apiBaseUrl,
  token,
  routeTag,
  toUserId,
  contextToken,
  text = "",
  fileName,
  uploaded,
}) {
  return sendMediaMessage({
    apiBaseUrl,
    token,
    routeTag,
    toUserId,
    contextToken,
    text,
    mediaItem: {
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: encodeAesKeyForMedia(uploaded.aeskey),
          encrypt_type: 1,
        },
        file_name: fileName,
        len: String(uploaded.fileSize),
      },
    },
  });
}

export function extractPlainText(message) {
  const items = message?.item_list || [];
  for (const item of items) {
    if (item?.type === 1 && item?.text_item?.text != null) {
      return String(item.text_item.text).trim();
    }
    if (item?.type === 3 && item?.voice_item?.text != null) {
      return String(item.voice_item.text).trim();
    }
  }
  return "";
}
