<div align="center">

<h1>open-browser-use</h1>

<p><b>让智能体操控你本就在用的浏览器。</b></p>

<img src="../open-browser-use-readme-preview-wide.png" alt="open-browser-use — agent browser tool, agentic RL ready" width="820">

<sub><a href="../README.md">English</a> · <b>简体中文</b> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a></sub>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Status: public preview" src="https://img.shields.io/badge/status-public%20preview-orange?style=flat-square">
  <img alt="Platforms: macOS and Linux" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux-lightgrey?style=flat-square">
  <br>
  <img alt="Built with Rust" src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white">
  <img alt="Built with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-server-7C3AED?style=flat-square">
</p>

</div>

---

你的编码智能体能推理、能规划、也能写代码。但只要任务藏在登录页背后、躲在没有 API 的仪表盘里，或者卡在需要反复点击的多步骤网页表单中，它就会撞上一堵墙：脑子很灵光，却对浏览器无从下手。**open-browser-use 正是给它装上这双手** —— 直接驱动*你*那个真实、早已登录好的浏览器，而且全程都在你自己的机器上完成。

## 你的智能体有脑子，却没有手

我们都喜欢对智能体说一句"这事你来搞定就好"。问题在于，*这事*里太多内容都活在浏览器标签页里：

- "把我这个季度邮箱里的发票全部下载下来，再加总一下。"
- "在我已经登录的那家店里，按惯例把日常采购的东西重新下单。"
- "把这个仪表盘上的数据扒下来 —— 它没有导出按钮。"
- "用那份 PDF 里的资料把这份申请表填好。"

这些事情*想*起来都不难。难就难在智能体没法去*碰*那个页面。open-browser-use 弥合了这道鸿沟，而且力图用一种友好的方式来做到：

- **用你的真实浏览器、你的会话。** 它驱动的是你日常在用的 Chrome，带着你的登录态和 Cookie —— 而不是一个全新、未登录的机器人浏览器。所以它能替你办*真正*的差事。
- **本地运行、隐私无忧。** 一切都跑在你的机器上。没有云端、没有账号，也不会向外回传任何东西。
- **兼容你手头已有的智能体。** Codex、Claude Code、Cursor、Gemini CLI、VS Code 等等 —— 全部通过 Model Context Protocol (MCP) 接入。
- **开源**，采用 MIT 许可证。

## 安装（当前预览版）

open-browser-use 目前是一个 **macOS / Linux 公开预览版** —— Chrome 应用商店的上架尚未生效，因此扩展通过 GitHub Releases 分发。你只需手动配置一件事：浏览器扩展。其余的一切都由你的 AI 智能体来安装并连接。

