# Web Search + Source Family 整合实施计划

> **版本**: v1.1-audited | **创建日期**: 2026-05-13 | **审计更新**: 2026-05-13
> **输入文档**: `.claude/team-plan/llm-websearch-passthrough-research.md` (R3) + `.claude/team-plan/source-family-availability-research.md` (R3)
> **当前验证基线**: backend `2835 passed / 2 skipped` | frontend `184 files / 2004 tests passed` | tsc/lint/build 0 errors | ruff 0 errors
> **执行范围**: **P0 + P1 已完成 (2026-05-13)**。P2/P3/P4b/P5 涉及 public API、持久化 JSON、native LLM tools、provider adapters、浏览器矩阵和 release signoff，仍需单独确认后再执行。

---

## v1.1 审计结论与执行边界

### 2026-05-13 实施状态

- ✅ DONE — P0 baseline hardening 已完成，`WEB_SEARCH_PROVIDER=native` 保持 legacy placeholder，preflight 不再把它报成可用 provider。
- ✅ DONE — P1 app-layer / Source Family contract hardening 已完成：provider capability registry、xAI `filters.allowed_domains`、SearXNG 域名归一化、URL 后过滤、base/family 独立 try-block、family 扩展状态 parser、InputView domain-filter gate 均已落地。
- 已验证：backend full `2835 passed / 2 skipped`、backend Web Search 定向 `249 passed`、URL scheme 过滤窄集 `28 passed`、`ruff check .` 通过；frontend full vitest `184 files / 2004 passed`、InputView/API 定向 `76 passed`、tsc/lint/build 通过；Playwright 覆盖桌面 1440、移动 375 和 Chromium/Firefox/WebKit headless smoke。
- 仍保留给 P4a：ResultView / SourceCategoryCard 对 `failed / unsupported_provider / fallback_unconstrained / search_skipped` 等扩展状态的专门文案，active-provider capability selection，以及 disabled reason 的 `aria-describedby`。
- 仍 gated：P2 native LLM search contract，P3 provider adapters/auto discovery，P4b native citation UI，P5 release validation。

### 执行前审计结论（历史）

- App-layer search 已实现 4 个 provider：`tavily / exa / searxng / xai`。入口在 `backend/app/services/web_context.py:803-824`，当前没有 Tavily -> Exa 这类跨 provider fallback chain。
- Source Family 当前只有 `state/items` envelope。生产者只会写 `empty/ready`，解析白名单还支持旧 UI 状态 `loading/rate_limited/network_error`：`backend/app/services/web_context.py:234-243`、`backend/app/services/web_context.py:267-271`、`backend/app/api/helpers.py:1143-1146`。
- `create_scenario()` 当前只有 `fetch_web_context()` 返回非空时才会跑 `fetch_family_context()`，并且 base/family 在同一个 `try` 内：`backend/app/api/scenarios.py:735-768`。P1 必须修正短路和异常隔离。
- xAI app-layer provider 当前发送 Responses `tools: [{"type":"web_search"}]`，但 family 域名只写进 prompt，不是 official `filters.allowed_domains`：`backend/app/services/web_context.py:758-764`、`backend/app/services/web_context.py:780-783`。
- xAI 结构化结果解析和 citation fallback 当前不会验证 URL 是否属于 family domain：`backend/app/services/web_context.py:686-698`、`backend/app/services/web_context.py:701-726`。P1 必须加结果后过滤，避免 off-domain 结果被标成 `ready`。
- `WEB_SEARCH_PROVIDER=native` 当前是 legacy/placeholder：config 允许，runtime 跳过，capabilities 不 ready，但 preflight 误报 pass：`backend/app/config.py:172-180`、`backend/app/services/web_context.py:874-879`、`backend/app/api/scenarios.py:437-438`、`backend/app/services/preflight.py:91-92`。P0 必须先修正这个一致性问题。
- 前端 wire-format 已实现：只有 `webSearchEnabled=true` 才发送 `web_search_enabled/web_search_families`，`preflightMode=true` 会剥离 provider/key/base URL：`frontend/src/api/client.ts:310`、`frontend/src/api/client.ts:329-333`。P0 要补测试落点。

### 原安全执行门（历史）

- **已执行完成**：P0 + P1，目标是锁定当前行为、修正 app-layer/source-family contract、xAI app-layer domain filters、SearXNG contract、capabilities/provider contract、前端 family disabled UX。
- **不可直接执行**：P2/P3/P4b/P5。必须先由用户确认，因为它们涉及 native LLM search、API/schema 扩展、持久化 JSON 新字段、跨 provider adapters、浏览器矩阵和 release signoff。
- **文档门**：完成代码实施后，不自动更新 `llmdoc/` 或项目文档。只有用户明确选择 `使用 recorder agent 更新项目文档`，才执行文档同步。

---

## 代码锚点审计表

| 原计划/待核锚点 | 审计结果 | 计划修正 |
|----------------|----------|----------|
| `backend/app/services/web_context.py:145-179` | 正确。`FAMILY_DOMAIN_FILTERS` 在该范围内。 | 保留为 Source Family 域名映射真值。 |
| `backend/app/services/web_context.py:225,234` | 签名从 `225-229` 开始，默认 envelope 从 `234-243` 开始；完整函数到 `273`。 | 所有实施引用改成 `225-273`。 |
| `backend/app/services/web_context.py:328,780` | `328` 只是 xAI default base URL；xAI Responses `tools` 实际在 `780-783`。 | 删除 `328` 的 tools 语义，只用 `780-783`。 |
| `backend/app/services/web_context.py:366` | `366` 是 default provider 读取；完整 `_resolve_request_config` 为 `361-375`。 | 引用改成 `361-375`。 |
| `backend/app/services/web_context.py:452,486` | `_search_tavily` 签名从 `452` 开始，`include_domains` 写入 body 在 `486-487`。 | 保留，补充 `452-489` 作为上下文范围。 |
| `backend/app/services/web_context.py:513-560` | 函数实际到 `562`，`560` 仍在 append 循环内。 | 引用改成 `513-562`。 |
| `backend/app/services/web_context.py:590,623` | `_search_exa` 签名从 `590` 开始，`includeDomains` 写入在 `623-624`。 | 保留，补充 `590-624`。 |
| `backend/app/services/web_context.py:803-808` | `_PROVIDER_MAP` 只包含 `tavily/exa/searxng/xai`。 | 明确当前没有跨 provider fallback chain。 |
| `backend/app/services/web_context.py:874-879` | `provider == "native"` runtime 直接返回 None。 | P0 先修正 preflight/capability 一致性，不启用 native。 |
| `backend/app/api/scenarios.py:735-768` | `fetch_web_context` 与 `fetch_family_context` 在同一 `try`，且 family 依赖 base result 非空。 | P1 改成 base/family 独立、异常隔离。 |
| `backend/app/config.py:67,172-180` | `ENABLE_WEB_SEARCH` 在 `67`；validator 仍允许 `native`。 | 纠正旧 `config.py:66`，P0 处理 native placeholder。 |
| `frontend/src/api/client.ts:310,329-333` | `preflightMode` 和 web search request body 条件发送真实存在。 | P0 前端 wire-format 测试落点。 |
| `frontend/src/types.ts:13-30` + `SourceCategoryCard.tsx:13-18` | 当前 state union 只有旧 5 状态。 | P1/P4a 扩展 state，不新增平行 status。 |

---

## 术语表

| 缩写 | 含义 |
|------|------|
| **App-layer presearch** | 场景创建时 `web_context.py` 调用 Tavily/Exa/SearXNG/xAI 获取摘要，结果存入 `Scenario.web_context_json` |
| **LLM native search** | LLM 调用 payload 中携带 `tools: [{"type":"web_search"}]` 或等价 provider 扩展字段，由模型自行发起搜索 |
| **Source Family** | 四个域名过滤分类搜索 (polymarket/finance/academic/news_deep)，当前仅走 app-layer |
| **BYOK** | Bring Your Own Key — LLM BYOK (`llm_api_key/base_url`) 和 Web Search BYOK (`web_search_api_key/base_url`) 必须独立 |
| **Capability gate** | `GET /api/capabilities` 返回的功能开关，前端通过 `useCapabilityCheck` 消费 |
| **Provider adapter** | 针对特定 LLM provider 的 native search 适配器（封装 tools/params/citation 解析） |

---

## 架构决策记录 (ADR)

### ADR-1: 不设全局 `web_search_enabled` native search 开关

**决策**: `web_search_enabled` 仅控制 app-layer presearch 和 Source Family。LLM native search 由独立的 per-provider adapter + capability gate 控制。

**原因**: 各 provider native search 参数完全不同 (xAI Responses `tools`, OpenAI Responses `tools`, Anthropic Messages server tool, Gemini `google_search`, Perplexity `search_domain_filter`, Qwen `enable_search`/`search_options`)。单一 bool 无法安全映射到所有 provider。

**代码锚点**: `backend/app/services/llm_client.py:504-527,1447-1509,1851-1925` — 当前 `llm_call` / `llm_call_stream` payload 构建无 native `tools` 字段；`backend/app/config.py:67` — `ENABLE_WEB_SEARCH` 仅控制 app-layer。

### ADR-2: DeepSeek / MiniMax core chat / unknown proxy 默认不启用 native search

**决策**: 对无官方 native search API 的 provider 和无法验证的 OpenAI-compatible proxy，默认 `native_search_capability=disabled`，仅走 app-layer fallback 或显式 MCP/tool 集成。

**原因**: DeepSeek Chat `tools` 只支持 `function` 类型；MiniMax 无 `web_search` 参数；OpenAI-compatible proxy 可能静默丢弃未知字段或返回 `400/422`。

**代码锚点**: `backend/app/services/llm_client.py:33-50` — `_LLM_URL_ALLOWLIST` 不含 `api.x.ai`；`backend/app/services/web_context.py:803-808` — `_PROVIDER_MAP` 仅 4 个 app-layer provider。

### ADR-3: LLM BYOK 与 Web Search BYOK 严格隔离

**决策**: 任何场景下不得复用 `llm_api_key` 作为 web search provider key，反之亦然。两套 BYOK 在 schema、validation、storage、transmission 各层完全独立。

**代码锚点**: `backend/app/schemas.py:97-111` — 两组字段；`backend/app/api/scenarios.py:738-743,751-755` — 两套解析；`backend/app/services/web_context.py:361-375` — `_resolve_request_config` 不读 LLM key。

