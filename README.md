__这个文档是纯GPT编写的，阅读时请注意__

# ST Vertex AI PayGo Server Plugin

`ST-Vertex-PayGo` 前端扩展的配套 Server Plugin，为 SillyTavern 和 [Luker](https://github.com/funnycups/Luker) 中的 Google Vertex AI Standard PayGo-only、Flex 和 Priority 请求提供受限制的服务端传输层。

它不是通用反向代理，也不能单独提供界面功能。正常使用需要同时安装独立的 `ST-Vertex-PayGo` 前端扩展。

> 当前版本已验证兼容 SillyTavern 1.16.0、1.17.0、1.18.0，以及 Luker 2.7.0 的 release 分支。它是非官方插件，与 SillyTavern、Luker、Google 或 Google Cloud 没有隶属或认可关系。

## 为什么需要 Server Plugin

这些兼容宿主的原生 Vertex AI 请求没有提供 PayGo 服务层级选项。前端扩展负责选择和保存层级，Server Plugin 则在宿主服务端完成以下工作：

- 复用当前用户已经保存在宿主中的 Vertex AI 认证配置。
- 根据 Standard PayGo-only、Flex 或 Priority 注入对应的 Google 请求头。
- 为单次请求签发短期票据和随机凭据。
- 通过只监听 `127.0.0.1` 的临时 HTTP 端口接收宿主服务端转发的请求。
- 严格验证 Vertex AI 主机、模型、操作、查询参数和认证请求头后再连接 Google。

## 环境要求

- SillyTavern 1.16.0 或更高版本，或者 Luker 2.7.0 release 分支。
- Node.js 20 或更高版本。
- 已配置可用 Vertex AI Express 或完整服务账号认证的宿主用户。
- 配套的 `ST-Vertex-PayGo` 前端扩展。

插件启动时会读取宿主根目录的 `package.json` 和 `src/endpoints/google.js`。SillyTavern 版本低于 1.16.0、宿主不是 SillyTavern 或 Luker、版本号无效，或者缺少所需的 Vertex AI 配置接口时，插件都会拒绝启动。

## 安装

停止 SillyTavern 或 Luker，将本仓库放入宿主根目录下的：

```text
<宿主根目录>/plugins/ST-Vertex-PayGo-Server/
```

同时将前端仓库放入：

```text
<宿主根目录>/public/scripts/extensions/third-party/ST-Vertex-PayGo/
```

本项目没有需要单独安装的运行时 npm 依赖。重新启动宿主后，前端扩展应显示 Server Plugin 已就绪。

## 请求流程

1. 前端扩展在生成前向 `/api/plugins/vertex-paygo/prepare` 发送经过宿主登录和 CSRF 保护的控制请求。
2. Server Plugin 验证协议、来源、Gemini 模型、区域、认证模式和层级组合。
3. 插件调用宿主自身的 Vertex AI 配置接口，取得当前用户对应的 Google 目标地址和认证请求头。
4. 插件生成五分钟有效的一次性票据与随机代理凭据，并返回仅绑定到 `127.0.0.1` 的代理 URL。
5. 宿主服务端把实际生成请求发送到这个本机回送地址，并通过 Bearer 凭据证明它持有该票据。
6. 插件以原子方式验证凭据和完整请求后缀并消费票据，再次验证 Google 目标和请求头，最后将请求转发给 Vertex AI。

浏览器不会直接连接本机回送端口。即使宿主部署在远程服务器上，访问 `127.0.0.1` 的仍是宿主服务端进程。

## 服务层级请求头

| 设置 | 添加的请求头 |
| --- | --- |
| PayGo-only 开启 | `X-Vertex-AI-LLM-Request-Type: shared` |
| Flex | `X-Vertex-AI-LLM-Shared-Request-Type: flex`、`X-Server-Timeout: 1800` |
| Priority | `X-Vertex-AI-LLM-Shared-Request-Type: priority` |

PayGo-only 可以与 Flex 或 Priority 组合，因此对应请求可能同时包含两类 PayGo 请求头。

Standard 且 PayGo-only 关闭时必须使用宿主原生 Vertex AI 请求；Server Plugin 会拒绝为这种组合创建代理票据。

## 控制接口

宿主会把插件路由挂载在 `/api/plugins/vertex-paygo` 下：

- `GET /health`：返回插件版本、协议版本、传输类型和宿主兼容信息。
- `POST /prepare`：验证单次 Vertex AI 请求并签发代理票据。
- `/rejected`：前端 prepare 失败时使用的兜底拦截端点，始终拒绝请求。

当前通信协议版本为 `1`，传输类型为 `loopback-http`。这些接口主要供配套前端扩展调用；第三方集成必须完整实现协议握手、出错即拦截和代理 URL 校验，不能把 prepare 失败当作回退到原生请求的条件。

## 安全边界

- 本机代理只监听 `127.0.0.1` 的随机端口，不监听局域网或公网地址。
- 每张票据默认五分钟过期、只能成功消费一次，并由独立的随机 Bearer 凭据保护。
- 最多保留 256 张待使用票据；容量用尽时返回错误，不会静默逐出其他票据。
- 只接受 JSON `POST`，默认请求体上限为 500 MiB。
- 票据绑定模型、流式模式、Vertex 操作、区域、目标 URL 和认证请求头。
- 目标仅允许精确匹配的 Vertex AI HTTPS 主机与路径；不跟随上游重定向。
- 只允许 `Content-Type`、`Authorization` 和 `X-Goog-Api-Key` 进入 Google 请求，并由插件单独加入 PayGo 请求头。
- Flex 请求添加 1800 秒服务端超时提示；插件自身的上游连接超时为 31 分钟。
- 代理票据、凭据和解析后的 Google 认证信息只保存在内存中，插件退出时会清空。

这些限制用于缩小 Server Plugin 的权限范围，但不能替代宿主本身的账号、网络和文件系统安全配置。

## 不支持的用法

- 非 Gemini Vertex AI 模型。
- 非 Vertex AI API 来源。
- Flex 或 Priority 与区域端点组合。
- 把现有自定义反向代理传入 prepare。
- 将本机回送代理用作长期、多人共享或通用 Google API 代理。
- 在 SillyTavern 1.16.0 之前的版本、未经验证的宿主或缺少所需 Vertex AI 接口的分支上绕过兼容性检查运行。

## 常见问题

### 插件启动失败并报告版本不兼容

确认当前工作目录是 SillyTavern 或 Luker 根目录，并且 `package.json` 中的名称和版本符合上方环境要求。插件还需要宿主的 `src/endpoints/google.js` 导出兼容的 Vertex AI 配置接口；只有版本号符合要求但缺少该接口时，插件仍会拒绝启动。

### 前端显示协议或传输方式不匹配

确保前端扩展和 Server Plugin 来自相互兼容的版本。当前两端都要求协议 `1` 和 `loopback-http`。

### Flex 长时间没有返回

Flex 本身允许延迟执行。插件不会在宿主默认的短超时内提前中止，但上游请求仍会在约 31 分钟后超时。

### Priority 请求没有显示为 `ON_DEMAND_PRIORITY`

插件会发送 `X-Vertex-AI-LLM-Shared-Request-Type: priority`，但实际调度类型由 Vertex AI 根据模型、项目资格、配额和可用容量决定。

## 开发与测试

运行测试：

```powershell
node --test
```

测试覆盖协议和目标校验、请求头策略、SillyTavern/Luker 运行时适配、prepare、票据生命周期，以及本机回送代理的成功与失败路径。

## 许可与署名

Copyright © 2026 [Mana Nekoha](https://github.com/mananekoha114)（@mananekoha114）

本项目采用 [Mozilla Public License 2.0](LICENSE)（SPDX：`MPL-2.0`）许可。修改并分发本项目文件时，请遵守 MPL 2.0 的文件级开放源代码要求。
