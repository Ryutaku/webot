import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultState() {
  return {
    account: null,
    cursor: "",
    codexSessions: {},
    codexUsageHistory: [],
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

function createZeroUsageTotals() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
  };
}

function normalizeUsageTotals(usage = {}) {
  return {
    inputTokens: Number(usage.inputTokens || 0),
    cachedInputTokens: Number(usage.cachedInputTokens || 0),
    uncachedInputTokens: Number(usage.uncachedInputTokens || 0),
    outputTokens: Number(usage.outputTokens || 0),
    totalTokens: Number(usage.totalTokens || 0),
    turns: Number(usage.turns || 0),
  };
}

function addUsageTotals(base = createZeroUsageTotals(), delta = {}) {
  const next = normalizeUsageTotals(base);
  const addition = normalizeUsageTotals(delta);
  return {
    inputTokens: next.inputTokens + addition.inputTokens,
    cachedInputTokens: next.cachedInputTokens + addition.cachedInputTokens,
    uncachedInputTokens: next.uncachedInputTokens + addition.uncachedInputTokens,
    outputTokens: next.outputTokens + addition.outputTokens,
    totalTokens: next.totalTokens + addition.totalTokens,
    turns: next.turns + Math.max(1, addition.turns || 0),
  };
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

export function updateCodexSessionUsage(state, fromUserId, workspaceKey, sessionData = {}, usage = {}) {
  if (!fromUserId || !workspaceKey) return null;

  const key = buildCodexSessionKey(fromUserId, workspaceKey);
  const current = state.codexSessions?.[key] || {};
  const currentSessionId = String(current.id || "");
  const nextSessionId = String(sessionData?.id || currentSessionId || "");
  const isNewSession = Boolean(currentSessionId && nextSessionId && nextSessionId !== currentSessionId);
  const currentTotals = isNewSession
    ? createZeroUsageTotals()
    : normalizeUsageTotals(current.usageTotals);
  const nextTotals = addUsageTotals(currentTotals, usage);
  const alertedThresholds = isNewSession
    ? []
    : Array.isArray(current.alertedThresholds)
      ? current.alertedThresholds.slice()
      : [];

  state.codexSessions[key] = {
    ...current,
    ...sessionData,
    id: nextSessionId,
    workspacePath: sessionData?.workspacePath || current.workspacePath || "",
    usageTotals: nextTotals,
    alertedThresholds,
    updatedAt: Date.now(),
  };

  return state.codexSessions[key];
}

export function markCodexSessionThresholds(state, fromUserId, workspaceKey, thresholds = []) {
  if (!fromUserId || !workspaceKey || !thresholds.length) return;
  const key = buildCodexSessionKey(fromUserId, workspaceKey);
  const current = state.codexSessions?.[key];
  if (!current) return;
  const alertedThresholds = Array.isArray(current.alertedThresholds) ? current.alertedThresholds.slice() : [];
  for (const threshold of thresholds) {
    if (!alertedThresholds.includes(threshold)) {
      alertedThresholds.push(threshold);
    }
  }
  current.alertedThresholds = alertedThresholds.sort((a, b) => a - b);
  current.updatedAt = Date.now();
}

export function appendCodexUsage(state, entry = {}) {
  if (!entry || typeof entry !== "object") return;
  const history = Array.isArray(state.codexUsageHistory) ? state.codexUsageHistory.slice() : [];
  history.push({
    ts: Date.now(),
    ...entry,
  });
  state.codexUsageHistory = history.slice(-200);
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
  const includeAssistant = options.includeAssistant !== false;
  if (role === "assistant" && !includeAssistant) return;
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
  const includeAssistant = options.includeAssistant !== false;
  const session = getUserSession(state, fromUserId);
  const turns = Array.isArray(session?.memoryTurns)
    ? session.memoryTurns
      .filter((turn) => includeAssistant || turn?.role !== "assistant")
      .filter((turn) => !(turn?.role === "assistant" && isLegacyDeliveryText(turn?.text)))
      .slice(-maxTurns)
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