### ADR-4: Source Family 域名过滤的 provider capability contract

**决策**: Source Family 仅对满足以下条件的 provider 显示 "ready"：
1. `supports_domain_filter: true` — API 级或 query 级域名约束
2. `supports_sources: true` — 返回带 URL 的 source/citation metadata
3. `domain_filter_mode` 为 `api` (Tavily/Exa/xAI official) 或 `query` (SearXNG `site:`)

`domain_filter_mode=prompt` 视为 "best-effort"，不得宣称 "strong domain filter"。`domain_filter_mode=none` 不显示为 Source Family ready。

### ADR-5: xAI `allowed_domains` 超限策略

**决策**: xAI 官方限制 max 5 `allowed_domains`。对超过 5 个域名的 family (如 finance 7 个, academic 7 个, news_deep 7 个):
- **首选**: 截断到 top-5 高价值域名 + 在 `family_context` 记录 `domain_coverage: "partial"`
- **回退**: 如截断后覆盖率 < 60%，降级为 `domain_filter_mode=prompt` 并记录 `fallback_mode: "prompt"`
- **禁止**: 静默截断并宣称完整 family coverage

### ADR-6: Fail-soft fallback 链

```
native search requested
  → capability known?
    → NO → strip native params, normal LLM call, optional app-layer presearch
    → YES → send provider-specific native request
      → unsupported/400/401/403/404/422/429/timeout/200-body-error?
        → YES → strip native params, retry normal LLM call once
          → record native_search_state = fallback_*
        → NO → success, parse citations/sources
  → app-layer presearch also requested?
    → YES → independently call search provider (non-blocking)
    → NO → continue with or without web context
```

### ADR-7: Source Family 只扩展 `state`，不新增平行 `status`

**决策**: P1 仅扩展 `family_context[family].state`，不要同时新增 `status` 字段。当前前后端已经围绕 `state/items` 建模，新增平行字段会让 parser、UI 和历史 JSON 产生双状态歧义。

**允许状态**: `ready / empty / failed / search_skipped / unsupported_provider / fallback_unconstrained`。`polymarket` 的地域限制继续使用现有 `geo_gated + configured_host` 字段，不把它混入通用 state。

**代码锚点**: `backend/app/services/web_context.py:234-243,267-271`、`backend/app/api/helpers.py:1143-1146`、`frontend/src/types.ts:13-30`、`frontend/src/components/result/SourceCategoryCard.tsx:13-18`。

### ADR-8: `WEB_SEARCH_PROVIDER=native` 是 P0 一致性缺陷，不是可执行 native search

**决策**: P0 先把 `native` 的 config/runtime/capability/preflight 行为统一为「不可用/未实现」。不要把 `native` 当作本轮可用 provider，也不要让 preflight 返回 pass。

**代码锚点**: `backend/app/config.py:172-180` 允许 `native`；`backend/app/services/web_context.py:874-879` 跳过；`backend/app/api/scenarios.py:437-438` capabilities 不 ready；`backend/app/services/preflight.py:91-92` 当前误报 pass。

### ADR-9: Native LLM search 是 gated backlog

**决策**: P2/P3 不在本轮直接执行。进入 native LLM search 前，必须先确认 public API、状态持久化、citation 存储、provider headers、retry/fallback 和浏览器展示的完整 contract。

**直接原因**: 这部分会改动 `llm_client.py` 主调用链、`web_context_json` schema、ResultView 展示和 provider-specific adapters，风险与文件数量都超出当前可安全直接执行范围。

### ADR-10: Source Family 结果必须做 URL 后过滤

**决策**: 即使 provider 声称支持域名过滤，`fetch_family_context()` 仍必须对返回 URL 做 family domain 后过滤。xAI 当前只是 prompt 约束；SearXNG `site:` 也不能替代最终 URL 校验。

**当前状态**: P1 已把 xAI app-layer family search 改为 `filters.allowed_domains`，并保留 URL 后过滤；SearXNG 也会先归一化域名再构造 `site:` query。

### ADR-11: P1 可增加结构化 provider outcome，但要一次性更新所有调用者

**决策**: 如果把 `_search_with_provider()` 从 `list[WebSearchSnippet]` 改为结构化 outcome，必须在同一 patch 中更新 `fetch_web_context()`、`fetch_family_context()`、缓存写入和测试，不能留下混合返回签名。

**建议形状**:

```python
@dataclass(frozen=True)
class ProviderSearchOutcome:
    snippets: list[WebSearchSnippet]
    state: Literal["ready", "empty", "failed", "search_skipped", "unsupported_provider", "fallback_unconstrained"]
    domain_filter_mode: Literal["api", "query", "prompt", "none"]
    domain_coverage: Literal["full", "partial", "none"]
    status_reason: str | None = None
```

---

## Phase 总览

| Phase | 可执行性 | 目标 | 预计规模 | 依赖 |
|-------|----------|------|----------|------|
| **P0** | ✅ **DONE 2026-05-13** | 基线锁定 + `native` placeholder 一致性修复 | 已落地 | 无 |
| **P1** | ✅ **DONE 2026-05-13** | app-layer search / Source Family contract 加固 | 已落地 | P0 |
| **P4a** | **READY TO PLAN** | Source Family UI 状态、disabled UX、i18n | 需重新估算 | P1 capability contract |
| **P2** | **GATED** | native/proxy 状态模型与持久化 contract 设计 | 需单独确认 | P1 |
| **P3** | **GATED** | xAI native search pilot；其他 provider 只保留研究 backlog | 需单独确认 | P2 |
| **P4b** | **GATED** | native citation / proxy fallback UI | 需单独确认 | P2/P3 |
| **P5** | **GATED** | release validation 与跨浏览器签收 | P4a 或 native path 定界后再执行 | P4a；native 分支还依赖 P2/P3/P4b |

**当前 handoff**: P0 + P1 不再交给 `ccg:team-exec` 重做；后续建议先执行 P4a。P2/P3/P4b/P5 必须等待用户再次确认。

---

## P0: 基线锁定

### 目标
锁定当前搜索行为的回归测试基线，并先修正 `WEB_SEARCH_PROVIDER=native` 的 config/runtime/capability/preflight 不一致，确保后续改动不建立在错误前提上。

### P0-0: `native` provider placeholder 一致性修复

**涉及文件**:
- `backend/app/config.py:172-180` — provider validator 当前仍允许 `native`
- `backend/app/services/web_context.py:874-879` — runtime 对 `native` 直接跳过
- `backend/app/api/scenarios.py:430-448` — capabilities 对 `native` 返回未启用
- `backend/app/services/preflight.py:91-92` — 当前误报 pass
- `backend/tests/test_web_search_contract.py` 或 `backend/tests/test_preflight_cli.py` — 新增/补充测试

**改动**:
1. 不在 P0 启用 native search；只统一为「未实现/不可用」。
2. `provider == "native"` 时 preflight 必须返回 `warn` 或 `fail`，不得返回 `pass`。
3. capabilities 继续返回 `server_enabled=false`，并可追加 `degraded_mode="native_not_implemented"`。
4. 是否从 config validator 移除 `native` 由实施者二选一：
   - **保守方案**: 继续允许 legacy env，但 preflight/capabilities 明确不可用。
   - **严格方案**: validator 移除 `native`，同时修正所有测试和文档。

**风险**: 低到中。严格方案可能影响已有 env；默认使用保守方案。
**退出标准**: `WEB_SEARCH_PROVIDER=native` 不再出现 preflight pass，且 scenario 创建不触发 provider 请求。

### P0-1: `_resolve_llm_api_url()` 表驱动测试

**涉及文件**:
- `backend/app/services/llm_client.py:114-130` — URL 解析逻辑
- `backend/tests/test_llm_client.py` — 新增测试

**改动**:
```python
# test_llm_client.py 新增 ~60 LOC
@pytest.mark.parametrize("input_url,expected_url", [
    ("https://api.x.ai/v1", "https://api.x.ai/v1/chat/completions"),
    ("https://api.x.ai/v1/responses", "https://api.x.ai/v1/responses"),
    ("https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"),
    ("https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"),
    ("http://localhost:8317/v1", "http://localhost:8317/v1/chat/completions"),
    ("http://localhost:8317/v1/responses", "http://localhost:8317/v1/responses"),
    ("https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"),
    ("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions"),
    ("https://api.x.ai/v1/", "https://api.x.ai/v1/chat/completions"),  # trailing slash
])
def test_resolve_llm_api_url_matrix(input_url, expected_url):
    assert _resolve_llm_api_url(input_url) == expected_url
```

**风险**: 低。纯回归测试。
**退出标准**: 全部参数化用例通过。

### P0-2: 无 native search payload 回归测试

**涉及文件**:
- `backend/app/services/llm_client.py:504-527,1447-1509,1851-1925` — `llm_call` / `llm_call_stream` payload 构建
- `backend/tests/test_llm_client.py` — 新增测试

**改动**: ~40 LOC，断言 `llm_call()`、`llm_call_stream()` 和相关 payload helper 构建的 payload 中不包含 `tools`, `tool_choice`, `tool_calls`, `web_search`, `web_search_options`, `google_search`, `grounding`, `enable_search`, `search_options` 字段。

**风险**: 低。
**退出标准**: payload 形状断言全部通过。

### P0-3: Roundtable Analyst app-layer search 回归

**涉及文件**:
- `backend/app/services/roundtable_analyst.py:348,356` — `fetch_web_context` 调用
- `backend/tests/test_roundtable_analyst.py` — 新增测试

**改动**: ~35 LOC
- `ENABLE_WEB_SEARCH=false` 时 `search_web_context` 工具不发请求
- `fetch_web_context` 返回 None/空 snippets 时工具返回空结果
- 确认不使用 request-scoped BYOK override

**风险**: 低。
**退出标准**: 3 个新测试通过。

### P0-4: BYOK LLM key 不进入 web search 分离测试

**涉及文件**:
- `backend/tests/test_web_context_integration.py` — 新增测试

**改动**: ~40 LOC
- `llm_api_key` 存在但 `web_search_api_key` 缺失 → `fetch_web_context` 不接收 LLM key
- `llm_base_url` 存在但 `web_search_base_url` 缺失 → `fetch_web_context` 不接收 LLM base URL
- 反向: `web_search_api_key` 存在但 `llm_api_key` 缺失 → `llm_call` 不接收 search key

**风险**: 低。
**退出标准**: 分离断言全部通过。

### P0-5: Source Family 当前短路行为回归测试

