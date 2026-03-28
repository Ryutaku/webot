import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultState() {
  return {
    account: null,
    cursor: "",
    codexSessions: {},
    userPrefs: {},
    userSessions: {},
    recentMessageIds: [],
  };
}

export function ensureStateDir(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
}

function migrateLegacyStateIfNeeded(stateDir) {
  const legacyDir = path.join(process.env.USERPROFILE || process.cwd(), ".weixin-codex-bridge");
  if (path.resolve(stateDir) === path.resolve(legacyDir)) return;

  const stateFile = resolveStateFile(stateDir);
  const legacyFile = resolveStateFile(legacyDir);
  if (fs.existsSync(stateFile) || !fs.existsSync(legacyFile)) return;

  fs.mkdirSync(stateDir, { recursive: true });
  fs.copyFileSync(legacyFile, stateFile);
}

export function resolveStateFile(stateDir) {
  return path.join(stateDir, "state.json");
}

export function loadState(stateDir) {
  migrateLegacyStateIfNeeded(stateDir);
  ensureStateDir(stateDir);
  const filePath = resolveStateFile(stateDir);
  if (!fs.existsSync(filePath)) {
    const initial = defaultState();
    saveState(stateDir, initial);
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return { ...defaultState(), ...parsed };
  } catch {
    const fallback = defaultState();
    saveState(stateDir, fallback);
    return fallback;
  }
}

export function saveState(stateDir, state) {
  ensureStateDir(stateDir);
  const filePath = resolveStateFile(stateDir);
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}${os.EOL}`, "utf-8");
}

export function rememberMessage(state, messageId) {
  if (!messageId) return false;
  const key = String(messageId);
  if (state.recentMessageIds.includes(key)) return true;
  state.recentMessageIds.push(key);
  if (state.recentMessageIds.length > 200) {
    state.recentMessageIds = state.recentMessageIds.slice(-200);
  }
  return false;
}

export function getUserWorkspace(state, fromUserId, fallbackWorkspace) {
  return state.userPrefs[fromUserId]?.workspace || fallbackWorkspace;
}

export function setUserWorkspace(state, fromUserId, workspace) {
  state.userPrefs[fromUserId] = { ...(state.userPrefs[fromUserId] || {}), workspace };
}

export function clearUserWorkspace(state, fromUserId) {
  delete state.userPrefs[fromUserId];
}

export function rememberUserSession(state, fromUserId, sessionPatch = {}) {
  if (!fromUserId) return;
  const current = state.userSessions[fromUserId] || {};
  state.userSessions[fromUserId] = {
    ...current,
    ...sessionPatch,
    updatedAt: Date.now(),
  };
}

export function getUserSession(state, fromUserId) {
  return state.userSessions[fromUserId] || null;
}

function buildCodexSessionKey(fromUserId, workspaceKey) {
  return `${fromUserId}::${workspaceKey}`;
}

export function getCodexSession(state, fromUserId, workspaceKey) {
  if (!fromUserId || !workspaceKey) return null;
  return state.codexSessions?.[buildCodexSessionKey(fromUserId, workspaceKey)] || null;
}

export function setCodexSession(state, fromUserId, workspaceKey, sessionData = {}) {
  if (!fromUserId || !workspaceKey || !sessionData?.id) return;
  const key = buildCodexSessionKey(fromUserId, workspaceKey);
  state.codexSessions[key] = {
    ...(state.codexSessions[key] || {}),
    ...sessionData,
    updatedAt: Date.now(),
  };
}

export function clearCodexSession(state, fromUserId, workspaceKey) {
  if (!fromUserId || !workspaceKey) return;
  delete state.codexSessions?.[buildCodexSessionKey(fromUserId, workspaceKey)];
}

function normalizeSnippet(text, maxChars) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isLegacyDeliveryText(text) {
  return /^SEND_(FILE|IMAGE|VIDEO):\s*\S+/i.test(String(text || "").trim());
}

export function appendUserMemoryTurn(state, fromUserId, role, text, options = {}) {
  if (!fromUserId) return;
  const maxTurns = Number(options.maxTurns || 12);
  const snippetChars = Number(options.snippetChars || 280);
  if (role === "assistant" && isLegacyDeliveryText(text)) return;
  const snippet = normalizeSnippet(text, snippetChars);
  if (!snippet) return;

  const session = state.userSessions[fromUserId] || {};
  const turns = Array.isArray(session.memoryTurns) ? session.memoryTurns.slice() : [];
  turns.push({
    role,
    text: snippet,
    ts: Date.now(),
  });
  session.memoryTurns = turns.slice(-maxTurns);
  session.updatedAt = Date.now();
  state.userSessions[fromUserId] = session;
}

export function buildUserMemoryPrompt(state, fromUserId, options = {}) {
  const maxTurns = Number(options.maxTurns || 12);
  const maxChars = Number(options.maxChars || 4000);
  const session = getUserSession(state, fromUserId);
  const turns = Array.isArray(session?.memoryTurns)
    ? session.memoryTurns.filter((turn) => !(turn?.role === "assistant" && isLegacyDeliveryText(turn?.text))).slice(-maxTurns)
    : [];
  if (!turns.length) return "";

  const lines = ["Recent conversation memory:"];
  for (const turn of turns) {
    const label = turn.role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${turn.text}`);
  }

  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = `${text.slice(Math.max(0, text.length - maxChars))}`;
    const firstBreak = text.indexOf("\n");
    text = firstBreak >= 0 ? `Recent conversation memory:\n${text.slice(firstBreak + 1)}` : `Recent conversation memory:\n${text}`;
  }
  return text;
}

export function pruneUserSessions(state, maxEntries = 200) {
  const entries = Object.entries(state.userSessions || {});
  if (entries.length <= maxEntries) return;
  entries.sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0));
  const toDelete = entries.slice(0, entries.length - maxEntries);
  for (const [userId] of toDelete) {
    delete state.userSessions[userId];
  }
}
