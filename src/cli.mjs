#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { startWebot } from "./webot.mjs";
import { loadState, saveState } from "./state.mjs";
import { fetchQrCode, pollQrStatus } from "./weixin-api.mjs";

const require = createRequire(import.meta.url);
const qrcodeTerminal = require("qrcode-terminal");

function processExists(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function acquireRunLock(stateDir) {
  const lockPath = path.join(stateDir, "webot.lock");
  if (fs.existsSync(lockPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      if (existing?.pid && processExists(existing.pid)) {
        throw new Error(`Webot is already running (PID ${existing.pid}). Stop it first or use restart.cmd.`);
      }
    } catch (error) {
      if (error instanceof Error && /already running/.test(error.message)) {
        throw error;
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }

  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  const release = () => {
    try {
      if (!fs.existsSync(lockPath)) return;
      const current = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      if (Number(current?.pid) === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  };

  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(143);
  });
}

function usage() {
  console.log([
    "Usage:",
    "  node src/cli.mjs login [config-path]",
    "  node src/cli.mjs start [config-path]",
    "  node src/cli.mjs status [config-path]",
    "  node src/cli.mjs logout [config-path]",
  ].join("\n"));
}

async function login(cfg, state) {
  const qr = await fetchQrCode({
    apiBaseUrl: cfg.apiBaseUrl,
    botType: cfg.botType,
    routeTag: cfg.routeTag,
  });

  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error(`QR code fetch failed: ${JSON.stringify(qr)}`);
  }

  console.log("使用微信扫描下方二维码：");
  qrcodeTerminal.generate(qr.qrcode_img_content, { small: true });
  console.log(qr.qrcode_img_content);

  let currentQr = qr.qrcode;
  while (true) {
    const status = await pollQrStatus({
      apiBaseUrl: cfg.apiBaseUrl,
      qrcode: currentQr,
      routeTag: cfg.routeTag,
    });

    if (status?.status === "wait") continue;
    if (status?.status === "scaned") {
      console.log("二维码已扫描，请在微信里确认。");
      continue;
    }
    if (status?.status === "expired") {
      console.log("二维码已过期，重新获取...");
      const refreshed = await fetchQrCode({
        apiBaseUrl: cfg.apiBaseUrl,
        botType: cfg.botType,
        routeTag: cfg.routeTag,
      });
      currentQr = refreshed.qrcode;
      qrcodeTerminal.generate(refreshed.qrcode_img_content, { small: true });
      console.log(refreshed.qrcode_img_content);
      continue;
    }
    if (status?.status === "confirmed" && status?.bot_token && status?.ilink_bot_id) {
      state.account = {
        token: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id || "",
        baseUrl: status.baseurl || cfg.apiBaseUrl,
        linkedAt: new Date().toISOString(),
      };
      state.cursor = "";
      saveState(cfg.stateDir, state);
      console.log(`登录成功，账号：${status.ilink_bot_id}`);
      return;
    }

    throw new Error(`Unexpected QR status: ${JSON.stringify(status)}`);
  }
}

function showStatus(cfg, state) {
  console.log(`Config: ${cfg.configPath}`);
  console.log(`State dir: ${cfg.stateDir}`);
  if (!state.account) {
    console.log("Linked account: none");
    return;
  }
  console.log(`Linked account: ${state.account.accountId}`);
  console.log(`Base URL: ${state.account.baseUrl}`);
  console.log(`Cursor present: ${Boolean(state.cursor)}`);
}

async function main() {
  const command = process.argv[2] || "start";
  const configPath = process.argv[3];

  if (["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }

  const cfg = loadConfig(configPath);
  const state = loadState(cfg.stateDir);

  switch (command) {
    case "login":
      await login(cfg, state);
      return;
    case "start":
      if (!state.account?.token) {
        console.log("No linked account found, starting login first...");
        await login(cfg, state);
      }
      acquireRunLock(cfg.stateDir);
      await startWebot({ cfg, state });
      return;
    case "status":
      showStatus(cfg, state);
      return;
    case "logout":
      state.account = null;
      state.cursor = "";
      saveState(cfg.stateDir, state);
      console.log("Local link state cleared.");
      return;
    default:
      usage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
