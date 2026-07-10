# Security / 安全说明

## Report a Vulnerability / 报告漏洞

Do not disclose vulnerabilities in public issues, discussions, or pull requests. Use GitHub's private vulnerability reporting: **Security** tab → **Report a vulnerability**. Maintainers aim to acknowledge reports within 7 days.

请勿在公开 issue、discussion 或 PR 披露漏洞。请使用 GitHub 私密漏洞报告：**Security** 标签页 → **Report a vulnerability**。维护者目标是在 7 天内确认收到。

## Deployment Baseline / 部署基线

Docker Compose binds frontend `18928` and backend `18927` to `127.0.0.1` by default. Local development may leave auth secrets empty, but it must stay on a trusted machine.

Docker Compose 默认把前端 `18928` 和后端 `18927` 绑定到 `127.0.0.1`。本地开发可以留空鉴权密钥，但只能在可信机器上使用。

Before any LAN or public exposure:

1. Set `ENV=production`. / 设置 `ENV=production`。
2. Generate separate values for `SESSION_SECRET` and `ADMIN_TOKEN` with `openssl rand -hex 32`. / 使用该命令分别生成两个密钥。
3. Change the Compose port bindings deliberately and restrict network access. / 明确修改 Compose 端口绑定并限制网络访问。

生产模式缺少 `SESSION_SECRET` 或 `ADMIN_TOKEN` 会拒绝启动。不要复用示例值。

## Authentication Boundary / 鉴权边界

- `SESSION_SECRET` enables the coarse REST/WebSocket session gate.
- `ADMIN_TOKEN` protects `/api/admin/*`; `/metrics` accepts the configured admin token and, when enabled, a valid session token.
- This gate is not a complete multi-user authorization system. Public or multi-tenant deployment needs an external identity, authorization, TLS, proxy, logging, backup, and secret-management design.

- `SESSION_SECRET` 启用粗粒度 REST/WebSocket 会话门禁。
- `ADMIN_TOKEN` 保护 `/api/admin/*`；`/metrics` 接受配置的管理 token，也可在会话门禁启用时接受有效 session token。
- 这不是完整的多用户权限系统。公网或多租户部署还需外部身份、授权、TLS、代理、日志、备份和密钥管理方案。

## LLM and BYOK Trust Boundary / LLM 与 BYOK 信任边界

Deployment-level `LLM_RESPONSES_URL` is operator-controlled. Request-level BYOK `llm_base_url` is user input and passes host allowlisting, scheme checks, and URL-shape validation.

部署级 `LLM_RESPONSES_URL` 由管理员控制。请求级 BYOK `llm_base_url` 属于用户输入，必须通过 host 白名单、scheme 和 URL 形状校验。

- Never put API keys in URLs. Userinfo, query strings, fragments, and path parameters are rejected.
- Hosted request-level endpoints require HTTPS.
- `LLM_EXTRA_ALLOWED_HOSTS` accepts exact hosts only.
- Keep `LLM_ALLOW_PRIVATE_BYOK_HOSTS=false` for public or multi-user deployments.
- Set `LLM_ALLOW_LOCAL_BYOK_HOSTS=false` for LAN, public, or multi-user deployments.

- 不要把 API key 放进 URL；userinfo、query、fragment 和 path params 会被拒绝。
- 托管请求级 endpoint 必须使用 HTTPS。
- `LLM_EXTRA_ALLOWED_HOSTS` 只接受精确 host。
- 公网或多用户部署保持 `LLM_ALLOW_PRIVATE_BYOK_HOSTS=false`。
- LAN、公网或多用户部署设置 `LLM_ALLOW_LOCAL_BYOK_HOSTS=false`。

## Data and Output / 数据与输出

Model profiles may store API keys in local SQLite for a single-user installation. Keep the database, `.env`, `.env.docker`, snapshots, logs, and backups private. Public artifacts remove known secret fields, but the question and result content are intentionally shareable; review them before publishing.

单用户安装的 model profile 可能把 API key 存在本地 SQLite。请保护数据库、`.env`、`.env.docker`、Snapshot、日志和备份。公开 artifact 会移除已知密钥字段，但问题和结果本身会用于分享，发布前必须检查。

Client-facing LLM errors use short safe codes. Provider bodies, stack traces, Authorization headers, keys, and credential-bearing URLs must not reach clients or logs. 面向客户端的 LLM 错误只使用简短安全码；provider 正文、堆栈、Authorization header、密钥和含凭据 URL 不得进入客户端响应或日志。