**涉及文件**:
- `backend/app/api/scenarios.py:735-768` — base search 和 family search 当前同处一个 `try`
- `backend/tests/test_web_context_integration.py` — 新增测试

**改动**: ~30 LOC
- 当 `fetch_web_context` 返回 None → `fetch_family_context` 不被调用
- 当 `FEATURE_NEW_SOURCES=false` → family search 分支不进入
- 当 `fetch_family_context` 抛异常 → 当前会丢弃 base `web_context_json`，此行为只作为 P1 修复前基线记录

**风险**: 低。注意: 这是 P1 要改掉的当前行为，不是长期目标。
**退出标准**: 短路行为有测试覆盖。

### P0-6: 前端 wire-format 回归测试

**涉及文件**:
- `frontend/src/api/client.ts:310,329-333` — request body 构建
- `frontend/src/api/client.test.ts` — 可新增直接单测；若项目不接受新文件，则扩展 `frontend/src/pages/InputView.test.tsx`

**改动**: ~50 LOC
- `webSearchEnabled=false` → request body 无 `web_search_enabled`, `web_search_families`
- `webSearchEnabled=true` + server_default mode → body 有 `web_search_enabled: true` + `web_search_families`，无 `web_search_provider/api_key/base_url`
- `webSearchEnabled=true` + custom_override → body 有全部 4 个字段
- `preflightMode=true` → body 无 `web_search_provider/api_key/base_url` (数据最小化)

**风险**: 低。
**退出标准**: wire-format 断言全部通过。

### P0 并行 Agent 分工

| Agent | 角色 | 任务 | 文件锁 |
|-------|------|------|--------|
| Claude-BE-0 | Worker | P0-0 | `preflight.py`, `test_web_search_contract.py` / `test_preflight_cli.py` |
| Claude-BE-1 | Worker | P0-1 + P0-2 | `test_llm_client.py` |
| Claude-BE-2 | Worker | P0-3 + P0-5 | `test_roundtable_analyst.py`, `test_web_context_integration.py` |
| Claude-BE-3 | Worker | P0-4 | `test_web_context_integration.py` (追加，与 BE-2 串行) |
| Claude-FE-1 | Worker | P0-6 | `client.test.ts` |

**注意**: BE-2 和 BE-3 共用 `test_web_context_integration.py`，必须串行（BE-2 先，BE-3 后）。

### P0 验证命令

```bash
# 后端
cd backend && source .venv/bin/activate
python -m pytest tests/test_llm_client.py tests/test_roundtable_analyst.py tests/test_web_context_integration.py tests/test_web_search_contract.py -v

# 前端
cd frontend && npm test -- src/api/client.test.ts --reporter=verbose

# 全量回归
cd backend && source .venv/bin/activate && python -m pytest
cd frontend && npm test --
```

### P0 退出标准

- [x] 全部 P0 新测试通过
- [x] `WEB_SEARCH_PROVIDER=native` 不再 preflight pass
- [x] 后端全量 `pytest` 无新增失败：`2835 passed / 2 skipped`
- [x] 前端全量 `vitest` 无新增失败：`184 files / 2004 passed`
- [x] `ruff check .` 0 errors
- [x] `npx tsc --noEmit -p tsconfig.app.json` 0 errors

### P0 Review Gate

- [x] Codex adversarial review: 审查所有新测试是否真正断言了预期行为
- [x] Claude cross-review: 确认测试覆盖了 research 文档中标记的所有 HC-* 硬约束
- [x] 基线数字记录到 plan 中

---

## P1: 搜索与 Source Family 加固

### 目标
加固当前 app-layer 搜索路径，引入 provider capability contract，修复 xAI 域名过滤，收紧前端 UX gate。

### P1-1: Provider capability contract 数据结构

**涉及文件**:
- `backend/app/services/web_context.py` — 新增 ~80 LOC
- `backend/tests/test_web_context.py` — 新增 ~60 LOC
- `backend/app/api/scenarios.py:430-448,465-590` — capabilities 读取该 contract
- `frontend/src/api/client.ts` — `CapabilitiesResponse` 类型同步

**改动**:
```python
# web_context.py 新增
@dataclass(frozen=True)
class ProviderSearchCapability:
    supports_domain_filter: bool
    supports_sources: bool
    domain_filter_mode: Literal["api", "query", "prompt", "none"]
    max_domains: int | None = None  # None = unlimited
    supports_citation_url: bool = True

PROVIDER_CAPABILITIES: dict[str, ProviderSearchCapability] = {
    "tavily": ProviderSearchCapability(
        supports_domain_filter=True, supports_sources=True,
        domain_filter_mode="api", max_domains=300,
    ),
    "exa": ProviderSearchCapability(
        supports_domain_filter=True, supports_sources=True,
        domain_filter_mode="api", max_domains=1200,
    ),
    "searxng": ProviderSearchCapability(
        supports_domain_filter=True, supports_sources=True,
        domain_filter_mode="query", max_domains=None,
    ),
    "xai": ProviderSearchCapability(
        supports_domain_filter=True, supports_sources=True,
        domain_filter_mode="api", max_domains=5,  # official limit
    ),
    "native": ProviderSearchCapability(
        supports_domain_filter=False, supports_sources=False,
        domain_filter_mode="none",
    ),
}
```

**注意**: 这不是纯数据结构。P1-5/P1-6/P1-7 会立刻消费该 contract，因此必须先落地后端测试，再让前端读取新字段。

**风险**: 低到中。字段命名会成为前后端契约。
**退出标准**: 数据结构通过类型检查和冻结性测试；capabilities response 和 TS 类型同步。

### P1-2: xAI 域名过滤从 prompt 升级为 official `filters.allowed_domains`

**涉及文件**:
- `backend/app/services/web_context.py:729-798` — `_search_xai()` 改动 ~90 LOC
- `backend/app/services/web_context.py:686-698,701-726` — xAI structured/fallback URL 后过滤
- `backend/tests/test_web_context.py` — 新增/修改 ~100 LOC

**改动**:
1. `_search_xai()` 中 `tools` 字段增加 `filters` (`backend/app/services/web_context.py:780-783` 区域):
   ```python
   tools = [{"type": "web_search"}]
   if include_domains:
       capped = include_domains[:5]  # xAI max 5
       tools = [{"type": "web_search", "filters": {"allowed_domains": capped}}]
       if len(include_domains) > 5:
           domain_coverage = "partial"
   ```
2. 移除当前 `backend/app/services/web_context.py:758-764` 的纯 prompt 域名注入，不再把 overflow domains 塞回 prompt 伪装成过滤。
3. 对 xAI 返回的 structured snippets 和 annotation fallback 统一做 URL 后过滤；off-domain 结果必须丢弃。
4. 返回或记录 `domain_coverage`: `"full"` (≤5), `"partial"` (>5), `"none"` (无域名)。建议通过 `ProviderSearchOutcome` 返回，而不是只在 `_search_xai()` 内部局部变量记录。

**测试覆盖**:
- `include_domains=None` → `tools` 无 `filters`
- `include_domains=["a.com","b.com"]` (≤5) → `filters.allowed_domains` 正确
- `include_domains` 7 个 → 截断到 5 + `domain_coverage="partial"`，不把剩余域名写回 prompt
- `include_domains=[]` → 无 `filters`
- xAI 返回 off-domain URL → snippets 被后过滤为空或仅保留 on-domain
- HTTP 400 (unsupported filter) → state 标记 `fallback_unconstrained` 或 `failed`；是否重试无 filter 必须显式记录，不能返回 `ready`

**风险**: 中。xAI API 可能对 `filters` 字段有未文档化的限制。需要 contract test fixture。
**退出标准**: 全部参数化测试通过；`domain_coverage` 字段正确设置；off-domain xAI URL 不会进入 family item。

### P1-3: SearXNG `site:` 契约加固

**涉及文件**:
- `backend/app/services/web_context.py:513-562` — `_search_searxng()` 改动 ~40 LOC
- `backend/tests/test_web_context.py` — 新增 ~60 LOC

**改动**:
1. `include_domains=None/[]` 时显式记录 `domain_filter_applied=False`
2. 域名包含特殊字符 (空格, 引号, 括号) 时转义或跳过
3. JSON 输出未启用时由 provider outcome 标记 `failed` 或 `search_skipped`，不得只吞异常后让 family 呈现 `ready`
4. 返回 URL 仍要按 family domain 后过滤，不能只信任 `site:` query

**测试覆盖**:
- `site:` query 正确构建 (`(query) (site:a OR site:b)`)
- `include_domains=None` → 原始 query，无 `site:`
- `include_domains=[]` → 原始 query，无 `site:`
- 域名含特殊字符 → 安全处理
- JSON 未启用 → `resp.json()` 失败 → 返回空 outcome + `state="failed"`，日志包含 provider/family

**风险**: 低。SearXNG 是自托管，行为可控。
**退出标准**: 全部 SearXNG 契约测试通过。

### P1-4: Source Family 短路策略调整

**涉及文件**:
- `backend/app/api/scenarios.py:735-768` — 改动 ~60 LOC
- `backend/tests/test_web_context_integration.py` — 新增 ~80 LOC

**改动 (ADR: 改为独立)**:
```python
# backend/app/api/scenarios.py:735-768 改动
# 旧: family search 只有在 web_result is not None 时才执行，且异常会丢掉 base context
# 新: Source Family 搜索独立于 base search
if settings.FEATURE_NEW_SOURCES and req.web_search_families:
    family_config = _build_family_request_config(req)
    try:
        family_context = await fetch_family_context(
            question, req.web_search_families, request_config=family_config
        )
        if web_result is not None:
            web_result.family_context = family_context
        else:
            # base search 失败但 family search 成功: 构建最小 WebSearchResult
            web_result = WebSearchResult(
                query=question,
                snippets=[],
                provider=family_config.provider,
                timestamp=datetime.now(UTC).isoformat(),
                cached=False,
                family_context=family_context,
            )
    except Exception:
        logger.warning("Family context fetch failed", exc_info=True)
        # family 失败不影响 base search 结果
```

**测试覆盖**:
- base search None + family search 成功 → scenario 有 `family_context`
- base search 成功 + family search 失败 → scenario 有 base snippets
- base search None + family search 失败 → scenario 无 web context (正常创建)
- base search 成功 + family search 成功 → 两者合并

