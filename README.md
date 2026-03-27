# webot

This directory contains `webot`, a minimal standalone WeChat bot that does not depend on OpenClaw.

It does five things:

- calls the same `ilink` HTTP endpoints used by the Weixin ClawBot plugin
- links a Weixin account to the local machine with a QR code
- receives direct text messages by long-polling
- runs `codex exec` locally and sends the text result back to Weixin
- forwards key Codex progress events and image outputs back to Weixin

Current scope is intentionally narrow:

- single linked account
- direct messages only
- one Codex job at a time
- no media, group chat, scheduling, or task queue yet

## Install

Run this inside the directory:

```powershell
npm install
Copy-Item .\webot.config.example.json .\webot.config.json
```

Edit `webot.config.json`:

- `workspaces`: whitelist of accessible working directories
- `defaultWorkspace`: default workspace key
- `allowedSenders`: allowed Weixin user IDs, or `[]` to allow all
- `codex.command`: defaults to `codex`
- `codex.sandbox`: start with `read-only`
- `behavior.progressUpdates`: throttle how often progress is pushed back to Weixin
- `media.upload`: image upload path used before sending Weixin image items

## Login

```powershell
node .\src\cli.mjs login
```

The QR code is shown in the terminal. After you confirm in Weixin, local state is written to:

```text
%USERPROFILE%\.webot\state.json
```

## Start

```powershell
node .\src\cli.mjs start
```

Or on Windows:

```powershell
.\start.cmd
```

## MCP Server

Webot also provides a local stdio MCP server so agents can explicitly send results back to WeChat instead of only describing local files.

Start it with:

```powershell
npm run mcp
```

Current tools:

- `webot_get_session_context`
- `webot_send_text`
- `webot_send_file`
- `webot_send_image`
- `webot_send_video`
- `webot_send_paths`
- `webot_resolve_workspace_path`

The MCP server reads session context from environment variables such as:

- `WEBOT_API_BASE_URL`
- `WEBOT_TOKEN`
- `WEBOT_TO_USER_ID`
- `WEBOT_CONTEXT_TOKEN`
- `WEBOT_CDN_BASE_URL`
- `WEBOT_WORKSPACE_PATH`
- `WEBOT_CONFIG_PATH`
- `WEBOT_STATE_DIR`

Or from a JSON file referenced by `WEBOT_SESSION_FILE`.

## Python Version

A parallel Python implementation is also available.

Install dependencies:

```powershell
python -m pip install -r .\pybridge\requirements.txt
```

Use:

```powershell
.\login-py.cmd
.\start-py.cmd
.\status-py.cmd
```

## Weixin Commands

- `/help`
- `/repos`
- `/use <name>`
- `/where`
- `/reset`
- `/repo <name> <prompt>`

If `allowPlainTextPrompt` is `true`, plain text messages are treated as Codex prompts in the current workspace.

## Design

This tool does not reuse the OpenClaw runtime. It only reimplements the protocol surface that the published plugin exposed:

- `get_bot_qrcode`
- `get_qrcode_status`
- `getupdates`
- `sendmessage`

Codex flow:

1. receive Weixin text
2. resolve workspace and prompt
3. run `codex exec --json --output-last-message`
4. stream key JSON events back to Weixin as progress updates
5. read final text output
6. extract image references from the final reply, upload them, and send Weixin image messages

## Risks

- this is not a stable public SDK, so the remote protocol can change
- there is no media support, task queue, or audit trail yet
- `codex exec` on native Windows can still hit compatibility issues
- before long-term use, add at least:
  - strict `allowedSenders`
  - explicit confirmation for write actions
  - audit logging
  - queued execution
  - WSL execution support
