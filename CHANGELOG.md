# 更新日志

## 未发布 · Google OpenAI 兼容桥接

- Vertex 桥接新增用户可选的 Gemini→OpenAI 网关，使用已绑定项目、区域、模型与服务账号，转换原生 JSON/SSE；AI Studio 保持原有 OpenAI 转发行为。
- Vertex 层级可独立选择或逐请求跟随已保存主 API 的层级/PayGo-only；原生 OpenAI 模式拒绝 Flex，Flex/Priority 要求 global，Flex 网关期限延长到 30 分钟。
- 桥接层级由服务端设置决定，拒绝 Vertex 调用方的 service_tier/serviceTier 覆盖；跟随设置失败明确报错，不降级、不换凭据或连接；网关日志分别保留 Gemini 转发正文、Google 原始响应及 OpenAI 客户端响应。

- 安全审查修复：补全具名凭据、JSON 转义和截断边界的日志脱敏；认证超时、取消或轮换 key 后仍保留未完成 OAuth 的并发名额。
- 请求体、模型目录和日志捕获改为固定块累积，避免大量微小数据块放大内存对象开销；增加异常上游断流与认证生命周期回归测试。

- 增加按用户控制的 localhost 浏览器 CORS Debug 选项，默认关闭，实际请求继续要求桥接 key。
- 模型列表接入 AI Studio 官方 OpenAI 目录及 Vertex 官方 Publisher Model 分页目录，保留官方 OpenAI 生成转发路径。
- 为 ST/Luker 增加默认关闭、按用户隔离的本机 `/openai/v1` 入口及已登录用户管理接口。
- 默认转发 Google AI Studio 与 Vertex AI 官方 OpenAI 兼容端点；支持 AI Studio key 和 Vertex 服务账号 OAuth，不支持 Express、不执行失败回退。
- 支持固定连接、`st-current` 别名、JSON/SSE 透传、访问 key 轮换和撤销；重启后关闭。
- 增加请求体、并发、超时和取消保护；不转发调用方凭据，不将桥接调用记入主聊天费用账本。

## 2026-09-22 · 0.4.0 对话用量与 Standard 代理

- 协议升级到 v2；Vertex AI 与 Google AI Studio 的 Gemini Standard 请求可经安全回环代理，且不注入 PayGo-only、Flex 或 Priority 参数。
- 透明解析流式 SSE 和非流 JSON 的累计 `usageMetadata`，支持拆包并保持原响应字节不变；缺失、截断、压缩或解析失败会留下明确的不完整记录。
- 新增按 SillyTavern 用户目录隔离、跨重启持久化的追加式 JSONL 对话用量账本，以及已鉴权、带稳定快照游标分页的 `GET /usage?chatId=...` 接口。
- `prepare` 新增 `usageChatId`、USD/百万 token 价格快照和独立随机 `usageId`；未知用量或价格不会被当作零费用。
- Vertex Express/Full 显式密钥 ID 通过宿主密钥存储和窄认证辅助函数严格适配；缺少所需接口或所选密钥时 fail closed，不会静默使用其他凭据。

## 2026-09-16 · 凭据与资源隔离修复

- AI Studio 严格按当前用户及 `secret_id` 选取密钥，缺失时不回退默认凭据。
- 为票据增加单用户额度、每分钟签发限速和认证前容量预留，防止单用户占满共享池。
- 为失败预检和未认证回环请求设置独立日志预算，保留有效请求的诊断空间。
- 修复票据及挂起认证预留过期后的额度释放，补充隔离与失败场景回归测试。

需同步更新前端扩展并重启酒馆。Vertex Express/Full 的显式密钥 ID 暂不支持，会明确报错拦截；未指定 ID 时保留原有认证方式。
