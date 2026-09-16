# ST Vertex AI PayGo Server Plugin

本项目是前端扩展 `ST-Vertex-PayGo` 的**配套后端插件（Server Plugin）**，为 SillyTavern（酒馆）及 Luker 提供 Google Vertex AI 的 **PayGo-only、Flex、Priority** 调度能力，并深度支持 **Google AI Studio 的 Flex** 弹性计费服务层级。

> ⚠️ **使用须知**：
> 1. 本项目**并非**通用的 Google API 外部反代，**亦不包含前端 UI**，必须配合前端扩展 [`ST-Vertex-PayGo`](https://github.com/mananekoha114/ST-Vertex-PayGo) 协同运行。
> 2. 已经过全面兼容性验证的环境：SillyTavern `1.16.0` / `1.17.0` / `1.18.0`，Luker `2.7.0` (release 分支)。
> 3. 本项目为社区独立开源插件，与 SillyTavern、Luker 官方团队或 Google Cloud 官方无商业隶属关系。

---

## 为什么需要此后端插件？

SillyTavern 与 Luker 原生请求管道并未对外暴露 Google 专有的 PayGo 调度层级标头与请求体参数。为了在**不侵入式篡改宿主源码、不破坏原生密钥安全存储机制**的前提下实现层级调度，必须采用前后端分离协作架构：

- **前端扩展**：负责在连接面板提供可视化的层级选择 UI，校验前置约束并持久化用户偏好。
- **后端插件（本项目）**：
  - **原生凭据复用**：直接经由宿主内部凭据上下文获取已配置的 Vertex AI / AI Studio 认证信息，无需二次配置或搬运密钥；
  - **动态标头/参数注入**：在代理转发阶段注入 Google 专用的调度标头或顶层参数；
  - **本地安全回环**：绑定宿主机 `127.0.0.1` 动态端口进行数据流转与参数二次校验；
  - **合并审计日志**：持久化保存当次运行周期的安全排错日志，支持管理员前端在线调取与离线排查。

---

## 环境要求

- **宿主程序**：SillyTavern ≥ 1.16.0 或 Luker ≥ 2.7.0（release 分支）
- **运行环境**：Node.js ≥ 20
- **前置依赖**：宿主内已配置可用的 Vertex AI（Express 快速密钥模式或 Service Account 服务账号均可）
- **配套组件**：已安装对应版本的 `ST-Vertex-PayGo` 前端扩展

> 💡 **启动防御机制**：插件启动时会自动对宿主的 `package.json` 与 `src/endpoints/google.js` 进行静态完整性校验。若宿主版本过低或核心路由被第三方破坏，插件将主动终止初始化以防引发未定义崩溃。

---

## 安装说明

1. 彻底关闭 SillyTavern 或 Luker 运行进程。
2. 将**本项目（后端插件）**放置于宿主根目录下的 `plugins` 文件夹中：
   ```text
   <宿主根目录>/plugins/ST-Vertex-PayGo-Server/
   ```
3. 将**配套前端扩展**放置于对应的第三方扩展目录下：
   ```text
   <宿主根目录>/public/scripts/extensions/third-party/ST-Vertex-PayGo/
   ```
4. 确认宿主根目录下的 `config.yaml` 中开启了插件支持：
   ```yaml
   enableServerPlugins: true
   ```
5. 重新启动宿主程序（本项目为零 npm 外部依赖，即装即用）。
6. 进入酒馆前端面板，若 PayGo 栏目内显示“`Server Plugin 已就绪`”，即说明前后端通信建立成功。

---

## 核心架构与工作流程

```text
[前端扩展] ------(1. /prepare 申请预检)------> [本后端插件] (签发一次性 Ticket + 临时 Token)
                                                   |
[酒馆/Luker 内部] <--(2. 请求发往本地 127.0.0.1 代理端口)--+
       |
  (3. 校验 Ticket/Token + 动态注入调度参数)
       |
       v
[Google 官方服务端] (Vertex AI / AI Studio)
```

1. **预检与鉴权校验**：前端发起会话生成前，首先调用后端的 `/api/plugins/vertex-paygo/prepare` 预检端点。
2. **凭据预留与签发**：插件在内部按用户校验模型、区域与层级后，在总并发池与单用户限额内预留票据槽位，从宿主提取对应用户的认证信息。成功后签发一张**5分钟有效期、单次核销作废**的一次性票据（Ticket）及随机 Bearer Token，并回传专有的本地回环监听端点。
3. **中继与参数重组**：宿主向该本地地址发起实际生成请求，插件校验请求合法性后立刻核销票据，追加对应的 PayGo 专有标头（或设置请求体参数），直接向 Google 官方接口流式转发。

*(注：代理接口严格限定本地回环 `127.0.0.1` 访问，即使宿主部署于云端服务器，外部网络也无法穿透访问代理端口，从架构层面杜绝滥用。)*

---

## 调度参数注入规则

### 1. Google Vertex AI
针对 Vertex AI 模式，请求将被注入相应的专用请求标头：

| 选中的服务层级 | 自动注入的 HTTP Request Header |
| :--- | :--- |
| **开启 PayGo-only** | `X-Vertex-AI-LLM-Request-Type: shared` |
| **Flex** | `X-Vertex-AI-LLM-Shared-Request-Type: flex`<br>`X-Server-Timeout: 1800` |
| **Priority** | `X-Vertex-AI-LLM-Shared-Request-Type: priority` |

- `PayGo-only` 可与 `Flex` 或 `Priority` 自由叠加（同时注入两组标头）；
- 若选择 **Standard 且未勾选 PayGo-only**，插件将在预检阶段直接拒绝签发票据，自动交给宿主走官方原生管道。

### 2. Google AI Studio (Flex)
Google AI Studio 的 Flex 模式复用相同的预检机制、鉴权助手、内存票据池与本地 HTTP 转发管道，端点直接面向 `generativelanguage.googleapis.com`：
- **请求体改写**：代理阶段仅在内存中缓冲受严格尺寸限制的 JSON 请求体，剥离原有的 `serviceTier` 并强制重构注入顶层字段 `service_tier: "flex"`；
- **流式透传**：下行数据继续保持无损流式响应（SSE），复用 `X-Server-Timeout: 1800` 等超时防护；
- **规则限制**：不注入 Vertex 专属标头。Standard 走酒馆原生管道；AI Studio 下任何附带 Priority 或 PayGo-only 的组合均会在预检阶段被直接拦截拒绝。

---

## 运行日志系统

自 0.3.0 起，插件会在宿主根目录下维护统一的结构化诊断日志：

```text
<SillyTavern 或 Luker 根目录>/st-vertex-paygo.log
```

- **覆盖策略**：每次启动宿主或重新加载插件时自动覆写初始日志，不保留上一周期的旧内容（浏览器刷新不影响日志文件）。
- **格式规范**：采用 UTF-8 JSON Lines 格式，每一行记录包含标准时间戳、来源标签（`server` / `client`）、日志等级、事件标识符与安全脱敏上下文。
- **空间配额与防爆保护**：
  - 单文件容量硬上限为 **5 MiB**，达到上限后停止追加写入，彻底防止长期挂机占满磁盘空间；
  - 客户端通过 API 上报的日志最大占用 **2 MiB** 独立空间；
  - 针对非法预检与匿名探针等低级警告，设定了独立的 2 MiB（或总容量 40%）噪声预算，耗尽后自动阻断此类日志，确保为核心业务排错留足写入空间。
- **接口安全与权限隔离**：
  - **严格权限控制**：诊断日志包含全局会话元数据，日志读取端点 `GET /api/plugins/vertex-paygo/logs` 仅对拥有**管理员权限**的已登录会话开放，并显式禁用下游缓存；
  - **受限上报通道**：客户端日志通过 `POST /api/plugins/vertex-paygo/logs/client` 接入，要求专有 MIME 类型 `application/vnd.st-vertex-paygo.client-log+json`，在 JSON 解析前执行 4 KiB 字节硬拦截，仅允许录入预设白名单枚举值，严禁上报任意自由文本或复杂对象。
- **绝对脱敏守则**：日志系统从架构上绝对禁止记录以下信息：Google 鉴权 Token、API Key 原文、服务账号私钥、Ticket 原文、代理 Token、生成提示词（Prompt）、模型生成回复及错误堆栈。

---

## 安全机制与多租户隔离

- **本地专属监听**：服务只监听 `127.0.0.1` 随机动态端口，坚决拒绝向局域网（0.0.0.0）或公网开放。
- **一次性票据防护**：票据生存期限制为 5 分钟，且具备单次核销特性，伴随高熵 Bearer Token 二次认证。
- **用户级限流与熔断**：全局默认最大保留 256 张活动票据，单用户最多持有 32 张未消费票据；单用户限制每分钟最多 30 次签发预检。配额在读取昂贵的 Google 认证前先行扣减，认证失败即刻退还槽位。
- **纯内存运行**：所有鉴权缓存、临时 Token 与票据状态完全基于内存，进程终止或重启立刻销毁，绝不落盘。
- **密钥安全与显式 ID 解析**：
  - AI Studio 模式下，指定的 `secret_id` 必须严格在宿主凭据库中匹配当前用户归属，查无此 Key 时直接报错中断，**坚决不回退到默认密钥**；
  - Vertex AI 模式目前暂不支持显式密钥 ID；一旦请求中携带特定凭据 ID，将直接抛出 `EXPLICIT_SECRET_UNSUPPORTED`，防止盲目回退到全局共享服务账号产生账单错乱。
- **请求内容清洗与白名单约束**：
  - 严格仅放行 POST JSON 格式请求（单个 Payload 上限 500 MiB）；
  - 目标主机名强匹配 Google 官方 API 域名，坚决不跟随上游 30x 重定向；
  - 仅透传 `Content-Type`、`Authorization`、`X-Goog-Api-Key` 及插件自有的 PayGo 必需标头，彻底剔除无关字段。

---

## 明确不支持的使用场景

- ❌ 非 Gemini 系列的模型（如 Vertex 内托管的 Claude、Llama、Mistral 等）。
- ❌ 非 Google 官方接口（任何第三方中转/中继 API）。
- ❌ 将 Flex / Priority 与具体区域节点（Regional Endpoints）混用。
- ❌ 将现有的第三方反代 URL 强行接入本插件。
- ❌ 将本插件的回环端口暴露给公网，作为多人共用的公开反代服务。

---

## 常见问题 (FAQ)

### Q: 启动服务时提示兼容性错误？
**A**:
1. 检查插件部署目录是否为酒馆根目录下的 `plugins/ST-Vertex-PayGo-Server/`；
2. 确认宿主版本是否满足基线要求（SillyTavern ≥ 1.16.0 / Luker ≥ 2.7.0）；
3. 检查宿主核心文件 `src/endpoints/google.js` 是否存在，或是否被其他侵入式插件修改。

### Q: 启动时报错且没有生成 `st-vertex-paygo.log`？
**A**: 请检查运行 SillyTavern / Luker 的操作系统用户对宿主根目录是否具备新建与覆写文件的权限。若日志文件无法成功创建，插件会自动终止初始化以防给出不一致的运行状态。

### Q: 前端显示“协议或传输方式不匹配”？
**A**: 说明前后端通信契约版本脱节。请确保前端扩展与本后端插件同步更新到最新版本（两端协议主版本号需保持一致，传输模式统一为 `loopback-http`）。

### Q: Flex 模式下长时间无生成响应？
**A**: Flex（弹性计费）层级在 Google 服务端遵循空闲排队执行原则。后端插件已针对 Flex 自动放宽上游超时保护至约 31 分钟，这属于官方预期特性，请耐心等待 Google 算力调度返回。

### Q: 无法调取或导出诊断日志？
**A**: 日志端点设有访问控制，仅允许具备管理员权限的会话读取。请确保前端账号具有对应权限，且网络路径上的反向代理未拦截该接口。

---

## 本地测试

进行二次开发或校验当前环境的兼容性时，可在插件根目录下运行内置测试套件：

```bash
node --test
```

---

## 开源协议

本项目采用 **[Mozilla Public License 2.0 (MPL-2.0)](LICENSE)** 协议开源。在二次修改并分发本项目源文件时，必须严格遵守 MPL-2.0 相关的源码同协议开源及作者版权署名规范。