**风险**: 中。改变了当前的短路行为。避免使用伪 provider `"family_only"`，使用实际 provider 并保持 `WebSearchResult.to_json()` schema 兼容。
**退出标准**: 四种组合全覆盖；全量回归无新增失败。

### P1-5: Source Family `state` contract 扩展

**涉及文件**:
- `backend/app/services/web_context.py:225-273` — `fetch_family_context()` 改动 ~60 LOC
- `backend/app/api/helpers.py:1101-1208` — `_parse_web_context_json()` 允许新状态
- `frontend/src/types.ts:13-30` — family state union 同步
- `frontend/src/components/result/SourceCategoryCard.tsx:13-18` — card state union 同步
- `backend/tests/test_web_context.py` — 新增 ~80 LOC

**改动**:
1. `fetch_family_context()` 每个 family envelope 继续使用 `state` 字段，不新增平行 `status`:
   - `ready` — 搜索成功，有结果
   - `empty` — 搜索成功，无结果
   - `failed` — 搜索执行异常
   - `search_skipped` — provider 不支持该 family 的域名过滤
   - `unsupported_provider` — 当前 provider 无 Source Family 能力
   - `fallback_unconstrained` — 降级为无域名约束搜索
2. `polymarket` 地域限制继续保留 `geo_gated=true/configured_host`，默认 `state="empty"`，不要新增 `geo_gated` state。
3. `_parse_web_context_json()` allowlist 新增这些状态值
4. 基于 `PROVIDER_CAPABILITIES` 在 family search 前检查: 如果 `domain_filter_mode=none`，该 family 直接标记 `unsupported_provider`
5. 记录可选元数据: `domain_filter_mode`, `domain_coverage`, `status_reason`，历史 JSON 缺失这些字段时 parser 必须兼容

**风险**: 中。需要前端同步消费新状态。P4a 处理前端展示部分。
**退出标准**: 每个状态值都有对应的测试用例。

### P1-6: Capabilities endpoint 增强 provider capability 信息

**涉及文件**:
- `backend/app/api/scenarios.py:465-590` — `api_capabilities()` 改动 ~40 LOC
- `frontend/src/api/client.ts` — `CapabilitiesResponse` 类型同步

**改动**:
```python
# capabilities.web_search.providers 每个 family 新增
"capability": {
    "supports_domain_filter": True,
    "domain_filter_mode": "api",
    "max_domains": 300,
}
# capabilities.web_search 新增
"provider_capability": {
    "supports_domain_filter": True,
    "supports_sources": True,
    "domain_filter_mode": "api",  # 当前 server default provider 的能力
}
```

**风险**: 低。additive 字段，不破坏现有消费者。
**退出标准**: capabilities 响应包含新字段；前端 `useCapabilityCheck` nested path 能读取。

### P1-7: 前端 Source Family toggle UX gate 收紧

**涉及文件**:
- `frontend/src/pages/InputView.tsx:126-132,1422-1428,1598` — web search + source family state 交互
- `frontend/src/pages/InputView.test.tsx` — 新增 ~60 LOC
- `frontend/src/i18n/locales/en.json` + `zh.json` — tooltip 文案同步

**改动**:
1. 当 `webSearchEnabled=false` 时，Source Family checkboxes 显示为 `disabled` + tooltip 解释
2. 当 `webSearchEnabled=true` 但当前 provider 的 `domain_filter_mode=none` 时，checkboxes 显示 `disabled` + tooltip "当前搜索服务不支持分类搜索"
3. 主 toggle 关闭时自动清除 family 选择状态

**风险**: 低。纯 UI 行为调整。
**退出标准**: 交互测试验证 disabled 状态；tooltip 显示正确；i18n zh/en 覆盖。

### P1 并行 Agent 分工

| Agent | 角色 | 任务 | 文件锁 |
|-------|------|------|--------|
| Codex-BE-1 | Worker | P1-1 + P1-2 + P1-3 + P1-5 | `web_context.py`, `test_web_context.py` |
| Claude-BE-2 | Worker | P1-4 | `scenarios.py`, `test_web_context_integration.py` |
| Claude-BE-3 | Worker | P1-6 | `scenarios.py`, `client.ts`, capability tests |
| Claude-FE-1 | Worker | P1-7 + P4a minimal state display | `InputView.tsx`, `InputView.test.tsx`, i18n |

**串行依赖**:
- BE-1 必须先完成，因为 P1-4/P1-6/P1-7 依赖 provider capability 和 outcome/state contract。
- BE-2 和 BE-3 都会改 `scenarios.py`，必须串行或由同一 agent 合并。
- FE-1 只能在 P1-6 的 `CapabilitiesResponse` 类型和响应字段稳定后开始。

### P1 验证命令

```bash
# 后端
cd backend && source .venv/bin/activate
python -m pytest tests/test_web_context.py tests/test_web_context_integration.py tests/test_web_search_contract.py -v
python -m pytest  # 全量回归

# 前端
cd frontend && npm test -- src/pages/InputView.test.tsx --reporter=verbose
npm test --  # 全量回归

# Lint + Type
cd backend && source .venv/bin/activate && ruff check .
cd frontend && npm exec tsc -- --noEmit -p tsconfig.app.json
```

### P1 退出标准

- [x] `PROVIDER_CAPABILITIES` 覆盖 tavily/exa/searxng/xai/native
- [x] xAI `filters.allowed_domains` 正确构建；超限截断有 `domain_coverage` 记录
- [x] SearXNG `site:` 契约测试通过
- [x] Source Family 独立于 base search (四种组合测试通过)
- [x] Source Family `state` 新状态值全覆盖，且未新增平行 `status` 歧义字段
- [x] capabilities endpoint 返回 provider capability 信息
- [x] 前端 Source Family disable 状态正确
- [x] 后端全量 pytest 无新增失败
- [x] 前端全量 vitest 无新增失败
- [x] ruff 0 errors, tsc 0 errors

### P1 Review Gate

- [x] Codex adversarial review: 重点审查 xAI filter 超限处理和 fallback 路径
- [x] Claude cross-review: 确认 capability contract 覆盖 research 文档的 RISK-6/10/12
- [x] 浏览器实测: Source Family toggles 在 Chromium/Firefox/WebKit 下的 disabled 状态

---

## P2: GATED — Native/proxy fallback contract

### 目标
本阶段**不得由 `ccg:team-exec` 在当前任务中直接执行**。它只保留为下一轮设计草案：为非官方 API key、中转商、OpenAI-compatible proxy 设计 capability gate、状态持久化和 fail-soft fallback。

### 执行门

- 必须先由用户确认继续 P2。
- 必须先冻结 `llm_call` / `llm_call_stream` 入参 contract，以及 `web_context_json` 中 app-layer state 与 native state 的分层关系。
- 必须先决定 fallback retry 是否会产生额外费用、是否暴露到 UI、是否写入审计日志。

### P2-1: Provider detection 与 capability registry

**涉及文件**:
- `backend/app/services/llm_client.py` — 新增 ~120 LOC
- `backend/tests/test_llm_client.py` — 新增 ~100 LOC

**改动**:
```python
# llm_client.py 新增
@dataclass(frozen=True)
class LLMProviderProfile:
    name: str
    supports_native_search: bool = False
    native_search_api: Literal["responses", "messages", "chat_extension", "none"] = "none"
    requires_specific_endpoint: str | None = None  # e.g., "/v1/responses"
    is_proxy: bool = False

def detect_provider(base_url: str | None) -> LLMProviderProfile:
    """基于 hostname 检测 provider 能力。未知 host 默认为 proxy。"""
    if base_url is None:
        return LLMProviderProfile(name="default", supports_native_search=False)
    hostname = urlparse(base_url).hostname or ""
    KNOWN_PROVIDERS = {
        "api.x.ai": LLMProviderProfile(
            name="xai", supports_native_search=True,
            native_search_api="responses",
            requires_specific_endpoint="/v1/responses",
        ),
        "api.openai.com": LLMProviderProfile(
            name="openai", supports_native_search=True,
            native_search_api="responses",
            requires_specific_endpoint="/v1/responses",
        ),
        "api.anthropic.com": LLMProviderProfile(
            name="anthropic", supports_native_search=True,
            native_search_api="messages",
        ),
        "generativelanguage.googleapis.com": LLMProviderProfile(
            name="gemini", supports_native_search=True,
            native_search_api="chat_extension",
        ),
        "api.perplexity.ai": LLMProviderProfile(
            name="perplexity", supports_native_search=True,
            native_search_api="chat_extension",
        ),
        "api.deepseek.com": LLMProviderProfile(
            name="deepseek", supports_native_search=False,
        ),
        "api.minimax.chat": LLMProviderProfile(
            name="minimax", supports_native_search=False,
        ),
        "dashscope.aliyuncs.com": LLMProviderProfile(
            name="qwen", supports_native_search=True,
            native_search_api="chat_extension",
        ),
        "api.zhipuai.cn": LLMProviderProfile(
            name="glm", supports_native_search=True,
            native_search_api="chat_extension",
        ),
        "api.moonshot.cn": LLMProviderProfile(
            name="kimi", supports_native_search=True,
            native_search_api="chat_extension",
        ),
        "openrouter.ai": LLMProviderProfile(
            name="openrouter", is_proxy=True,
        ),
        "api.siliconflow.cn": LLMProviderProfile(
            name="siliconflow", is_proxy=True,
        ),
    }
    for local_host in _LOCAL_LLM_HOSTS:
        if hostname == local_host:
            return LLMProviderProfile(name="local", is_proxy=True)
    return KNOWN_PROVIDERS.get(hostname, LLMProviderProfile(
        name="unknown", is_proxy=True,
    ))
```

**测试覆盖**:
- 每个已知 hostname → 正确 profile
- 未知 hostname → `is_proxy=True`, `supports_native_search=False`
- localhost → `is_proxy=True`
- None → default profile

**风险**: 低。纯检测逻辑，不改变调用行为。
**退出标准**: 全部参数化测试通过。

### P2-2: Fail-soft fallback contract 设计

**涉及文件**:
- `backend/app/api/scenarios.py:735-768` — 改动 ~80 LOC
- `backend/app/services/web_context.py` — 改动 ~40 LOC

**改动草案**:
1. `create_scenario()` 在调用 `fetch_web_context()` 前检测 provider profile:
   ```python
   provider_profile = detect_provider(req.llm_base_url)
   if provider_profile.is_proxy and not req.web_search_provider:
       # proxy 不默认启用 native search; 只走 app-layer
       native_search_state = "unsupported_proxy"
   ```
