# ST Vertex AI PayGo Server Plugin

本项目是前端扩展 `ST-Vertex-PayGo`的**配套后端插件（Server Plugin）**。用于让 SillyTavern（酒馆）和 Luker 支持 Google Vertex AI 的 **PayGo-only、Flex 以及 Priority**，以及 **Google AI Studio 的 Flex** 计费/服务层级请求。

> ⚠️ **注意**：
> 1. 本插件**不是**通用的 Google API 反代，也**无法独立提供前端 UI**。必须配合前端扩展 `ST-Vertex-PayGo` 一起使用。
> 2. 当前已验证兼容 SillyTavern `1.16.0` / `1.17.0` / `1.18.0` 以及 Luker `2.7.0` (release 分支)。
> 3. 本项目为第三方非官方插件，与 SillyTavern、Luker 或 Google Cloud 无任何官方关联。

---

## 为什么需要这个后端插件？

SillyTavern 和 Luker 原生的 Vertex AI 请求逻辑并没有暴露 Google 的 PayGo 服务层级参数。为了在不破坏宿主原生认证的前提下支持这些层级，我们需要前后端配合：

- **前端扩展**：负责提供 UI，供用户选择并保存需要的服务层级（PayGo-only / Flex / Priority）。
- **后端插件（本项目）**：
  - 直接复用你在酒馆/Luker 中已经配置好的 Vertex AI 认证信息（无需重复填 Key）。
  - 根据选定层级，自动为请求注入 Google 专属的 PayGo 标头。
  - 通过本地 `127.0.0.1` 临时端口实现安全的中继转发与参数校验。
  - 保存本次服务启动周期的安全运行日志，供管理员在前端查看和下载。

---

## 环境要求

- **宿主程序**：SillyTavern >= 1.16.0 或 Luker >= 2.7.0（release 分支）
- **运行环境**：Node.js >= 20
- **前置配置**：宿主中已配置好可用的 Vertex AI（Express 模式或 Service Account 服务账号均可）
- **配套前端**：已安装 `ST-Vertex-PayGo` 前端扩展

> 插件启动时会自动校验宿主的 `package.json` 和 `src/endpoints/google.js`。若版本过低、非支持的宿主或缺少必要的 Vertex 接口，插件会自动拒绝启动以防报错。

---

## 安装说明

1. 彻底关闭 SillyTavern 或 Luker 进程。
2. 将**本项目（后端插件）**放入宿主目录的 `plugins` 文件夹下：
   ```text
   <宿主根目录>/plugins/ST-Vertex-PayGo-Server/
   ```
3. 将**前端扩展**放入对应的扩展目录下：
   ```text
   <宿主根目录>/public/scripts/extensions/third-party/ST-Vertex-PayGo/
   ```
4. 重新启动宿主程序（本项目**无额外 npm 依赖**，放入即用）。
5. 启动后，前端扩展设置面板中显示 `Server Plugin 已就绪` 即代表安装成功。

---

## 工作原理

```text
[前端扩展] --(1. Prepare 预检请求)--> [本后端插件] (生成一次性 Ticket + 临时 Token)
                                         |
[酒馆/Luker 后端] <--(2. 发送请求到 127.0.0.1 本地回环)--+
       |
  (3. 校验 Ticket/Token + 注入 PayGo Header)
       |
       v
[Google Vertex AI 官方接口]
```

1. **预检**：前端在发起生成前，先请求后端的 `/api/plugins/vertex-paygo/prepare` 接口。
2. **鉴权与签发**：插件校验模型、区域与层级后，从宿主获取当前用户的 Vertex 认证头，生成一张**5分钟有效、阅后即焚**的一次性票据（Ticket）和随机 Token，并返回仅限本地监听的代理地址（`127.0.0.1:xxxx`）。
3. **中继转发**：宿主把生成请求发往该本地回环地址，插件校验 Token 和请求参数无误后核销票据，追加对应的 PayGo 标头并转发给 Google。

*(注：浏览器不会直接连接回环端口，即使酒馆部署在远程 VPS 上，也是由 VPS 上的服务端进程内部访问 `127.0.0.1`，保证安全性。)*

---

## 运行日志

从 0.3.0 起，插件会把本次启动周期内的前后端关键状态写入宿主根目录：

```text
<SillyTavern 或 Luker 根目录>/st-vertex-paygo.log
```

- 插件每次启动都会先覆写该文件，不保留上一次启动的内容。
- 只有重新启动服务端（或重新初始化服务端插件）才会覆写；刷新浏览器页面不会清空日志。
- 日志使用 UTF-8 JSON Lines 格式；每行包含时间、来源（`server` / `client`）、级别、事件名和经过筛选的上下文。
- 日志文件最多为 5 MiB，其中客户端事件最多占 2 MiB；客户端额度用完后服务端事件仍可继续写入剩余空间。总上限用完后，本次启动周期不再追加新事件，避免长期运行占满磁盘。
- 管理员可以通过前端扩展查看并保存日志。服务端读取接口为 `GET /api/plugins/vertex-paygo/logs`，返回 `text/plain` 且禁止缓存。
- 管理员前端通过 `POST /api/plugins/vertex-paygo/logs/client` 上报受限的结构化事件。接口只接受专用媒体类型 `application/vnd.st-vertex-paygo.client-log+json`，在 JSON 解析前以原始字节流执行 4 KiB 硬限制；schema 只接受 `level`、`event` 和可选的白名单 `context`，不接受自由文本、错误堆栈或任意嵌套对象。
- 日志不会记录 Google 鉴权头、API Key、Ticket、代理 Token、请求 URL、请求体、提示词或模型响应。请勿为了排错自行把这些内容粘贴进日志或 Issue。

