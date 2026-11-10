<p align="center">
  <img src="icon.svg" width="88" height="88" alt="划词解读插件图标" />
</p>

<h1 align="center">划词解读 · Selection Reader</h1>

<p align="center">
  <b>在 DeepSeek Harness 的对话里划中一段文字，得到结合当前语境的解读。</b>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
  <br />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="version" src="https://img.shields.io/badge/version-1.1.0-green.svg" />
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness-4d6bfe.svg" />
</p>

---

一个 DeepSeek Harness（DSH）插件：划中对话里的文字后，用 AI **结合本轮对话的语境**解释它在讲什么，而不是丢一份词典释义过来。

读 `SP-API`、`LGPD`、`PIPL`、平台政策、`SaaS` 这类术语时，一边查一边读很打断节奏。划词解读在官方「引用文本」旁边加了一个「解读」按钮：点开后立即高亮原文，在旁边弹出可拖动的解读窗口，并把每次解读按「对话 + 轮次」存进可搜索、可跳回原对话的历史里。

## 功能

- **结合语境的解读**：把选中的文字和当前这一轮对话一起交给模型，回答「它在这里是什么意思」。
- **结构化结果，不是一整块文字**：自动拆成「此处含义 / 依据 / 补充」分段卡片，正文里高亮你选中的词。
- **可拖动、可复制、有状态反馈的窗口**：标题栏拖动，加载骨架屏，失败可重试，底部显示实际使用的模型。
- **持久高亮**：原文会被高亮；点高亮重新查看解读，右键「删除解读」同时删掉高亮和历史记录。
- **能找回来的历史**：以解读文本为标题，可按文本或对话标题搜索，一键跳回原对话并定位到消息。
- **显式保存设置**：设置改动先留在草稿里，点「保存设置」才生效；有未保存修改会提示，可「撤销修改」。
- **模型三种模式**：跟随当前会话 / 指定 Harness 模型 / 自定义 **OpenAI 兼容** 第三方 API（接口地址、API Key、模型名），并带「测试连接」。
- **默认行为合理**：同一轮次同样的文本直接复用缓存，不再调用模型；同一轮次换文本会覆盖该轮次旧记录；历史上限可配。

## 环境要求

- DeepSeek Harness（DSH）桌面版 `0.2.2-rc.1` 或支持插件 bundle 与 Web 服务的兼容版本。
- Git（用于克隆仓库）。
- 只有需要跑检查或单测时才需要 Node.js。

## 安装

插件是一个 DSH **bundle**：Host 半边暴露本地 HTTP 接口，浏览器半边负责界面。

### 1. 克隆仓库

```powershell
git clone https://github.com/ShiroiSkyy/dsh-selection-reader.git
```

### 2. 安装到你的 DSH profile

在 DSH 会话里让 Agent 安装克隆下来的目录，例如：

> 安装这个 DSH 插件 bundle：`D:\path\to\dsh-selection-reader`（用 `plugin_manager` 的 `install_bundle`）。

Agent 会执行 `plugin_manager(action: "install_bundle", target: "<绝对路径>")`，把插件加入当前 profile。安装命令会自己写 profile 配置，不要手动修改 profile 里的 `cordis.patch.yml`。

### 3. 刷新页面

重新加载一次 Harness Web 页面。左侧栏顶部会出现「划词解读 / Selection Reader」图标。

### 升级

```powershell
cd dsh-selection-reader
git pull
```

重新安装 bundle（或重启 DSH），让新的 Host 半边生效。

### 卸载

让 Agent 移除 bundle：

> 移除 DSH bundle `@local/dsh-selection-reader`（`plugin_manager` 的 `remove_bundle`）。

## 使用说明

1. 在已完成的助手回复或已展示的用户消息里划中一段文字。
2. 在划词浮层里，点「引用文本」旁边的「解读」。
3. 选中文字会立即高亮，解读窗口在旁边打开；骨架屏结束后显示分段解读。
4. 之后点高亮可以重新查看；右键高亮选「删除解读」会同时移除高亮和历史记录。
5. 点左侧栏图标，可以查看「解读历史」和「插件设置」。

### 解读历史

- 记录按「对话 + 轮次」保存。同一轮次再次划中相同文本，直接显示缓存结果，不再调用模型。
- 同一轮次里换成别的文本（包括有重叠的选择），会覆盖该轮次的旧记录，只保留最新一次。
- 列表可按解读文本或对话标题搜索；详情里可以复制结果或「回到对话」。原对话不存在时给出提示，不会变成报错页。

### 设置项