2. `fetch_web_context()` 新增 `provider_hint` 参数，用于记录 app-layer/native 分层 state:
   ```python
   async def fetch_web_context(
       question, provider_override=None, api_key_override=None,
       base_url_override=None, *, provider_hint: str | None = None
   ) -> WebSearchResult | None:
   ```
3. 当 `provider == "native"` 且 `provider_profile.supports_native_search == False`:
   - 返回结构化结果或 scenario metadata，state 为 `unsupported_provider`
   - 不中断 scenario 创建

**风险**: 中。需要确保 proxy 检测不误判官方 provider。
**退出标准**: proxy 场景返回 native 层 `unsupported_proxy`; app-layer Source Family state 不受影响；官方 provider 不受影响。

### P2-3: 错误码到 native/app-layer state 的映射

**涉及文件**:
- `backend/app/services/web_context.py:811-833` — `_search_with_provider()` 改动 ~60 LOC
- `backend/tests/test_web_context.py` — 新增 ~80 LOC

**改动**:
```python
# web_context.py _search_with_provider 改造草案
async def _search_with_provider(
    provider, query, request_config, *, include_domains=None
) -> ProviderSearchOutcome:
    """返回结构化 outcome；同一 patch 必须更新所有调用者。"""
    try:
        fn = _PROVIDER_MAP.get(provider)
        if fn is None:
            return ProviderSearchOutcome([], "unsupported_provider", "none", "none")
        snippets = await fn(query, request_config, include_domains=include_domains)
        return ProviderSearchOutcome(
            snippets,
            "ready" if snippets else "empty",
            "api",
            "full" if include_domains else "none",
        )
    except httpx.TimeoutException:
        logger.warning("Web search timeout: provider=%s", provider)
        return ProviderSearchOutcome([], "failed", "none", "none")
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code
        if status_code == 429:
            return ProviderSearchOutcome([], "search_skipped", "none", "none")  # rate limit
        if status_code in (400, 401, 403, 404, 422):
            return ProviderSearchOutcome([], "unsupported_provider", "none", "none")  # likely unsupported params
        return ProviderSearchOutcome([], "failed", "none", "none")  # 5xx etc.
    except Exception:
        logger.warning("Web search error: provider=%s", provider, exc_info=True)
        return ProviderSearchOutcome([], "failed", "none", "none")
```

**测试覆盖**:
- 每个 HTTP status code → 对应 status
- timeout → `failed`
- 未知 provider → `unsupported_provider`
- 成功有结果 → `ready`
- 成功无结果 → `empty`

**风险**: 中。改变了 `_search_with_provider` 的返回签名，需要更新 `fetch_web_context()`、`fetch_family_context()`、缓存写入和全部测试。
**退出标准**: 全部错误码映射测试通过；全量回归无新增失败。

### P2-4: 200-body 错误处理 (Anthropic/Qwen/Kimi 特殊情况)

**涉及文件**:
- `backend/app/services/web_context.py` — 新增 ~60 LOC (未来 adapter 预留)
- `backend/tests/test_web_context.py` — 新增 ~40 LOC

**改动**:
预留 adapter hook 用于检测 200 body 内错误:
```python
def _detect_provider_body_error(provider: str, response_body: dict) -> str | None:
    """检测 HTTP 200 但 body 内含错误的情况。返回 state 或 None。"""
    # Anthropic: web_search_tool_result_error in content blocks
    # Qwen: search silently skipped when RPS > 15
    # Kimi: tool-call loop incomplete
    # 当前仅预留接口; P3 实现具体 adapter
    return None
```

**风险**: 低。仅预留接口。
**退出标准**: 接口存在；P3 测试将覆盖具体实现。

### P2 并行 Agent 分工

| Agent | 角色 | 任务 | 文件锁 |
|-------|------|------|--------|
| Codex-BE-1 | Worker | P2-1 | `llm_client.py` (新增 detect_provider), `test_llm_client.py` |
| Claude-BE-2 | Worker | P2-2 | `scenarios.py` |
| Claude-BE-3 | Worker | P2-3 + P2-4 | `web_context.py`, `test_web_context.py` |

**串行依赖**:
- BE-1 → BE-2 (`detect_provider` 先于使用)
- BE-3 独立 (但与 P1 的 web_context.py 改动有冲突，需在 P1 完成后)

### P2 验证命令

```bash
cd backend && source .venv/bin/activate
python -m pytest tests/test_llm_client.py tests/test_web_context.py tests/test_web_context_integration.py -v
python -m pytest
ruff check .
```

### P2 退出标准

- [ ] `detect_provider()` 覆盖 15+ 已知 hostname + proxy + local + unknown
- [ ] proxy 场景 scenario 创建不失败，native 层状态可表示 `unsupported_proxy`
- [ ] 全部 HTTP 错误码 → 正确 status 映射
- [ ] 200-body 错误检测 hook 预留
- [ ] 后端全量 pytest 无新增失败
- [ ] ruff 0 errors

### P2 Review Gate

- [ ] Codex adversarial review: 审查 proxy detection 是否有 false positive
- [ ] Claude cross-review: 确认 fallback 链覆盖 ADR-6 的所有分支
- [ ] Codex review: `_search_with_provider` 返回签名变更的向后兼容性

---

## P3: GATED — Provider adapters

### 目标
本阶段**不得由 `ccg:team-exec` 在当前任务中直接执行**。下一轮如果获批，只做 **xAI native search pilot**。OpenAI/Anthropic/Gemini/Perplexity/Qwen/GLM/Kimi 只作为研究 backlog，不进入同一执行批次。

### P3-1: xAI LLM native search pilot (Responses API)

**涉及文件**:
- `backend/app/services/llm_client.py:1447-1600` — `llm_call()` 改动 ~120 LOC
- `backend/app/services/web_context.py` — 共享 citation 解析 ~60 LOC
- `backend/tests/test_llm_client.py` — 新增 ~150 LOC
- 新文件: `backend/app/services/native_search_adapters.py` ~200 LOC

**改动**:
1. 新建 `native_search_adapters.py` 模块:
   ```python
   class NativeSearchAdapter(Protocol):
       def build_search_tools(self, *, domains: list[str] | None) -> list[dict]: ...
       def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]: ...
       def detect_body_error(self, response_body: dict) -> str | None: ...

   class XAIResponsesAdapter:
       MAX_DOMAINS = 5
       def build_search_tools(self, *, domains=None):
           tools = [{"type": "web_search"}]
           if domains:
               capped = domains[:self.MAX_DOMAINS]
               tools = [{"type": "web_search", "filters": {"allowed_domains": capped}}]
           return tools
       def parse_citations(self, response_body):
           # 解析 Responses API 的 annotations/URL citations
           ...
       def detect_body_error(self, response_body):
           return None  # xAI 无 200-body 错误模式
   ```

2. `llm_call()` 条件注入 native search tools:
   ```python
   # llm_client.py:1487 区域
   provider_profile = detect_provider(base_url)
   if (native_search_enabled
       and provider_profile.supports_native_search
       and not provider_profile.is_proxy):
       adapter = get_adapter(provider_profile.name)
       if adapter and _is_responses_endpoint(api_url):
           payload["tools"] = adapter.build_search_tools(domains=search_domains)
   ```

3. `native_search_enabled` 由新的 `LLMNativeSearchConfig` 控制:
   ```python
   @dataclass
   class LLMNativeSearchConfig:
       enabled: bool = False
       domains: list[str] | None = None
       max_tool_calls: int = 3
       timeout_seconds: float = 30.0
   ```

**测试覆盖**:
- xAI `/v1/responses` + native search enabled → payload 含 `tools`
- xAI `/v1/chat/completions` + native search enabled → 不注入 tools (endpoint 不兼容)
- xAI + `is_proxy=True` → 不注入 tools
- native search disabled → payload 无 tools (P0-2 回归)
- citation 解析: 有 annotations → snippets; 无 annotations → 空
- domains ≤5 → `filters.allowed_domains`; >5 → 截断
- 400 unsupported → strip tools, retry, status `fallback_unconstrained`
- timeout → strip tools, retry, status `failed`

**风险**: 高。首次在 `llm_call()` 中注入 tools。必须确保:
- 不影响现有无 native search 的调用路径
- retry 逻辑正确 strip tools
- citation 存储与 `web_context_json` 兼容

**退出标准**: xAI native search E2E 流程验证通过 (mock provider); 无 native search 回归测试通过。

### P3-2: Citation 存储与展示

**涉及文件**:
- `backend/app/models/database.py` — 可能新增字段或复用 `web_context_json`
- `backend/app/api/helpers.py:1101-1208` — `_parse_web_context_json` 适配
- `frontend/src/types.ts` — 扩展 `WebSearchContext`
- `frontend/src/pages/result/WebSourcesSection.tsx` — 展示 native citations

**改动**:
1. Native search citations 存入 `web_context_json` 的新 `native_citations` 字段:
   ```json
   {
     "query": "...",
     "snippets": [...],
     "provider": "tavily",
     "native_citations": [
       {"text": "...", "source_url": "https://...", "provider": "xai"}
     ],
     "family_context": {...}
   }
   ```
2. `_parse_web_context_json` 白名单新增 `native_citations`
3. 前端 `WebSearchContext` 类型扩展 `native_citations?: WebSearchSnippet[]`
4. `WebSourcesSection` 展示 native citations (与 app-layer snippets 分开标注)

**风险**: 中。需要确保序列化/反序列化向后兼容。
**退出标准**: 旧数据无 `native_citations` 时不报错; 新数据正确展示。

### P3-3: Backlog only — OpenAI Responses adapter (P3-1 验证后)

**涉及文件**:
- `backend/app/services/native_search_adapters.py` — 新增 ~80 LOC

**改动**:
```python
class OpenAIResponsesAdapter:
    MAX_DOMAINS = 100
    def build_search_tools(self, *, domains=None):
        tools = [{"type": "web_search"}]
        if domains:
            tools = [{"type": "web_search", "filters": {"allowed_domains": domains[:100]}}]
        return tools
    def parse_citations(self, response_body):
        # 解析 include: ["web_search_call.action.sources"]
        ...
```

**风险**: 低。与 xAI adapter 结构相似。
**退出标准**: OpenAI adapter contract test 通过。

### P3-4: Backlog only — 其他 provider adapters (研究后决定范围)

> **NEEDS-VERIFICATION**: Anthropic / Gemini / Perplexity / Qwen / GLM / Kimi adapter 是否进入本轮实施，取决于 P3-1 验证结果和用户决策。当前仅记录设计框架。

