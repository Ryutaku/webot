# webot

`webot` 是一个独立运行的微信机器人桥接程序，用来把微信消息接到本地 `codex cli`，再把结果回传到微信。

当前这版已经支持：

- 微信扫码登录
- 长轮询接收私聊消息
- 调用本地 `codex exec`
- 把文本结果回发到微信
- 把本地图片、视频、文件通过微信官方媒体链路发回微信
- 通过本地 MCP server 把“发文本 / 发文件 / 发图片 / 发视频”能力暴露给 Codex
- 为每个微信用户维护一份有上限的短记忆，避免原始聊天记录无限膨胀

当前限制：

- 单账号
- 仅私聊
- 同时只处理一个请求
- 没有任务队列
- 没有群聊支持

## 安装

在项目目录中执行：

```powershell
npm install
Copy-Item .\webot.config.example.json .\webot.config.json
```

然后按需修改 `webot.config.json`，重点字段：

- `workspaces`：允许访问的工作区
- `defaultWorkspace`：默认工作区
- `allowedSenders`：允许使用 bot 的微信用户 ID，留空表示不限制
- `codex.command`：默认是 `codex`
- `codex.sandbox`：当前建议使用 `danger-full-access`
- `behavior.memory`：每个用户的短记忆配置
- `media.cdnBaseUrl`：微信媒体上传地址

注意：

- 不要把你自己的 `webot.config.json` 提交到仓库
- 本地登录态保存在 `%USERPROFILE%\.webot`

## 登录

```powershell
node .\src\cli.mjs login
```

也可以直接运行：

```powershell
.\login.cmd
```

扫码确认后，本地状态会写入：

```text
%USERPROFILE%\.webot\state.json
```

## 启动与停止

启动：

```powershell
.\start.cmd
```

重启：

```powershell
.\restart.cmd
```

停止：

```powershell
.\stop.cmd
```

脚本已经做了单实例处理，避免同一台机器上重复启动多个 `webot` 进程。

## MCP Server

`webot` 自带一个本地 `stdio` MCP server，供 Codex 直接调用微信回传能力。

启动方式：

```powershell
npm run mcp
```

当前提供的工具：

- `webot_get_session_context`
- `webot_send_text`
- `webot_send_file`
- `webot_send_image`
- `webot_send_video`
- `webot_send_paths`
- `webot_resolve_workspace_path`

这些工具内部会自行处理：

- 微信会话上下文
- `getuploadurl`
- AES-128-ECB 加密
- 微信 CDN 上传
- `sendmessage`

也就是说，Codex 不需要理解底层微信协议，只需要调用高层工具。

## 微信命令

支持以下命令：

- `/help`
- `/repos`
- `/use <name>`
- `/where`
- `/reset`
- `/repo <name> <prompt>`

如果 `allowPlainTextPrompt` 为 `true`，普通文本会直接作为当前工作区下的 Codex prompt 处理。

## 工作流程

一条微信消息的大致流程如下：

1. `webot` 通过 `getupdates` 收到消息
2. 根据发送人确定工作区和微信会话上下文
3. 把当前用户的短记忆和本轮消息一起交给 `codex exec`
4. Codex 需要把结果真正回到微信时，优先调用 `webot-mcp`
5. `webot` 根据结果决定是否还需要补发文本或媒体
6. 最终把纯文本、图片、视频或文件送回微信

## 设计说明

`webot` 没有复用 OpenClaw 的完整运行时，但复刻了它公开暴露出来的关键微信协议面：

- `get_bot_qrcode`
- `get_qrcode_status`
- `getupdates`
- `getuploadurl`
- `sendmessage`
- `getconfig`
- `sendtyping`

媒体发送链路参考了官方微信插件的实现方式：

1. 申请上传 URL
2. 本地 AES-128-ECB 加密
3. 上传到微信 CDN
4. 使用媒体引用调用 `sendmessage`

## 风险与后续建议

需要注意：

- 这不是稳定公开 SDK，远端协议后续可能变
- 原生 Windows 上跑 `codex exec` 仍可能碰到兼容性问题
- 当前还没有队列、审计日志和更严格的权限控制

如果要长期用，建议继续补：

- 更严格的 `allowedSenders`
- 对写操作增加确认机制
- 审计日志
- 队列化执行
- 更完善的错误恢复
