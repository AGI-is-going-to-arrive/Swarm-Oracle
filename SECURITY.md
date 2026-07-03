# Security Notes

## Reporting a Vulnerability / 报告漏洞

Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests. Use GitHub's private vulnerability reporting instead (this repository's **Security** tab -> **Report a vulnerability**) so the report stays private while a fix is prepared. You can expect an acknowledgement within 7 days.

请勿通过公开 issue、discussion 或 PR 披露安全漏洞。请使用 GitHub 私密漏洞报告（仓库 **Security** 标签页 -> **Report a vulnerability**），以便在修复完成前保持报告私密。我们会在 7 天内确认收到。

## Scope of This Document / 本文件范围

The rest of this document covers the LLM SSRF and BYOK trust boundaries that matter for operating SwarmOracle. It is deployment guidance for operators, not an exhaustive description of the project's security properties.

以下内容说明与运维部署相关的 LLM SSRF 与 BYOK 信任边界，供部署者参考，并非本项目安全属性的完整清单。

## LLM Endpoint Trust Boundaries

SwarmOracle has two separate LLM endpoint paths:

- Deployment-level `LLM_RESPONSES_URL` is configured by the server operator. The backend resolves it with `_resolve_llm_api_url()` and treats it as server-default trust. It does not pass through the request-level BYOK allowlist.
- Request-level BYOK `llm_base_url` comes from an API request. It is constrained by the request-level allowlist, URL shape checks, and the private/LAN opt-in controls described below.

Do not put API keys in URLs. Request-level BYOK URLs with userinfo, query strings, fragments, or path parameters are rejected; send credentials through the dedicated API key field.

## SSRF Threat Model

### Single-User Local

This is the lowest-risk mode: the backend and browser are run by the same person on one machine.

- Local aliases such as `localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, and `::1` remain allowed for request-level BYOK.
- The bundled local default `http://127.0.0.1:8317/v1` is considered an unconfigured static capability unless a real key or another endpoint is set.
- Keep admin diagnostics local unless you intentionally expose them.

### Trusted LAN

This mode has more SSRF risk because a browser user can ask the backend to connect to other LAN hosts.

- Add only the exact hosts you operate to `LLM_EXTRA_ALLOWED_HOSTS`.
- Set `LLM_ALLOW_PRIVATE_BYOK_HOSTS=true` only when those hosts are trusted LLM gateways.
- Prefer HTTPS where possible, even on a LAN.
- Do not add broad internal hostnames or infrastructure addresses.

### Multi-User Deployment

This is the highest-risk mode. Treat every request-level BYOK URL as attacker-controlled input.

- Keep `LLM_ALLOW_PRIVATE_BYOK_HOSTS=false`.
- Set `LLM_ALLOW_LOCAL_BYOK_HOSTS=false`; otherwise request-level BYOK can still ask the backend to call local aliases such as `127.0.0.1`, `localhost`, `0.0.0.0`, `host.docker.internal`, or `::1`.
- Avoid `LLM_EXTRA_ALLOWED_HOSTS` unless there is a concrete hosted provider or tenant gateway that needs it.
- Require `SESSION_SECRET`; protect admin endpoints with `ADMIN_TOKEN`.
- Keep request logs and error responses free of provider bodies, Authorization headers, API keys, and credential-bearing URLs.

## Request-Level BYOK Controls

`LLM_EXTRA_ALLOWED_HOSTS` is a comma-separated host list. Hosts are normalized with IDNA and lowercase before being merged into the request-level allowlist. It accepts hosts only, not URLs or credentials.

`LLM_ALLOW_PRIVATE_BYOK_HOSTS` defaults to `false`. When it is off, private, LAN, and loopback hosts supplied through the extra allowlist are rejected. When it is on, those hosts are permitted for request-level BYOK and may use local HTTP endpoints.

`LLM_ALLOW_LOCAL_BYOK_HOSTS` defaults to `true` for single-user local development and Docker quickstarts. Set it to `false` for multi-user, exposed, or LAN deployments to reject built-in local aliases and equivalent loopback / unspecified IP forms at the request-level BYOK boundary. Deployment-level `LLM_RESPONSES_URL` is not affected.

Hosted providers and other non-local request-level BYOK hosts still require HTTPS. Existing rejection of URL userinfo, query strings, fragments, and path parameters is preserved.

## Safe LLM Error Surface

The main user-facing LLM failure taxonomy is intentionally small:

- `LLM_UNREACHABLE`
- `LLM_AUTH_FAILED`
- `LLM_MODEL_NOT_FOUND`
- `LLM_RATE_LIMITED`

Each code is returned with a short safe message only. Raw provider response bodies, HTML, stack traces, Authorization headers, API keys, and credential-bearing URLs must not be exposed to clients.