**Provider 分片建议** (来自 research):
1. **Shard A** (Responses API): xAI pilot；OpenAI 需单独确认
2. **Shard B** (Messages API): Anthropic (server tool `web_search_20250305/20260209`, 需 `anthropic-version` header, 200-body error parsing)
3. **Shard C** (Grounding): Gemini (`google_search`, parse `groundingMetadata`, 无域名过滤)
4. **Shard D** (Chat extension): Perplexity (`search_domain_filter`, `citations/search_results`)
5. **Shard E** (多协议): Qwen (Responses `web_search` + Chat `enable_search` + DashScope `enable_search`)
6. **Shard F** (独立 API): GLM/Z.AI (standalone Web Search API + Chat extension)
7. **Shard G** (Tool-call loop): Kimi (`$web_search` builtin, requires tool-call loop)

**每个 Shard 的 adapter 需要**:
- `build_search_tools()` — provider 特定的 tools/params
- `parse_citations()` — 解析 citation/source metadata
- `detect_body_error()` — 200-body 错误检测
- Header 扩展 (Anthropic: `anthropic-version`, `x-api-key`)
- Contract test fixture (mock provider response)

**风险**: 高。`llm_client.py` 当前只有 `Authorization: Bearer` + `Content-Type` header (L577); Anthropic 需要不同的 header 结构。
**退出标准**: NEEDS-VERIFICATION — 由 P3-1 验证结果决定。

### P3 并行 Agent 分工

| Agent | 角色 | 任务 | 文件锁 |
|-------|------|------|--------|
| Codex-BE-1 | Worker | P3-1 adapter 框架 | `native_search_adapters.py` (新文件) |
| Claude-BE-2 | Worker | P3-1 llm_call 集成 | `llm_client.py` |
| Claude-FE-1 | Worker | P3-2 前端 citation 展示 | `types.ts`, `WebSourcesSection.tsx` |
| Codex-BE-3 | Worker | P3-2 后端 citation 存储 | `helpers.py`, `database.py` |
| Claude-BE-4 | Worker (单独确认后) | P3-3 OpenAI adapter | `native_search_adapters.py` |

**串行依赖**:
- BE-1 → BE-2 (adapter 框架 → llm_call 集成)
- BE-1 → BE-3 (adapter 框架 → citation 存储)
- BE-2 → BE-4 (xAI 验证 → OpenAI adapter)

### P3 验证命令

```bash
cd backend && source .venv/bin/activate
python -m pytest tests/test_llm_client.py tests/test_web_context.py -v -k "native_search or adapter"
python -m pytest
cd frontend && npm test -- src/pages/result/ --reporter=verbose
npm test --
```

### P3 退出标准

- [ ] xAI native search adapter: tools 注入、citation 解析、fallback 全覆盖
- [ ] OpenAI adapter: **不在 xAI pilot 批次执行**；如用户单独确认再加 contract test
- [ ] Citation 存储: `web_context_json` 向后兼容
- [ ] Citation 展示: `WebSourcesSection` 区分 app-layer 与 native
- [ ] 无 native search 的调用路径完全不受影响 (P0-2 回归)
- [ ] 后端全量 pytest 无新增失败
- [ ] 前端全量 vitest 无新增失败

### P3 Review Gate

- [ ] Codex adversarial review: 审查 adapter 注入是否有安全漏洞 (prompt injection via tools)
- [ ] Codex review: llm_call retry 逻辑正确 strip tools
- [ ] Claude cross-review: citation 格式与 ResultView source card 兼容
- [ ] 浏览器实测: native citation 在 ResultView 正确渲染

---

## P4a/P4b: Frontend UX / i18n / 跨浏览器

### 目标
P4 分成两段：
- **P4a 可在 P1 后执行**：Source Family disabled state、新 `state` 展示、provider capability hint、i18n zh/en。
- **P4b 必须 gated**：native citations、proxy/native fallback UI、与 P2/P3 相关的 ResultView 展示。

### P4-1: Source Family `state` 在 ResultView 的展示 (P4a)

**涉及文件**:
- `frontend/src/types.ts:13-30` — 扩展 `WebSearchContext.family_context.*.state` 类型
- `frontend/src/components/result/SourceCategoryCard.tsx:13-18` — 扩展 `SourceCategoryState`
- `frontend/src/pages/result/ResultModals.tsx` — 改动 ~40 LOC
- `frontend/src/pages/ResultView.tsx:131-142` — `resolveSourceCategoryState` 适配
- `frontend/src/i18n/locales/en.json` + `zh.json` — 新增 ~15 keys
- 测试文件 — 新增 ~60 LOC

**改动**:
1. `SourceCategoryState` 新增:
   ```typescript
   export type SourceCategoryState =
     | 'loading' | 'empty' | 'rate_limited' | 'network_error' | 'ready'
     | 'unsupported_provider'
     | 'fallback_unconstrained' | 'search_skipped';
   ```
2. `SourceCategoryCard` switch 新增对应的 UI 分支:
   - `unsupported_provider` → info card "当前搜索服务不支持此分类"
   - `fallback_unconstrained` → warning card "搜索范围已扩大（未限定域名）"
   - `search_skipped` → muted card "搜索已跳过"
3. `resolveSourceCategoryState` 处理新状态值

**i18n keys 新增**:
```json
{
  "source.polymarket.unsupported_provider": "当前搜索服务不支持预测市场分类搜索",
  "source.polymarket.fallback_unconstrained": "搜索范围已扩大，未限定预测市场域名",
  "source.polymarket.search_skipped": "预测市场搜索已跳过",
  // ... 同理 finance/academic/news_deep 各 3 keys = 12 keys
  "source.general.unsupported_provider": "Provider does not support domain-filtered search",
  "source.general.fallback_warning": "Results may include sources outside the target domain"
}
```

**风险**: 低。UI 扩展，向后兼容。
**退出标准**: 每个新状态有对应的 UI + i18n + 测试。

### P4-2: InputView 搜索增强区域 UX 优化 (P4a)

**涉及文件**:
- `frontend/src/pages/InputView.tsx:1414-1564` — 改动 ~60 LOC
- `frontend/src/pages/InputView.css:793-1064` — 改动 ~40 LOC
- `frontend/src/hooks/useWebSearchConfig.ts` — 改动 ~30 LOC
- 测试文件 — 新增 ~40 LOC

**改动**:
1. 当 `webSearchEnabled=false` 时，Source Family checkboxes disabled，并在主 toggle 关闭时清空 family 选择。
2. 当 `webSearchEnabled=true` 但当前 web search provider 的 `domain_filter_mode=none` 时，Source Family checkboxes disabled。
3. 当 `webSearchEnabled=true` 且 server default 不可用 + 无 custom override:
   - 显示 warning "请配置搜索服务或切换到自定义覆盖模式"
4. Provider 选择下拉新增 provider capability 提示:
   - Tavily: "支持域名过滤，最多 300 个域名"
   - Exa: "支持域名过滤，最多 1200 个域名"
   - xAI: "支持域名过滤，最多 5 个域名"
   - SearXNG: "自托管搜索，通过 site: 语法过滤"

**风险**: 低。纯 UI 信息展示。
**退出标准**: 各 provider 提示正确展示；i18n 覆盖。

### P4-3: 跨浏览器兼容性审计 (P4a)

**涉及文件**:
- `frontend/src/pages/InputView.css` — 可能修复 ~20 LOC
- `frontend/src/pages/ResultView.css` — 可能修复 ~20 LOC

**审计清单**:

| CSS 特性 | 文件:行号 | Safari 支持 | Firefox 支持 | 修复策略 |
|----------|----------|------------|-------------|---------|
| `color-mix(in oklab)` | `ResultView.css` 多处，含 source cards 附近 | 16.2+ | 111+ | 需抽样查 `@supports` fallback，不要只看单一行 |
| `oklch()` | `ResultView.css` 多处 | 15.4+ | 113+ | 需 hex fallback |
| `backdrop-filter` | `ResultView.css` 多处 | 需 `-webkit-` | 103+ | 抽样复核 |
| `accent-color` | InputView.css source toggles | 15.4+ | 92+ | OK |
| `inert` attribute | InputView.tsx L1582 | 15.5+ | 112+ | 已有 aria-hidden + focus trap fallback |
| `line-clamp` | ResultView.css L270-271 | `-webkit-` OK | 68+ | OK |

**改动**:
1. 所有 `oklch()` 使用处添加 hex fallback (在同一声明前一行):
   ```css
   background: #4a90d9; /* fallback */
   background: oklch(0.65 0.15 250);
   ```
2. 所有 `color-mix(in oklab)` 使用处添加 `@supports` 或 inline fallback
3. 验证 source-family card 在 Safari 15/Firefox ESR 下的渲染

**风险**: 低。CSS fallback 不影响现代浏览器。
**退出标准**: Playwright 截图对比 Chrome/Safari/Firefox 无明显差异。

### P4-4: i18n 完整性检查 (P4a)

**涉及文件**:
- `frontend/src/i18n/locales/en.json` — 新增 ~25 keys
- `frontend/src/i18n/locales/zh.json` — 新增 ~25 keys

**新增 key 清单** (合并 P4-1 和 P4-2):

```
# P4-1: Source Family 新状态
source.{family}.unsupported_provider     ×4
source.{family}.fallback_unconstrained   ×4
source.{family}.search_skipped           ×4

# P4-2: InputView 搜索增强提示
home.web_search_proxy_info
home.web_search_no_config_warning
home.web_search_provider_tavily_hint
home.web_search_provider_exa_hint
home.web_search_provider_xai_hint
home.web_search_provider_searxng_hint

# P4b/P3-2: Native citation (gated, 不在 P4a 执行)
result.native_citations_title
result.native_citations_provider
```

**退出标准**: en/zh key 数量 parity；无硬编码英文。

### P4-5: 移动端适配检查 (P4a)

**涉及文件**:
- `frontend/src/pages/InputView.css` — 审计 `@media` 断点
- `frontend/src/pages/ResultView.css` — 审计 source grid 断点

**审计点**:
- Source Family toggles 在 375px 视口下的布局 (当前 L1939-1944 有 full-width 处理)
- ResultView source grid 在 768px 断点下的 mobile → sheet 切换
- web-search-fields grid 在当前 CSS 断点下堆叠，实施前重新 `rg "@media"` 校准真实行号
- 新增的 info/warning banner 在窄视口下的换行

