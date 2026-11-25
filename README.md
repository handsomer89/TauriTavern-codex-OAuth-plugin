# TauriTavern Plus Bridge

TauriTavern 安卓版扩展，配合同一部手机上的 Termux 桥接服务，通过 OpenAI 官方「使用 ChatGPT 登录」开源 OAuth 流程接入。符合条件的 ChatGPT Plus 账号授权后，普通聊天可使用订阅额度，无需填写 OpenAI API Key。模型以登录账号返回的列表为准。

## 在 TauriTavern 里安装扩展

在「扩展」→「安装扩展」粘贴下面的 Git URL。分支或标签留空，点「仅为我安装」。

```text
https://github.com/handsomer89/TauriTavern-codex-OAuth-plugin.git
```

扩展按 TauriTavern v2.4.0 的接口编写。如果之前通过本机地址装过旧版，可以在「管理扩展」里移除旧版，再通过上面的链接安装。

## 在同一部手机启动 OAuth 服务

在 [Termux](https://termux.dev/en/) 中执行：

```sh
pkg update
pkg install git nodejs-lts
git clone https://github.com/handsomer89/TauriTavern-codex-OAuth-plugin.git
cd TauriTavern-codex-OAuth-plugin
node bridge/bridge.mjs login
```

需要 Node.js 22 或更新版本。登录会打开系统浏览器。如果没有自动打开，就在同一部手机的浏览器打开 Termux 显示的地址。选择你的 Plus 账号，授权使用 ChatGPT 订阅额度，然后回到 Termux：

```sh
node bridge/bridge.mjs key
node bridge/bridge.mjs serve
```

复制第一条命令显示的本机密钥。让第二条命令继续运行，然后切回 TauriTavern。

## 连接和选模型

1. 在「API 连接」中选择「聊天补全」→「自定义（OpenAI Responses）」。
2. 点「填入本机 Plus 地址」，或手动填入 `http://127.0.0.1:18765/v1`。Responses WebSocket 模式保持关闭。
3. 把 Termux 生成的本机密钥填到「自定义 API 密钥」，然后点「连接」。如果出现端点确认，在核对同一个本机地址后确认。
4. 从可用模型列表中选一个模型并发条消息。第一次成功回复会消耗账号的实际额度。要逐字显示回复，可在聊天补全预设里打开流式传输。

下次用时，在同一仓库目录运行 `node bridge/bridge.mjs serve`。桥接会自动续期。如果安卓暂停了 Termux 后台运行，回到 Termux 检查服务是否仍在运行。

## 账号、额度和兼容性

先用 Ctrl+C 停止桥接，再登录、切换或退出账号。完成后重新执行 `serve`。

| 命令 | 用途 |
| --- | --- |
| `node bridge/bridge.mjs login` | 首次登录或重新授权当前账号 |
| `node bridge/bridge.mjs login new` | 添加另一个账号或工作区 |
| `node bridge/bridge.mjs accounts` | 查看已保存的账号和客户端 ID |
| `node bridge/bridge.mjs use <客户端ID>` | 切换账号 |
| `node bridge/bridge.mjs login <客户端ID>` | 重新授权指定账号 |
| `node bridge/bridge.mjs logout` | 退出当前账号并尝试撤销远端授权 |

- 在 [ChatGPT 设置 → 用量](https://chatgpt.com/settings/usage) 查看该应用的额度及共享点数设置。
- 支持普通聊天、流式和非流式回复。Agent、函数工具、联网搜索和持久化 Responses 会话尚未实现。桥接会略过订阅接口暂不接受的温度、Top P 和最大输出长度等参数。
- 桥接只监听手机本机的 `127.0.0.1`，OpenAI 令牌留在 Termux 私有目录的 `~/.tauritavern-plus/state.json`。TauriTavern 使用的是单独生成的本机密钥。
- 在仓库根目录可运行 `node --test bridge/test/bridge.test.mjs`。这些测试使用模拟 OpenAI 响应覆盖 OAuth 校验、令牌续期、模型列表和回复。安卓真机和真实 Plus 账号的端到端连接仍需实际授权验证。

[OpenAI 开源 OAuth 接入文档](https://developers.openai.com/siwc/token-sharing-open-source) · [TauriTavern v2.4.0](https://github.com/Darkatse/TauriTavern/releases/tag/v2.4.0)