| 分组 | 选项 | 默认 |
| --- | --- | --- |
| 解读 | 解读提示词（可编辑、恢复默认） | 内置中文提示词 |
| 解读 | 模型：跟随当前会话 / 指定模型 / 自定义 API | 跟随当前会话 |
| 解读 | 自定义 API：接口地址、API Key、模型名；**测试连接** | 空 |
| 解读 | 单次解读字数上限 | 500 |
| 划词与显示 | 划词菜单显示「解读」 | 开 |
| 划词与显示 | 高亮样式：浅色底 / 下划线 | 浅色底 |
| 划词与显示 | 高亮颜色：跟随主题 / 暖黄 / 浅蓝 | 跟随主题 |
| 历史 | 历史记录上限 | 200 条 |
| 历史 | 清空历史（二次确认） | — |

设置需要点「保存设置」才生效。改动会先保存在草稿里，在「解读历史 / 插件设置」之间切换不会丢失；点「撤销修改」恢复为已保存的值。

### 自定义 API

- 适用于提供 OpenAI 兼容 `POST {base}/chat/completions` 接口的服务。接口地址可以只填到 `/v1`，也可以填完整路径。
- 「测试连接」会发一个最小请求，成功时显示连接成功和耗时，失败时显示服务商返回的错误。
- API Key 只保存在本机浏览器的 `localStorage` 里，解读时发给本机 DSH Host，不会写进 DSH 配置，也不会进入仓库。
- 暂不支持非 OpenAI 兼容协议（如 Anthropic 原生、Gemini 原生）。

## 数据与隐私

- 设置和历史都存在浏览器里：`selection-reader:settings:v1`、`selection-reader:history:v1`。按浏览器隔离，不跨设备同步。
- 被解读的文本和当前这一轮对话会发给你配置的模型接口；使用自定义 API 时发往你填写的地址。
- 插件不收集遥测。`GET /selection-reader/api/diag` 只暴露计数和客户端版本标记。
- Host 接口只接受同源 JSON 请求（跨站 `Origin` 和非 JSON 的 `POST` 会被拒绝），别的网页无法驱动解读接口或把它当代理使用。

## 实现说明

| 半边 | 职责 |
| --- | --- |
| Host（`index.js`） | 本地 HTTP API：`POST /interpret`、`POST /custom/test`、`GET /models`、`GET /health`、`GET/POST /diag`。Harness 模型走 `ctx.llm`，自定义 API 走 OpenAI 兼容请求。 |
| Client（`client.js`） | 划词按钮、解读窗口、DOM 高亮、历史与设置页。使用 `sidebar.panellist`、`main`、`shell.overlay`、`conversation.input.dock` 四个席位。 |

- 「解读」按钮通过测量官方「引用文本」胶囊的实际矩形来并排定位，不占用官方交互槽位，所以 DSH 启动不受影响。
- 高亮是真实的 `<mark data-si-record>` 元素；聊天重新渲染后由 `MutationObserver` 自动重新套用。
- 缓存、覆盖、历史上限、搜索、分段解析、选中词切片等纯逻辑有单测，测试直接从 `client.js` 抽取标记区域执行。

## 开发

```powershell
node --check client.js
node --check index.js
node test\selection-reader.test.mjs
```

测试会抽取 `client.js` 里标记的纯逻辑区域，所以不需要构建步骤也能直接测。

开发时把工作目录作为 bundle 安装，改完刷新页面即可；改 Host 半边需要重启 bundle 条目（让 Agent 切换一次 bundle，或重启 DSH）。

### 目录结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：HTTP 路由、`ctx.llm` / OpenAI 兼容调用 |
| `client.js` | 浏览器半边：界面、划词、高亮、本地存储 |
| `cordis.patch.yml` | 把插件行插入 DSH profile |
| `package.json` | bundle 清单、`dsh.bundle` 与 `dsh.client` 声明 |
| `locale/` | 插件管理页显示用的标题和描述 |
| `icon.svg` | 插件图标 |
| `test/` | 纯逻辑单测 |

## 已知限制

- 自定义 API 必须是 OpenAI 兼容协议。
- 历史和设置只存在当前浏览器里。
- 只能划选已完成的助手文本和已展示的用户消息，流式输出中的文字不参与。
- 只读或不可寻址的会话不会出现官方划词浮层，因此也没有「解读」按钮。
- 高亮标记位于 React 管理的消息内容里；宿主重渲染消息后会在下一次 DOM 变化时重新套用（可能有一瞬闪烁）。
- 拖动后的窗口位置不会持久化，重新打开会回到选中文字旁边。
- 解读会消耗模型额度（默认关闭推理，输出上限约 800 tokens）。

## 更新记录

- **1.1.0** — 设置改为显式保存与草稿机制；支持自定义 OpenAI 兼容 API 与测试连接；可拖动窗口；结构化解读卡片；高亮与按钮对齐改进；模型列表加载修复。
- **1.0.0** — 首个版本：划词解读、高亮、历史、搜索、跳回原对话、设置。

## 许可证

[MIT](LICENSE) © 2026 ShiroiSkyy