**退出标准**: Playwright 375px + 768px 截图无溢出。

### P4 并行 Agent 分工

| Agent | 角色 | 任务 | 文件锁 |
|-------|------|------|--------|
| Claude-FE-1 | Worker | P4-1 | `types.ts`, `SourceCategoryCard.tsx`, `ResultModals.tsx`, `ResultView.tsx` |
| Claude-FE-2 | Worker | P4-2 | `InputView.tsx`, `useWebSearchConfig.ts` |
| Claude-FE-3 | Worker | P4-3 | `InputView.css`, `ResultView.css` |
| Claude-FE-4 | Worker | P4-4 | `en.json`, `zh.json` |
| Claude-FE-5 | Worker | P4-5 | 审计 + 截图 (不写文件) |

**注意**: P4-1 和 P4-4 有 i18n 依赖 (FE-4 在 FE-1 之后)。其余可并行。

### P4 验证命令

```bash
cd frontend && npm test -- src/pages/ResultView.test.tsx src/pages/InputView.test.tsx src/components/result/ --reporter=verbose
cd frontend && npm test --
cd frontend && npm exec tsc -- --noEmit -p tsconfig.app.json
cd frontend && npm run build

# i18n parity 检查
cd frontend && node -e "
const en = require('./src/i18n/locales/en.json');
const zh = require('./src/i18n/locales/zh.json');
const enKeys = Object.keys(JSON.parse(JSON.stringify(en))).length;
const zhKeys = Object.keys(JSON.parse(JSON.stringify(zh))).length;
console.log('en keys:', enKeys, 'zh keys:', zhKeys, 'parity:', enKeys === zhKeys);
"

# 跨浏览器 smoke (需 Playwright)
cd frontend && npm run e2e:cross-browser
```

### P4 退出标准

- [ ] 新 Source Family `state` 状态在 ResultView 正确渲染
- [ ] InputView proxy info / no-config warning 正确显示
- [ ] Provider capability hint 正确展示
- [ ] CSS fallback 覆盖 `oklch` / `color-mix`
- [ ] i18n en/zh parity (新增 ~25 keys)
- [ ] 375px / 768px 视口无溢出
- [ ] 前端全量 vitest 无新增失败
- [ ] tsc 0 errors, vite build 0 violations

### P4 Review Gate

- [ ] Codex review: i18n key 命名一致性
- [ ] Claude cross-review: 跨浏览器 CSS fallback 完整性
- [ ] 浏览器实测: Chrome/Safari/Firefox 三浏览器 desktop + mobile 截图

---

## P5: GATED — Release Validation

### 目标
当前任务不直接执行 P5。P0/P1/P4a 合并后，重新用当时的 llmdoc/test baseline 定界 release validation。

### P5-1: 后端全量测试

```bash
cd backend && source .venv/bin/activate
python -m pytest -x -v  # 全量 + 首次失败停止
ruff check .
```

**退出标准**: 所有测试通过; ruff 0 errors。

### P5-2: 前端全量测试

```bash
cd frontend && npm test -- --reporter=verbose
cd frontend && npm exec tsc -- --noEmit -p tsconfig.app.json
cd frontend && npm run build
cd frontend && npm run lint
```

**退出标准**: 所有测试通过; tsc 0 errors; build 0 violations; lint 0 errors。

### P5-3: E2E 测试矩阵

| 脚本 | 模式 | 覆盖 |
|------|------|------|
| `e2e-web-search-suite.mjs` | fixture | web search toggle + custom override + provider/key/base URL |
| `e2e-new-source-ingestion-live.mjs` | fixture + live | source family cards + geo-gate + family selection |
| `e2e-capability-matrix.mjs` | fixture | capability gate 覆盖 + 新状态值 |

```bash
cd frontend && npm run e2e:web-search
cd frontend && npm run e2e:new-source-ingestion-live
cd frontend && npm run e2e:capability-matrix
```

### P5-4: 跨浏览器 Smoke Test

```bash
cd frontend && npm run e2e:cross-browser
```

**覆盖**:
- Chrome (desktop 1440px + mobile 375px)
- Firefox (desktop 1440px)
- Safari/WebKit (desktop 1440px + mobile 375px)

### P5-5: Provider Contract Fixtures

为每个 app-layer provider 创建 mock fixture:

```bash
# Tavily: 正常/空结果/rate-limit/timeout/invalid-key
# Exa: 正常/空结果/rate-limit/timeout/invalid-key
# SearXNG: 正常/JSON-disabled/timeout/empty
# xAI: 正常/filter-unsupported/timeout/empty/annotations
```

### P5-6: 跨平台兼容性检查清单

