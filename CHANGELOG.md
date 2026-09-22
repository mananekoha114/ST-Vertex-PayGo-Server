# 更新日志

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