日志文件包含同一服务实例的合并运行状态，因此只有管理员可以写入客户端事件以及读取这份日志；普通已登录用户没有日志读写权限。
前端的“保存日志”会读取并下载最新的日志快照，不会修改服务端原文件；下载位置由浏览器设置决定。如果插件暂时不可用或页面已关闭，少量尚未上报的客户端事件可能无法写入文件。

---

## 请求头注入规则

以下表格用于 Vertex AI。Google AI Studio 的 Flex 复用相同的预检、认证助手、票据、日志和回环 HTTP 转发，使用 `generativelanguage.googleapis.com` 上经过校验的模型端点。

AI Studio 转发时仅缓冲有大小限制的 JSON 请求体，移除已有 `serviceTier` 并设置顶层 `service_tier: "flex"`；响应继续直接流式转发。它复用 `X-Server-Timeout: 1800` 和现有上游超时，不注入 Vertex 专用标头。Standard 由酒馆原生处理，AI Studio 的 Priority / PayGo-only 组合会在预检时拒绝。

酒馆通过查询参数 `key` 或认证头传递一次性代理凭据；真实 Google Key 只从服务端认证助手获取，并通过 `x-goog-api-key` 发往 Google，不复制本地代理查询参数。票据同时绑定来源、模型、API 版本和流式模式；Flex 容量不足等错误直接返回，不会自动以 Standard 费率重试。更新前后端后需要重启酒馆并刷新页面。

参数依据：[Google GenerateContent Flex 文档](https://ai.google.dev/gemini-api/docs/generate-content/flex-inference)。

| 选中的服务层级 | 自动追加的 Request Header |
| :--- | :--- |
| **开启 PayGo-only** | `X-Vertex-AI-LLM-Request-Type: shared` |
| **Flex** | `X-Vertex-AI-LLM-Shared-Request-Type: flex`<br>`X-Server-Timeout: 1800` |
| **Priority** | `X-Vertex-AI-LLM-Shared-Request-Type: priority` |

- `PayGo-only` 可与 `Flex` 或 `Priority` 组合使用（会同时注入两组请求头）。
- 若为 **Standard 且未勾选 PayGo-only**，属于原生默认请求，插件会直接拒绝签发代理票据，由宿主走官方原生通道。

---

## 安全机制

为了保证你的账号和网络安全，本插件设计了严格的安全限制：
- **仅本地监听**：代理服务仅绑定 `127.0.0.1` 随机端口，绝不对局域网或公网开放。
- **一次性票据**：每张票据 5 分钟有效，成功使用一次即作废，且带有随机 Bearer Token 保护。
- **纯内存存储**：票据、Token 及鉴权信息均保存在内存中，重启即焚，绝不落盘。
- **严格白名单**：仅允许 POST JSON 请求（上限 500 MiB），目标域名强匹配 Google 官方 Vertex AI 地址，不跟随任何上游 30x 重定向。
- **Header 过滤**：转发时仅透传 `Content-Type`、`Authorization`、`X-Goog-Api-Key` 及插件注入的 PayGo 标头，剥离其余无关字段。
- **安全日志**：只记录排错所需的模型、层级、区域、状态码和耗时等白名单元数据，不落盘认证信息或生成内容。

---

## 不支持的使用场景

- ❌ 非 Gemini 系列的 Vertex AI 模型。
- ❌ 非 Google Vertex AI 官方来源（如第三方转接 API）。
- ❌ 将 Flex / Priority 与区域端点（Regional Endpoints）混用。
- ❌ 把现有的第三方反代 URL 传入本插件。
- ❌ 将本插件当做长期、多人共享的公开 Google API 代理使用。

---

## 常见问题 (FAQ)

### Q: 启动时报错提示版本不兼容？
**A**: 
1. 检查运行目录是否为 SillyTavern 或 Luker 的根目录。
2. 确认宿主版本是否达到要求（SillyTavern ≥ 1.16.0 / Luker ≥ 2.7.0）。
3. 检查宿主目录下的 `src/endpoints/google.js` 是否存在且未被第三方魔改破坏。

### Q: 前端提示“协议或传输方式不匹配”？
**A**: 请确保前端扩展与本后端插件均更新到了最新版本（当前两端协议版本号需一致为 `1`，传输模式为 `loopback-http`）。

### Q: Flex 模式下长时间没有响应？
**A**: Flex（弹性调度）本身在 Google 端就允许排队与延迟执行。插件针对 Flex 设置了约 31 分钟的连接超时时间，请耐心等待 Google 调度返回。

### Q: Priority 模式下为何在后台看调度状态不一定是 Priority？
**A**: 插件会如实发送 `X-Vertex-AI-LLM-Shared-Request-Type: priority` 标头，但最终请求是否被判定为高优先级，取决于你的 GCP 项目配额、当前模型可用容量及 Google 端的排队策略。

### Q: 为什么无法查看或保存日志？
**A**: 日志是服务实例级的共享诊断信息，读取接口只允许管理员访问。还请确认前后端扩展都已升级到 0.3.0，浏览器允许下载，并且没有被反向代理缓存或拦截。

### Q: 启动时报错且没有生成日志文件？
**A**: 确认运行 SillyTavern/Luker 的系统用户对宿主根目录有创建和覆写 `st-vertex-paygo.log` 的权限。日志文件无法打开时，插件会拒绝初始化，以免给出日志功能可用的错误状态。

---

## 本地测试

如果你需要对本插件进行二次开发，可运行内置测试集：

```bash
node --test
```

---

## 开源协议

本项目采用 **[Mozilla Public License 2.0 (MPL-2.0)](LICENSE)** 协议开源。在修改并分发本项目代码时，请遵守 MPL-2.0 相关的开源与署名要求。