| 项目 | Windows | macOS | Linux | 备注 |
|------|---------|-------|-------|------|
| 环境变量 | `.env` file | `.env` file | `.env` file | 统一 `python-dotenv` |
| SearXNG 本地部署 | Docker | Docker/brew | Docker/apt | `SEARXNG_URL` 默认 `http://localhost:8888` |
| 路径分隔符 | `\` | `/` | `/` | Python `pathlib` 已处理; 前端不涉及 |
| 换行符 | CRLF → LF | LF | LF | `.gitattributes` + `ruff format` 统一 |
| Shell 命令 | PowerShell/CMD | zsh/bash | bash | Makefile + `pytest` 跨平台 |
| SQLite 路径 | `C:\Users\...` | `/Users/...` | `/home/...` | `DATABASE_URL` 配置 |
| Docker Compose | Docker Desktop | Docker Desktop/OrbStack | Docker Engine | 统一 `docker compose` |

### P5-7: 安全边界验证

- [ ] Untrusted web context 通过 `format_untrusted_text_block` 包装
- [ ] Native search citations 通过 `_sanitize_url` 验证
- [ ] BYOK key 不泄漏到日志 (`_OpaqueStr` 覆盖)
- [ ] BYOK key 不泄漏到 share PNG (`ShareArtifact` 排除)
- [ ] Web search key 不进入 preflight payload (`preflightMode` 排除)
- [ ] Rate limit: web search provider 有 timeout 和 retry budget
- [ ] 成本控制: native search 有 `max_tool_calls` 限制

### P5 并行 Agent 分工

| Agent | 角色 | 任务 |
|-------|------|------|
| Codex-QA-1 | QA | P5-1 后端全量测试 |
| Claude-QA-2 | QA | P5-2 前端全量测试 |
| Claude-QA-3 | QA | P5-3 + P5-4 E2E 和跨浏览器 |
| Codex-QA-4 | QA | P5-5 provider fixture 验证 |
| Claude-QA-5 | QA | P5-6 + P5-7 跨平台 + 安全 |

### P5 退出标准

- [ ] 后端: 全量 pytest ≥ 当前验证基线 `2835 passed / 2 skipped` (允许增加)
- [ ] 前端: 全量 vitest ≥ 当前验证基线 `184 files / 2004 passed` (允许增加)
- [ ] E2E: web-search + new-source-ingestion-live + capability-matrix 全部通过
- [ ] 跨浏览器: Chrome/Firefox/WebKit smoke 通过
- [ ] 安全: 7 项安全检查全部通过
- [ ] i18n: en/zh key parity
- [ ] tsc 0 errors, ruff 0 errors, vite build 0 violations

### P5 Review Gate (Final Signoff)

- [ ] Codex adversarial review: 全项目级审查
- [ ] Claude cross-review: 对照 research 文档的成功判据逐项签收
- [ ] 浏览器实测: 三浏览器 + 移动端截图签收

---

## 附录 A: Provider 完整矩阵

| Provider | 当前项目支持 | Native Search 形式 | 域名过滤 | Domain Filter Mode | Max Domains | Citation/Source | 本轮计划 |
|----------|-------------|-------------------|---------|-------------------|-------------|----------------|---------|
| **Tavily** | ✅ app-layer | N/A (独立 API) | `include_domains` | api | 300 | ✅ URL + text | P1 contract |
| **Exa** | ✅ app-layer | N/A (独立 API) | `includeDomains` | api | 1200 | ✅ URL + text | P1 contract |
| **SearXNG** | ✅ app-layer | N/A (自托管) | `site:` query | query | unlimited | ✅ URL + text | P1 加固 |
| **xAI** | ✅ app-layer | Responses `web_search` | app-layer 当前 prompt-only；P1 改 official `filters.allowed_domains` + URL 后过滤 | api | 5 | ✅ annotations | P1 app-layer fix；P3 xAI native pilot gated |
| **OpenAI** | ❌ | Responses `web_search` | `filters.allowed/blocked_domains` | api | 100 | ✅ sources | Backlog only |
| **Anthropic** | ❌ | Messages server tool | `allowed/blocked_domains` | api | UNKNOWN | ✅ citations | Backlog only |
| **Gemini** | ❌ | `google_search` grounding | ❌ 无官方 | none | 0 | ✅ groundingMetadata | Backlog only |
| **Perplexity** | ❌ | `search_domain_filter` | `search_domain_filter` | api | 20 | ✅ citations | Backlog only |
| **Qwen/DashScope** | ❌ | 三种入口 | DashScope `assigned_site_list` | api (DashScope) | UNKNOWN | ⚠️ DashScope only | Backlog only |
| **GLM/Z.AI** | ❌ | 独立 API + Chat ext | `search_domain_filter` | api | UNKNOWN | ✅ search_result | Backlog only |
| **Kimi/Moonshot** | ❌ | `$web_search` builtin | ❌ 无统一 | none | 0 | ⚠️ 需 tool loop | Backlog only |
| **DeepSeek** | ❌ | ❌ 无 native | ❌ | none | 0 | ❌ | app-layer only |
| **MiniMax** | ✅ LLM default | ❌ 核心 Chat 无 | ❌ | none | 0 | ❌ | app-layer only |
| **OpenRouter** | ❌ proxy | 透传上游 | 取决于上游 | unknown | unknown | 取决于上游 | proxy fallback |
| **LiteLLM/OneAPI/NewAPI** | ❌ proxy | 透传上游 | 取决于上游 | unknown | unknown | 取决于上游 | proxy fallback |

## 附录 B: Source Family 域名映射 (当前)

来源: `web_context.py:145-179` (`FAMILY_DOMAIN_FILTERS`)

| Family | 域名数 | 域名列表 | xAI 超限? |
|--------|-------|---------|----------|
| polymarket | 4 | polymarket.com, metaculus.com, predictit.org, manifold.markets | 否 (4 ≤ 5) |
| finance | 7 | bloomberg.com, reuters.com, ft.com, wsj.com, cnbc.com, finance.yahoo.com, seekingalpha.com | **是** (7 > 5) |
| academic | 7 | arxiv.org, scholar.google.com, semanticscholar.org, pubmed.ncbi.nlm.nih.gov, nature.com, science.org, ieee.org | **是** (7 > 5) |
| news_deep | 7 | apnews.com, bbc.com, nytimes.com, theguardian.com, propublica.org, theintercept.com, bellingcat.com | **是** (7 > 5) |

**xAI 超限策略 (ADR-5)**:
- polymarket: 无超限
- finance: 截断到 `bloomberg.com, reuters.com, ft.com, wsj.com, cnbc.com` (top 5)；记录 `domain_coverage="partial"`
- academic: 截断到 `arxiv.org, scholar.google.com, semanticscholar.org, pubmed.ncbi.nlm.nih.gov, nature.com` (top 5)；记录 `domain_coverage="partial"`
- news_deep: 截断到 `apnews.com, bbc.com, nytimes.com, theguardian.com, propublica.org` (top 5)；记录 `domain_coverage="partial"`

## 附录 C: 测试矩阵

### 后端测试

| 类别 | 文件 | 新增测试数 | 覆盖 |
|------|------|----------|------|
| P0 回归 | `test_web_search_contract.py` / `test_preflight_cli.py` | ~3 | `WEB_SEARCH_PROVIDER=native` preflight/capability consistency |
| P0 回归 | `test_llm_client.py` | ~15 | URL resolve + payload shape |
| P0 回归 | `test_roundtable_analyst.py` | ~3 | app-layer search isolation |
| P0 回归 | `test_web_context_integration.py` | ~6 | BYOK separation + short-circuit |
| P1 契约 | `test_web_context.py` | ~30 | provider capability + xAI filter + SearXNG |
| P1 集成 | `test_web_context_integration.py` | ~8 | Source Family 独立 |
| P1 集成 | `test_web_search_contract.py` | ~4 | capabilities + state values |
| P2 fallback | `test_llm_client.py` | gated | detect_provider + proxy gate |
| P2 fallback | `test_web_context.py` | gated | error code mapping |
| P3 adapter | `test_llm_client.py` | gated | xAI native search + fallback |
| P3 adapter | 新文件 `test_native_search_adapters.py` | gated | adapter contract |
| P3 citation | `test_web_context_integration.py` | gated | citation storage round-trip |

**P0+P1 预计新增**: ~126 后端测试中的可执行子集约 ~70；P2/P3 测试为 gated backlog。

### 前端测试

| 类别 | 文件 | 新增测试数 | 覆盖 |
|------|------|----------|------|
| P0 回归 | `client.test.ts` | ~4 | wire-format |
| P1 UX | `InputView.test.tsx` | ~6 | Source Family disable state |
| P4 状态 | `SourceCategoryCard.test.tsx` | ~4 | new state values |
| P4 状态 | `ResultView.test.tsx` | ~6 | state rendering |
| P4 i18n | `InputView.test.tsx` | ~4 | provider hints |
| P4b citation | 新文件 `WebSourcesSection.test.tsx` | gated | native citations |

**P0+P1/P4a 预计新增**: ~24 前端测试；`WebSourcesSection.test.tsx` 仅在 P4b/P3 citation 获批后新增。

### E2E 测试

| 脚本 | 更新 | 覆盖 |
|------|------|------|
| `e2e-web-search-suite.mjs` | 扩展 | proxy warning + provider hints |
| `e2e-new-source-ingestion-live.mjs` | 扩展 | new state values + fallback display |
| `e2e-capability-matrix.mjs` | 扩展 | provider capability nested path |

## 附录 D: 文件改动清单

### 后端 (预计改动文件)

| 文件 | Phase | 改动类型 | 预计 LOC |
|------|-------|---------|---------|
| `backend/app/services/web_context.py` | P1-1/2/3/5, P2-3/4 | P0/P1 修改；P2 gated | ~300 |
| `backend/app/services/preflight.py` | P0-0 | 修改 | ~20 |
| `backend/app/services/llm_client.py` | P0-1/2, P2-1, P3-1 | P0 tests only；P2/P3 gated | ~200 gated |
| `backend/app/api/scenarios.py` | P1-4/6, P2-2 | P1 修改；P2 gated | ~100 |
| `backend/app/api/helpers.py` | P1-5, P3-2 | P1 修改；P3 gated | ~40 |
| `backend/app/services/native_search_adapters.py` | P3-1/3 | **gated 新文件** | ~300 |
| `backend/tests/test_llm_client.py` | P0-1/2, P2-1, P3-1 | P0 修改；P2/P3 gated | ~300 |
| `backend/tests/test_web_context.py` | P1-1/2/3/5, P2-3 | P1 修改；P2 gated | ~300 |
| `backend/tests/test_web_context_integration.py` | P0-4/5, P1-4, P3-2 | P0/P1 修改；P3 gated | ~150 |
| `backend/tests/test_roundtable_analyst.py` | P0-3 | 修改 | ~35 |
| `backend/tests/test_web_search_contract.py` / `test_preflight_cli.py` | P0-0/P1-6 | 修改 | ~40 |
| `backend/tests/test_native_search_adapters.py` | P3-1/3 | **gated 新文件** | ~150 |

### 前端 (预计改动文件)

| 文件 | Phase | 改动类型 | 预计 LOC |
|------|-------|---------|---------|
| `frontend/src/types.ts` | P4a-1, P3-2 | P4a 修改；P3 gated | ~20 |
| `frontend/src/pages/InputView.tsx` | P1-7, P4-2 | 修改 | ~100 |
| `frontend/src/pages/InputView.css` | P4-3 | 修改 | ~40 |
| `frontend/src/pages/ResultView.tsx` | P4-1 | 修改 | ~30 |
| `frontend/src/pages/ResultView.css` | P4-3 | 修改 | ~40 |
| `frontend/src/pages/result/WebSourcesSection.tsx` | P3-2/P4b | gated 修改 | ~30 |
| `frontend/src/pages/result/ResultModals.tsx` | P4-1 | 修改 | ~40 |
| `frontend/src/components/result/SourceCategoryCard.tsx` | P4-1 | 修改 | ~30 |
| `frontend/src/hooks/useWebSearchConfig.ts` | P4-2 | 修改 | ~30 |
| `frontend/src/api/client.ts` | P0-6/P1-6/P3-2 | P0/P1 修改；P3 gated | ~30 |
| `frontend/src/api/client.test.ts` | P0-6 | 修改 | ~50 |
| `frontend/src/pages/InputView.test.tsx` | P1-7, P4-2 | 修改 | ~100 |
| `frontend/src/pages/ResultView.test.tsx` | P4-1 | 修改 | ~60 |
| `frontend/src/components/result/SourceCategoryCard.test.tsx` | P4-1 | 修改 | ~40 |
| `frontend/src/i18n/locales/en.json` | P4-4 | 修改 | ~25 keys |
| `frontend/src/i18n/locales/zh.json` | P4-4 | 修改 | ~25 keys |

## 附录 E: 开放问题 (NEEDS-VERIFICATION)

| # | 问题 | 影响 Phase | 建议 |
|---|------|----------|------|
| Q1 | xAI `filters.allowed_domains` 是否对所有模型可用? | P1-2 | P1-2 实施前用 contract fixture 验证 |
| Q2 | Anthropic `web_search_20260209` 的 `allowed_domains` 限制数量? | P3-4 Shard B | P3 前 research |
| Q3 | Qwen DashScope `enable_search` 是否支持 `search_options.assigned_site_list`? | P3-4 Shard E | P3 前 research |
| Q4 | GLM/Z.AI standalone Web Search API 的定价和 rate limit? | P3-4 Shard F | P3 前 research |
| Q5 | Kimi `$web_search` tool-call loop 的最大轮次和 token 消耗? | P3-4 Shard G | P3 前 research |
| Q6 | Citation metadata 存入 `web_context_json` 是否会导致列过大? | P3-2 | 评估平均 citation 大小; 考虑分表 |
| Q7 | P3-4 各 Shard 是否进入本轮实施? | P3-4 | 用户决策 |
| Q8 | `native_search_adapters.py` 是否需要 plugin 化架构? | P3 | P3-1 后评估 |

## 附录 F: 风险登记表

| ID | 风险 | 严重度 | Phase | 缓解措施 |
|----|------|--------|-------|---------|
| R1 | xAI `filters` 字段被 API 拒绝 | 高 | P1-2 | contract fixture + `fallback_unconstrained`/`failed` 显式记录；不得静默 ready |
| R2 | `_search_with_provider` 返回签名变更破坏调用者 | 高 | P2-3 | 全项目 grep `_search_with_provider` 确认所有调用者 |
| R3 | `llm_call()` tools 注入影响现有调用路径 | 高 | P3-1 | P0-2 回归测试 + feature flag `FEATURE_NATIVE_SEARCH` |
| R4 | Native citation 大小导致 `web_context_json` 列膨胀 | 中 | P3-2 | citation 截断到 max 10 条 + text max 500 chars |
| R5 | Proxy detection false positive (官方 provider 被误判为 proxy) | 中 | P2-1 | hostname allowlist 严格匹配; 测试全覆盖 |
| R6 | 多 adapter 同时激活导致 payload 冲突 | 中 | P3 | 互斥: 同一请求只有一个 adapter 生效 |
| R7 | i18n key 遗漏导致生产显示 key 而非翻译 | 低 | P4-4 | parity 检查脚本 + CI gate |
| R8 | CSS fallback 缺失导致旧浏览器白屏 | 低 | P4-3 | `@supports` + hex fallback 全覆盖 |

---

## 执行时间线 (建议)

```
Round 1: P0 (baseline + native placeholder consistency)
Round 2: P1 backend contract (provider capability + outcome/state + URL post-filter)
Round 3: P1 scenario/capabilities/frontend integration
Round 4: P4a frontend state/i18n/mobile/cross-browser smoke (only after P1)
Round 5+: P2/P3/P4b/P5 only after separate user confirmation
```

**关键路径**: P0 → P1-BE → P1-API → P1-FE → P4a。
**gated backlog**: P2/P3/P4b/P5 不属于当前可直接执行范围。

---

*计划结束。所有文件路径和行号基于 2026-05-13 代码快照。标记 NEEDS-VERIFICATION 的项需要在对应 Phase 开始前验证。*
