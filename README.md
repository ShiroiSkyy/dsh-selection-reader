# 划词解读（DSH 插件）

在对话里划中一段文字，点「解读」，由 AI 结合**本轮对话**解释它在这里是什么意思；每次解读会留下一条历史，随时可以查看、跳回原对话。

## 界面

1. **划词浮层**
   选中对话里的文字后，官方浮层里出现「引用文本」；本插件在它右侧并排、同高显示「解读」。点「解读」会立即在原文高亮，并在选中位置旁弹出解读窗口。
2. **解读窗口**
   - 可拖动：按住标题栏可以把窗口拖到任意位置，拖动范围限制在可视区域内；
   - 加载中：骨架屏 + 「正在解读…」，`aria-busy` 标记忙碌状态；
   - 成功：把模型输出按「此处含义 / 依据 / 补充」拆成分段卡片，段内自动高亮所选文本，不再是一整块纯文本；窗口里可以复制完整解读，底部显示实际使用的模型；
   - 失败：错误说明 + 「重试」按钮，高亮保留，点高亮可以回到这个失败态重试。
3. **原文高亮**
   - 高亮用 DOM 包裹实现，在原文里直接可见；
   - 点击高亮：在点击位置旁边重新打开当时的解读；
   - 右键高亮：「删除解读」，同时删除高亮和这条历史记录。
4. **插件页（左侧栏「划词解读」图标）**
   - **解读历史**：以解读文本为标题，按时间倒序列出；顶部可搜索解读文本和对话标题；点任意一条打开详情，详情同样按分段卡片展示，并可以复制或跳回原对话。
   - **插件设置**：全部选项集中在这里，改完点右下角「保存设置」才会生效；有未保存的修改时保存条会高亮提示，也可以「撤销修改」。

## 行为规则

- 历史记录以「对话 + 轮次」为唯一坐标，同一坐标只保留最新一条。
- 在同一轮次里再次划中**同样的文本**：直接显示已有解读，不调用模型，不新增记录。
- 在同一轮次里划中**不同的文本**（包括有重叠的选择）：重新解读并覆盖该轮次的记录。
- 删除高亮会同时删除对应历史记录。
- 历史条数超过上限时，先按「对话 + 轮次」覆盖，再删除最旧的记录。
- 单次解读有字数上限，超出时只提示、不发起解读。

## 设置项

| 分组 | 选项 | 默认 |
| --- | --- | --- |
| 解读 | 解读提示词（可编辑、可恢复默认） | 内置中文提示词 |
| 解读 | 模型：跟随当前会话 / 指定模型 / 自定义 API | 跟随当前会话 |
| 解读 | 自定义 API：接口地址、API Key、模型名，可「测试连接」 | 空 |
| 解读 | 单次解读字数上限 | 500 |
| 划词与显示 | 划词菜单显示「解读」 | 开 |
| 划词与显示 | 高亮样式（浅色底 / 下划线） | 浅色底 |
| 划词与显示 | 高亮颜色（跟随主题 / 暖黄 / 浅蓝） | 跟随主题 |
| 历史 | 历史记录上限 | 200 条 |
| 历史 | 清空历史（二次确认） | — |

设置修改先留在草稿里，点「保存设置」写入并立即生效；「撤销修改」丢弃草稿。切到「解读历史」再切回来，未保存的草稿仍在。

设置和历史都保存在当前浏览器的 localStorage：`selection-reader:settings:v1`、`selection-reader:history:v1`。换浏览器或清站点数据后会重新开始。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单、`dsh.bundle` 补丁入口、`dsh.client` 浏览器端入口 |
| `cordis.patch.yml` | 向 profile 插入一条 Host 插件行 |
| `index.js` | Host 半边：`/selection-reader/api/*` 接口，调用 `ctx.llm` 完成解读 |
| `client.js` | 浏览器端：划词浮层、高亮、解读窗口、历史与设置页 |
| `locale/{zh,en}.json` | 插件管理页显示的标题与描述 |
| `icon.svg` | 插件图标 |
| `test/selection-reader.test.mjs` | 纯逻辑单测（缓存、覆盖、上限、搜索、命中） |

## Host 接口

- `POST /selection-reader/api/interpret`：`{text, context, prompt, provider?, model?}` → `{ok, text, model}`。
- `GET /selection-reader/api/models`：可用的服务商与模型（按 60 秒缓存）。
- `GET /selection-reader/api/health`：`{ok, llm, defaultSelection}`。