1. **[下载扩展](https://github.com/open-browser-use/open-browser-use/releases/latest/download/open-browser-use-extension.zip)**，从最新的 release 下载后解压。
2. **将其加载到浏览器中：** 打开 `chrome://extensions`（Chrome 或其他 Chromium 浏览器），开启 **开发者模式**，点击 **加载已解压的扩展程序**，然后选中解压后的文件夹。把它固定到工具栏 —— 接下来你正是通过它的弹窗来连接智能体。

> [!NOTE]
> 一旦 Chrome 应用商店的上架生效，你就能直接从商店添加扩展 —— 无需下载或解压。关于各平台的注意事项与故障排查，请参阅 [docs/install.md](../docs/install.md) 和 [docs/troubleshooting.md](../docs/troubleshooting.md)。

## 快速上手

加载好扩展之后，把它连接到你的编码智能体大约只需一分钟 —— 无需手动编辑任何配置文件：

1. **打开扩展弹窗**，点击 **Copy for agent**。
2. **把它粘贴给你的编码智能体**（Codex、Claude Code、Cursor、Gemini CLI 等等）。
3. 智能体会**配置好 open-browser-use MCP 服务器并连接到你的浏览器。** 大功告成。

> [!TIP]
> 然后就用大白话直接吩咐它：
> *"打开我的 GitHub 通知，帮我梳理一下哪些是真正需要我处理的。"*

## 能力

你的智能体通过单一的 `js` 工具来驱动浏览器。它所编写的 JavaScript 在一个常驻的 Node 运行时中执行，其中一套 Playwright 风格的 SDK 已绑定到 `agent` 全局对象上，因此一整轮完整的浏览器操作都能保持短小、清晰、易读：

```js
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.current();
await tab.attach();                                   // 接管该标签页
await tab.goto("https://news.ycombinator.com");
await tab.getByRole("link", { name: "new" }).click();
display(await tab.locator("h1").innerText());         // 呈现一个结果
await browser.turnEnded();                            // 交还控制权，但保留会话
```

这套 SDK 覆盖了真实任务所需的全部交互类型：

| 能力 | 提供的功能 |
| --- | --- |
| **操作元素** | 点击、填写、输入、按键、选择与悬停 —— 以 ARIA 角色、可见文本或 CSS 选择器来定位：这些稳健、Playwright 风格的定位器能在标记（markup）频繁变动时依然有效。 |
| **凭视觉或 DOM 节点点击** | 面向没有干净选择器的页面，提供基于视觉/坐标和基于 DOM 寻址的交互，包括位于跨域 iframe 内部的目标。 |
| **读取与提取** | 页面与元素的文本、表格、属性以及截图。 |
| **文件与对话框** | 文件上传与下载，以及对原生 `alert`、`confirm` 和 `prompt` 的处理。 |
| **标签页、会话与续作** | 同时驱动多个标签页和会话，并能跨多轮续作长时间运行的任务而不丢失进度。 |

面向更高层的工作流，这套 SDK 在这些相同的原语之上叠加了一层符合人体工学的辅助方法（`tab.act.*`、`tab.flows`、`tab.read`）。

## 架构

在你的智能体看来，open-browser-use 就是一个 MCP 服务器。智能体通过单一的 `js` 工具编写 JavaScript；这些代码在一个长期存活的 Node 运行时中执行，其中 SDK 已绑定到 `agent`。SDK 调用被封装为 JSON-RPC，经由一个受能力门控、仅属主可访问的 Unix socket 传送给 **`obu-host`** —— 一个按会话隔离的代理守护进程（broker daemon），它通过以下两种后端之一来驱动你的浏览器：

```
your agent
   │  MCP over stdio              （`js` 工具；你来写 JS，SDK 就是 `agent`）
   ▼
obu-node-repl                     （MCP 服务器 + 它所启动的 Node 运行时）
   │  JSON-RPC over an owner-only Unix socket   （受能力门控）
   ▼
obu-host                          （按会话隔离的代理守护进程）
   ├─▶ WebExtension backend ─▶ your everyday Chrome        （MV3 + 原生消息传递，无需调试端口）
   └─▶ CDP backend          ─▶ Chrome with remote debugging   （OBU_CDP_URL）
```

两种后端使用相同的协议、呈现相同的 SDK；它们的区别仅在于触达浏览器的方式：

| 后端 | 如何触达浏览器 | 最适合 |
| --- | --- | --- |
| **WebExtension** *(默认)* | 通过 open-browser-use 扩展驱动一个正常安装的 Chrome（MV3 + 原生消息传递）—— 无需 `--remote-debugging-port`，你真实的配置文件和登录态都完好无损。 | 面向你日常登录使用的那个浏览器进行日常操作。 |
| **CDP** | 任何以远程调试方式启动、并通过 `OBU_CDP_URL` 寻址的 Chrome。 | 无头（headless）、容器化以及脚本化运行。 |

<details>
<summary><b>仓库结构</b> —— 各部分都在哪里</summary>

| 路径                              | 是什么                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `crates/obu-wire`               | 共享的 JSON-RPC 帧格式、信封（envelope）与错误码。                                                                  |
| `crates/obu-node-repl`          | MCP 服务器：启动 Node 运行时（SDK 在其中执行），并把其受能力门控的 socket 代理至 `obu-host`。 |
| `crates/obu-host`               | 按会话隔离的代理守护进程，以及 CDP / WebExtension 两个后端。                                                    |
| `packages/sdk`                  | 面向智能体、Playwright 风格的 TypeScript SDK（`@open-browser-use/sdk`）。                                       |
| `packages/browser-control-core` | 纯协议类型、规划器（planner）以及由 SDK 与扩展共享的测试夹具（fixture）。                                          |
| `packages/cli`                  | `obu` 命令行 —— `setup`、`verify`、`doctor`，以及智能体的 MCP 接线。                                  |
| `packages/extension`            | Chromium MV3 扩展及其原生宿主桥接（native-host bridge）。                                                                |

</details>

## 安全与隐私

open-browser-use 在设计上即奉行本地优先：它绝不会调用任何远程 URL 或产品策略服务，关于你浏览行为的一切都不会离开你的机器。SDK guard 与 host policy 都在本地运行，且默认采用宽松策略 —— 只有在你需要时才去收紧它们。从进程边界向外，三个层次为你提供了管控能力。

**进程边界。** `obu-host` 监听的 Unix socket 仅属主可访问，并按操作系统用户进行身份验证；只有受信任的 SDK 代码才持有触达它所需的能力令牌。open-browser-use 绝不会向任何远程服务建立连接。

**Host policy。** 通过环境变量来约束浏览器被允许执行的操作：

| 变量                                                                      | 作用                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `OBU_HOST_POLICY_DENY_ORIGINS`                                              | 对所列出的源（origin）阻止导航及当前源相关命令。 |
| `OBU_HOST_POLICY_DENY_CDP_METHODS`                                          | 阻止特定的原始 CDP 方法（`*` 表示全部阻止）。                   |
| `OBU_HOST_POLICY_BLOCK_HISTORY` / `_BLOCK_DOWNLOADS` / `_BLOCK_UPLOADS` | 阻止历史记录读取、下载或上传。                          |
| `OBU_GUARD_MODE=disabled`                                                   | 在本地/测试环境中绕过所有 guard 与 policy 检查。                |

**SDK guard。** 若要进行编程式、按浏览器粒度的管控，可为导航、下载、上传、历史记录和原始 CDP 安装 `Guards` 钩子。它们在你本地的智能体进程中运行，不会发起任何网络请求：

```ts
import { Guards } from "@open-browser-use/sdk";

const browser = await agent.browsers.get("chrome", {
  guards: new Guards({
    checkNavigation(url) {
      if (url.startsWith("https://admin.example/")) throw new Error("navigation blocked");
    },
  }),
});
```

## 智能体强化学习环境

open-browser-use 在设计上不仅能*运行*浏览器智能体，还能兼作一个**用于训练和评估浏览器智能体的环境**。强化学习的内核已经就位；尚待补齐的是围绕它的训练框架。

**已经具备的能力**

- **一套环境风格的「动作/观测」循环。** `tab.observe()` 返回一个带类型的 `TabObservation`；`tab.step(action)` 接收一个带类型的 `EnvAction` 并返回一个 `ActionResult`。`EnvAction` 横跨三种寻址模式下的 **13 种动作类别** —— `locator.*`、`dom_cua.*` 和 `coordinate.*` —— 每一种都可附带一个可选的能力 `policy`。
- **丰富、结构化的步骤结果。** `ActionResult` 会报告一个 `ActionEffect`（`navigation`、`dom_changed`、`download_started`、`no_visible_change` 等等）、`invalidatedObservations`、各类句柄、提示信息（advisory），以及一个结构化的 `error` —— 足以为学习器或验证器（verifier）提供驱动信号。
- **可持续、带恢复能力的回合（episode）。** 会话内置所有权仲裁、陈旧句柄诊断、属主回合证明以及 `resume`，因此长回合即使遇到崩溃和重连也能存续。任务可导出为 `EpisodeExport { task_id, turns, events }`。

**尚未具备的能力** —— 目前还没有一个统一的 `Environment` 门面来暴露正式、可采样的 `reset/step/observe/close`；`browser.reset()` 仅重置视口（后端是接入一个已有浏览器，而非启动一个一次性浏览器）；同时也还没有内置的验证器底座、带奖励的轨迹（trajectory）模式、并行 rollout 集群，或 Python / 网络（HTTP/gRPC）客户端 —— 目前对外的接口只有 MCP-stdio 加上原生管道代理（native-pipe broker）。

### 通往可训练环境的路线图

按照「能否真正对它进行训练」这条关键路径排序：

- [ ] **Env 门面 + 语言无关协议 + Python 客户端** *(基石)* —— 把 `reset/step/observe/close` 收敛到一个 HTTP/gRPC 接口之后（或为常见的 RL 框架提供适配器），让外部训练器能够大规模驱动 rollout。
- [ ] **干净、带种子的 `reset()`** —— 让后端能够启动一个带全新配置文件、固定起始 URL 的一次性浏览器，并在回合结束时销毁。这一项能力同时解锁了重置*和*并行化。
- [ ] **验证器底座（RLVR）** —— 一个确定性的断言库（`url_contains`、`text_visible`、`dom_query`、`download_produced`、JS 谓词）外加 `episode.evaluate({ assertions })`。
- [ ] **可直接用于训练的轨迹模式** —— 把 `EpisodeExport.turns` 类型化为 `(obs, action, effect, reward, done)` 记录，并支持标准的 JSONL / Hugging Face 数据集导出。
- [ ] **并行 rollout 集群** —— 一个包含 N 个相互隔离的浏览器、支持异步步进的池子（构建于干净的 reset 之上）。
- [ ] **确定性与可复现性** —— 种子设定、可选的网络录制/回放，以及带内容哈希的固定任务实例，用以检测实时网页的漂移。

## 从源码构建

构建并测试整个工作区：

```bash
cargo test --workspace
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r test
```

Wire 方法名、SDK guard 类、host policy 类以及各后端的支持状态，全部来源于 `wire/methods.json`。修改某个 wire 方法之后，请重新生成 TS/Rust 对照表并运行时效性检查：

```bash
pnpm generate:wire-methods
pnpm check:wire-methods
```

打包、覆盖率，以及被忽略（ignored）的 CDP / WebExtension 端到端测试关卡都有各自的脚本与配置；详见 [docs/install.md](../docs/install.md)、[docs/troubleshooting.md](../docs/troubleshooting.md) 和 [docs/release-checklist.md](../docs/release-checklist.md)。

## 许可证

open-browser-use 采用 MIT 许可证 —— 详见 [LICENSE](../LICENSE)。Release 产物中还携带了一些遵循其上游许可证的第三方组件；细节请见 [LICENSE-THIRD-PARTY.md](../LICENSE-THIRD-PARTY.md)。

---

<div align="center">
<sub>以 Rust + TypeScript 构建 · 通过 Model Context Protocol 驱动 · macOS / Linux 公开预览版</sub>
</div>