模型解析顺序：请求里显式指定的 provider/model → Harness 默认模型选择 → 内置 `deepseek-account/deepseek-flash`。

## 实现说明

- 「引用文本」浮层由官方 `message-quotes` 注册，本插件不改动它；插件监听划词浮层出现，把自己的「解读」按钮定位在它右侧并排显示。这样不会和官方插件抢同一个交互槽位，避免启动冲突。
- 「解读」按钮在 `pointerdown` 时直接触发解读：官方浮层会在 pointerdown 时收起，如果等 `click` 再执行，按钮可能已经因为浮层消失而卸载，表现为「点了没反应」。用 pointerdown 触发并配合 350ms 去抖后，点击稳定性不再依赖浮层存活。
- 解读内容先解析再渲染：识别「此处含义 / 依据 / 补充」及 Markdown、加粗、行内标题等写法，拆成分段卡片；解析失败时退回整段文本，不会丢内容。
- 高亮用 DOM mark 包裹（`mark[data-si-record]`）实现，可见、可点击、可右键；消息重新渲染后由 MutationObserver 自动重新套用。点击高亮时用 mark 自身的矩形定位窗口，避免窗口跑到左上角。
- 「解读」按钮与官方「引用文本」胶囊按同一矩形对齐：读取胶囊按钮的 `getBoundingClientRect()` 后同高、同顶、右移 6px 并排显示。
- 解读内容先解析再渲染：识别「此处含义 / 依据 / 补充」及 Markdown、加粗、行内标题等写法，拆成分段卡片；解析失败时退回整段文本，不会丢内容。
- 模型列表读取带 12 秒超时和「重试」按钮，不会一直停在「正在读取模型列表…」。
- 自定义 API 走 Host 侧 `/custom/test` 与 `/interpret`：按 OpenAI 兼容的 `chat/completions` 协议请求，API Key 只保存在本机浏览器，不写入 Host 配置。
- 锚点保存为「会话 + 轮次 + 消息节点 key + 文本偏移」；消息被重新渲染后按节点 key 和偏移重新生成 Range，文本对不上时静默跳过，不影响历史。
- 选中的本轮对话文本直接从对话 DOM 的 `data-text-interaction-source` 节点里提取，只取这一轮。

## 开发与验证

```powershell
node --check client.js
node --check index.js
node test\selection-reader.test.mjs
```

安装后已确认：Host 行 `include:selection-reader` active，`/selection-reader/api/health` 与 `/selection-reader/api/models` 返回 200，`ctx.llm` 可用；Client 端四个席位（`sidebar.panellist#selection-reader`、`main#selection-reader`、`shell.overlay#selection-reader-overlay`、`conversation.input.dock#selection-reader-session`）均为 active，官方 `message-quotes` 也正常 active。界面交互（浮层、高亮、弹窗、历史页）需要在浏览器里实际点击验证；本环境没有浏览器控制能力，未做截图级验证。

> 早先版本曾尝试接管官方「引用文本」的交互槽位，会让 `dsh-message-quotes` 在启动时激活失败导致 DSH 无法进入界面；现已改成「浮层右侧并排按钮」，不再占用官方槽位。

安装：在本机 DSH profile 中由会话调用 `plugin_manager(action: install_bundle, target: <本目录绝对路径>)`；卸载：`plugin_manager(action: remove_bundle, target: "@local/dsh-selection-reader")`。

## 仓库

<https://github.com/ShiroiSkyy/dsh-selection-reader>

## 已知限制

- 历史与设置存在浏览器本地，不跨设备同步；自定义 API 的 Key 也只保存在本机浏览器。
- 自定义 API 只支持 OpenAI 兼容的 `/chat/completions` 协议；非兼容接口请等待后续适配。
- DOM mark 包裹会改动原文的文本节点；如果宿主版本的消息渲染策略变化导致标记被清除，插件会在下一次 DOM 变化时自动重新套用。
- 只对已完成的助手文本和已展示的用户消息生效；流式输出中的文字不能划词。
- 「解读」按钮依赖官方划词浮层出现；只读或不可写会话里官方浮层不出现，解读按钮也不会出现。
- 历史条目在原文被删除后仍会保留；点击「回到对话」才做检查，找不到时提示「原对话已不存在」。
- 解读窗口的拖动位置只在本次打开期间有效；重新打开会回到所选文字旁边的默认位置。
- 解读会消耗模型额度，默认关闭推理（`reasoningEffort: off`），单次最多输出约 800 tokens。
