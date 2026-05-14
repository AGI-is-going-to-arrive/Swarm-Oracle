# Web Search Augmented Simulation — Design Document (Final)

> Status: **Implemented — P0/P1/P2/P3(xAI pilot)/P4a/P4b 已完成；P5 native-search release gate 与 legacy release sweep 已完成**
> Date: 2026-05-14 (P2/P3/P4b re-baselined)
> Scope: Batch 2 + P0/P1/P2/P3/P4a/P4b/P5 已交付 — Tavily/Exa/SearXNG/xAI app-layer providers, TTL cache, prompt injection 三层注入, InputView toggle, ResultView 来源卡片, GET /api/capabilities, `provider_capability`, `web_search_families`, `web_search_context.family_context`, xAI native search pilot, `native_citations`, native-search tool-call budget / citation cap

---

## 0. Security Posture Declaration

### Session Token (dev-only coarse gate)

当前 `SESSION_SECRET` + `X-Session-Token` / `?token=` 方案是**临时开发态的全局门禁 hardening**，不是最终安全设计：

- **不是 owner-aware authorization** — 所有持有同一 token 的客户端共享完整访问权限
- **不是 IDOR 修复** — 无资源级所有权检查
- **localStorage 存储不安全** — 对 XSS 攻击暴露
- **WS query param token 不安全** — 会出现在服务器日志和浏览器历史中

**最终 auth 方案需要**：JWT/OAuth2 + per-resource ownership + httpOnly cookie。当前方案仅用于开发/演示阶段的粗粒度访问控制。

---

## 1. Provider Capability Matrix

### 1.1 Native Web Search Providers

| Provider | Search Mechanism | BYOK Compatible |
|----------|-----------------|-----------------|
| **Perplexity** (pplx-api) | 内建实时搜索，返回内联引用 | Yes |
| **Google Gemini** (with grounding) | `google_search_retrieval` tool | Yes |
| **OpenAI** (web browsing) | `web_search` tool (仅特定 model) | Yes |
| **xAI Grok native search** | Responses `web_search` tool，返回 citations / annotations | Yes — 当前只做 xAI pilot；unknown proxy 不启用 native tools |

### 1.2 External Search API Providers (Model-Agnostic)

| Provider | Free Tier | Latency | 推荐度 |
|----------|-----------|---------|--------|
| **Tavily** (推荐默认) | 1000 req/mo | ~1-2s | P0 |
| **Exa** | 1000 req/mo | ~1-3s | P1 fallback |
| **SearXNG** (self-hosted) | 无限 | ~2-5s | P2 |
| **xAI** (app-layer Responses web_search) | 取决于账号 | ~1-5s | P1 |

**Fallback chain:** 当前没有跨 provider fallback chain。配置哪个 provider 就调用哪个 provider；失败时 fail-soft 继续推演。

### 1.3 Provider 能力探测（三层）

1. **静态注册表** — `web_context.py` 中维护 `PROVIDER_CAPABILITIES`
2. **能力通告** — `GET /api/capabilities.web_search.provider_capability` 描述服务端默认 provider 的 domain-filter/source 能力
3. **前端门控** — InputView 用 `supports_domain_filter` 禁用或启用 Source Family checkbox

capability 不支持 → Source Family checkbox 保持可见但 disabled，不阻断普通推演。

---

## 2. Architecture

### 2.1 新增模块

```
backend/app/services/
  web_context.py          # NEW — 搜索编排 + 结果格式化
  llm_client.py           # LLM 调用 + provider detection + native tools 注入
  native_search_adapters.py # provider-specific tools/citation parsing
  narrator.py             # 读取 [REAL_WORLD_CONTEXT]
  simulator.py            # 读取 [REAL_WORLD_CONTEXT]
```

### 2.2 数据流

```
InputView                    POST /api/scenario           web_context.py         External Search
   |                              |                            |                      |
   |-- { question,                |                            |                      |
   |    web_search_enabled: true }|                            |                      |
   |                              |-- fetch_web_context() ---->|                      |
   |                              |                            |-- search(query) ---->|
   |                              |                            |<-- WebSearchResult --|
   |                              |<-- context block ----------|                      |
   |                              |                            |                      |
   |                              |-- Store: Scenario.web_context_json               |
   |                              |-- Inject into simulator/narrator prompts          |
   |<-- 201 scenario -------------|                            |                      |
```

> **注意**: API 路由是 `/api/scenario`（单数），不是 `/api/scenarios`。

### 2.3 搜索触发逻辑

搜索在场景创建时执行**一次**（Round 1 之前），不按轮次重复搜索。

- Feature flag `ENABLE_WEB_SEARCH=false` 默认关闭
- 前端 toggle **opt-in**（默认关闭），用户主动开启才搜索
- V1 简化：开启即搜索，不做问题分类

### 2.4 Prompt 注入格式

```
[REAL_WORLD_CONTEXT]
The following real-world information was retrieved on {timestamp}:

1. {snippet_1}
   Source: {url_1}
2. {snippet_2}
   Source: {url_2}

IMPORTANT: Use this factual context to inform your reasoning.
If the context contradicts your prior knowledge, prefer the context.
[/REAL_WORLD_CONTEXT]
```

注入点：
- `narrator.py` — `_build_narration_prompt()` 前置
- `simulator.py` — agent system prompt 前置

搜索结果通过 `format_untrusted_text_block()` 包装（复用现有 guardrail）。

### 2.5 错误处理

搜索失败**永不阻断**推演。所有失败模式（timeout/4xx/5xx/空结果/限流）→ log warning → 正常推演。

---

## 3. Contract Diff

### 3.1 后端 Schema (`backend/app/api/schemas.py`)

```python
# 新增字段到 CreateScenarioRequest
class CreateScenarioRequest(BaseModel):
    # ... existing fields ...
    web_search_enabled: bool = False   # NEW — opt-in, 默认关闭
```

### 3.2 后端 Model (`backend/app/models/database.py`)

```python
class Scenario(SQLModel, table=True):
    # ... existing columns ...
    web_context_json: str | None = Field(default=None)  # NEW — JSON string of WebSearchResult
```

### 3.3 前端 Types (`frontend/src/types.ts`)

```typescript
// 新增类型
export interface WebSearchContext {
  query: string;
  snippets: Array<{ text: string; source_url: string }>;
  provider: string;
  timestamp: string;
  cached: boolean;
  native_citations?: Array<{ text: string; source_url: string }>;
  family_context?: {
    polymarket?: {
      state?: 'loading' | 'empty' | 'rate_limited' | 'network_error' | 'ready' | 'failed' | 'search_skipped' | 'unsupported_provider' | 'fallback_unconstrained';
      status_reason?: string;
      domain_filter_mode?: 'api' | 'query' | 'none';
      domain_coverage?: 'full' | 'partial';
      configured_host?: string;
      geo_gated?: boolean;
      items: Array<{ id: string; question: string; probability?: number; url?: string }>;
    };
    finance?: {
      state?: 'loading' | 'empty' | 'rate_limited' | 'network_error' | 'ready' | 'failed' | 'search_skipped' | 'unsupported_provider' | 'fallback_unconstrained';
      status_reason?: string;
      domain_filter_mode?: 'api' | 'query' | 'none';
      domain_coverage?: 'full' | 'partial';
      items: Array<{ id: string; title: string; summary?: string; source?: string; url?: string }>;
    };
    academic?: {
      state?: 'loading' | 'empty' | 'rate_limited' | 'network_error' | 'ready' | 'failed' | 'search_skipped' | 'unsupported_provider' | 'fallback_unconstrained';
      status_reason?: string;
      domain_filter_mode?: 'api' | 'query' | 'none';
      domain_coverage?: 'full' | 'partial';
      items: Array<{ id: string; title: string; authors?: string[]; citationCount?: number; abstract?: string; url?: string }>;
    };
    news_deep?: {
      state?: 'loading' | 'empty' | 'rate_limited' | 'network_error' | 'ready' | 'failed' | 'search_skipped' | 'unsupported_provider' | 'fallback_unconstrained';
      status_reason?: string;
      domain_filter_mode?: 'api' | 'query' | 'none';
      domain_coverage?: 'full' | 'partial';
      items: Array<{ id: string; title: string; source?: string; publishedAt?: string; description?: string; url?: string }>;
    };
  } | null;
}

// 扩展 Scenario 接口
export interface Scenario {
  // ... existing fields ...
  web_search_context?: WebSearchContext | null;
}
```

### 3.4 前端 API Client (`frontend/src/api/client.ts`)

```typescript
// launchSimulation 请求体新增
{
  // ... existing fields ...
  web_search_enabled?: boolean;   // opt-in, 默认 undefined/false
  web_search_families?: Array<'polymarket' | 'finance' | 'academic' | 'news_deep'>;
}
```

### 3.5 后端 Capabilities 响应 — Server Configuration Hint

当前以 `GET /api/capabilities` 作为前端轻量探测端点（无 LLM 调用）。`POST /api/health/test` 仍返回 server-level `web_search` hint，但不作为 Source Family UI gate。

> **重要语义约束**: `web_search` 字段报告的是**服务端全局配置状态**（`ENABLE_WEB_SEARCH` + provider + API key 是否配齐），**不是**当前被测试的 BYOK `llm_base_url / model` 的真实搜索能力。字段名 `scope: "server"` 显式标记此限制。
>
> Per-provider 能力探测（例如检测 Perplexity/Gemini 是否原生支持搜索）属于 V2 范围（§1.3 layer 2: 运行时探测）。

```python
# capabilities response 中的 web_search 片段
return {
    "web_search": {                          # NEW — server config hint
        "scope": "server",                   # ⚠️ server-level, NOT per-provider
        "server_enabled": True,              # ENABLE_WEB_SEARCH && key/self-host configured
        "method": "native" | "external" | "none",
        "provider": "tavily" | "exa" | "searxng" | "xai" | "native" | None,
        "provider_capability": {
            "supports_domain_filter": true,
            "supports_sources": true,
            "domain_filter_mode": "api" | "query" | "prompt" | "none",
        },
    },
}
```

前端消费路径：`InputView.tsx` 读取 `/api/capabilities`。搜索增强入口默认可见；server default 模式下 Source Family checkbox 由服务端 `provider_capability.supports_domain_filter` 控制。custom override 模式不会做实时探测；可识别的 base URL 会推断 Tavily / Exa / xAI / SearXNG，空 base URL 会使用下拉 provider 的 capability，只有非空且未知的 host 会显示 no-provider warning。

---

## 4. Migration Plan

### 4.1 Alembic Migration

```python
# backend/alembic/versions/013_add_web_context_json.py

def upgrade():
    op.add_column('scenario', sa.Column('web_context_json', sa.Text(), nullable=True))

def downgrade():
    op.drop_column('scenario', 'web_context_json')
```

### 4.2 Fallback Migration (database.py)

在 `init_db()` 的轻量迁移列表中添加：

```python
("scenario", "web_context_json", "TEXT"),
```

### 4.3 Config 新增 (`backend/app/config.py`)

```python
class Settings(BaseSettings):
    # ... existing ...
    
    # Web Search Enhancement
    ENABLE_WEB_SEARCH: bool = False
    WEB_SEARCH_PROVIDER: str = "tavily"
    WEB_SEARCH_API_KEY: str = ""
    WEB_SEARCH_MAX_RESULTS: int = 5
    WEB_SEARCH_TIMEOUT_SECONDS: float = 8.0
    WEB_SEARCH_CACHE_TTL_SECONDS: int = 300
    SEARXNG_URL: str = "http://localhost:8888"
    NATIVE_SEARCH_MAX_TOOL_CALLS: int = 5
    NATIVE_SEARCH_MAX_CITATIONS: int = 50
```

---

## 5. Configuration Reference

### 5.1 后端 `.env` 模板更新

以下变量需要添加到 `.env.example`:

```bash
# ═══════════════════════════════════════════════════════
# Security — Session Gate (开发态粗粒度门禁)
# ═══════════════════════════════════════════════════════
# 为空时跳过鉴权（本地开发默认行为）。
# 设置后所有 REST 端点要求 X-Session-Token header，
# WebSocket 连接要求 ?token= query param。
# ⚠️ 这是临时开发态方案，不是最终 auth 设计。
SESSION_SECRET=

# ═══════════════════════════════════════════════════════
# Web Search Enhancement (搜索增强推演)
# ═══════════════════════════════════════════════════════
# 总开关（默认关闭）
ENABLE_WEB_SEARCH=false

# 搜索提供商: tavily | exa | searxng | xai
WEB_SEARCH_PROVIDER=tavily

# 搜索 API Key（searxng 不需要）
WEB_SEARCH_API_KEY=

# SearXNG 实例地址（仅 WEB_SEARCH_PROVIDER=searxng 时使用）
SEARXNG_URL=http://localhost:8888

# 调优参数
WEB_SEARCH_MAX_RESULTS=5
WEB_SEARCH_TIMEOUT_SECONDS=8
WEB_SEARCH_CACHE_TTL_SECONDS=300

# LLM native search budget
NATIVE_SEARCH_MAX_TOOL_CALLS=5
NATIVE_SEARCH_MAX_CITATIONS=50
```

### 5.2 前端 `.env` 模板更新

```bash
# 历史兼容变量；InputView 搜索增强入口当前默认可见，不再用它决定显示/隐藏
VITE_ENABLE_WEB_SEARCH=false
```

---

## 6. Frontend Integration

### 6.1 InputView Toggle

- 放置位置：Runtime Preset 和 BYOK 之间
- **默认关闭 (opt-in)**
- 搜索增强入口默认可见，不再由 `VITE_ENABLE_WEB_SEARCH` 决定显示/隐藏
- Source Family checkbox 只有在 web search 开启且 `provider_capability.supports_domain_filter=true` 时可选；关闭 web search 或 capability 不支持会清空已选 family

### 6.2 搜索状态指示

| 状态 | 视觉 |
|------|------|
| `idle` | 仅 toggle，无指示 |
| `searching` | Spinner + "正在搜索真实世界背景..." |
| `success` | 绿色 ✓ + "{N} 条来源" |
| `skipped` | 灰色 — + "未启用" |
| `error` | 橙色 ⚠ + "搜索不可用，继续推演" |

### 6.3 ResultView 展示

`scenario.web_search_context` 非空时显示可折叠"真实世界来源"卡片。

`scenario.web_search_context.family_context` 非空时，ResultView 还会显示四张 source family card：

- 被选中的 family 成功后进入 `ready`
- 未选中的 family 保持 `empty`
- provider 不支持 domain filter 时进入 `unsupported_provider`
- family 内部 provider error 会进入 `failed`
- 历史 payload 里的 `fallback_unconstrained / search_skipped` 也有专门文案
- 后端 `status_reason` 会优先作为卡片说明；desktop grid 和 mobile sheet 使用不同 `aria-describedby` id
- `polymarket.configured_host=non-us` 时显示 geo-gated placeholder
- `native_citations` 非空时，`WebSourcesSection` 会在普通 snippets 后显示 native citation 区块；前端只渲染字符串 text + http(s) URL，后端也会在 API 白名单解析时过滤 unsafe URL

---

## 7. Targeted Test Matrix

### 7.1 后端单元测试 (`tests/test_web_context.py`)

| 测试 | 验证点 |
|------|--------|
| `test_tavily_formats_results` | Mock Tavily → WebSearchResult 字段正确 |
| `test_format_context_block` | [REAL_WORLD_CONTEXT] 块结构正确 |
| `test_format_context_empty` | 空 snippets → 返回空字符串 |
| `test_format_context_sanitizes_injection` | 搜索结果含 prompt injection → 被 guardrail 包装 |
| `test_fetch_timeout` | 8s 超时 → 返回 None |
| `test_fetch_api_error` | 500 → 返回 None |
| `test_cache_hit` | 相同 query 命中缓存 |
| `test_provider_detection_perplexity` | perplexity URL → NativeSearchProvider |
| provider capability / URL 后过滤测试 | provider capability、IDN/punycode、suffix lookalike、非 http(s) URL 过滤 |
| xAI / SearXNG family tests | xAI `allowed_domains`、SearXNG `site:` 域名归一化 |

### 7.2 后端集成测试 (`tests/test_web_context_integration.py`)

| 测试 | 验证点 |
|------|--------|
| `test_create_scenario_with_search` | POST `/api/scenario` + `web_search_enabled=true` → `web_context_json` 存储 |
| `test_create_scenario_selected_families` | `web_search_families` 只让被选中的 family 进入搜索路径 |
| base/family independent tests | base search 失败不阻断 family；family 失败不丢弃 base context |
| `test_create_scenario_polymarket_geo_gate` | `NEW_SOURCES_POLYMARKET_CONFIGURED_HOST=non-us` → `polymarket` 保持 `empty + geo_gated` |
| `test_create_scenario_search_failure` | Mock 超时 → 场景正常创建，无 context |
| `test_create_scenario_search_disabled` | `web_search_enabled=false` → 不调用搜索 |
| `test_narrator_includes_context` | narrator prompt 含 `[REAL_WORLD_CONTEXT]` |
| `test_simulator_includes_context` | agent prompt 含 `[REAL_WORLD_CONTEXT]` |

### 7.3 前端单元测试

| 测试 | 验证点 |
|------|--------|
| source family disabled gate tests | provider capability 不支持 domain filter → checkbox disabled + 清空旧选择 |
| `test_toggle_opt_in_default_off` | toggle 默认关闭状态 |
| `test_toggle_sends_flag` | 开启 → 请求含 `web_search_enabled: true` |
| `test_toggle_sends_selected_families` | source family toggle → 请求含 `web_search_families` |
| `test_result_shows_sources` | `web_search_context` 非空 → 显示来源卡 |
| `test_result_shows_family_cards` | `family_context` 非空 → family card 渲染正确 |
| `test_result_polymarket_geo_gate` | `configured_host=non-us` → 显示 geo-gated placeholder |

### 7.4 回归测试

| 测试 | 验证点 |
|------|--------|
| `test_existing_scenarios_unaffected` | 旧场景无 `web_context_json` → 正常加载 |
| `test_search_disabled_no_side_effects` | 关闭状态 → 零搜索 API 调用 |
| `test_session_token_compat` | SESSION_SECRET 启用 → 搜索请求携带 token |

---

## 8. Implementation Order

**Batch 2 实施顺序（需逐步审批）：**

1. **契约落地**（本小批）
   - Alembic migration `013_add_web_context_json`
   - `schemas.py` + `types.ts` 同步
   - `config.py` 新增 web search 配置项
   - `.env.example` 更新
   
2. **后端模块**
   - `web_context.py` + Tavily provider
   - `narrator.py` / `simulator.py` context 注入
   - 单元 + 集成测试

3. **前端 toggle + 状态 UI**
   - InputView toggle (opt-in)
   - 搜索状态指示
   - API client 扩展
   - 前端单元测试

4. **ResultView 展示**
   - "真实世界来源" 卡片
   - E2E 测试

5. **Multi-provider + 能力探测**（V2）
   - Exa / SearXNG provider
   - xAI native search pilot 已完成；OpenAI adapter 已有 structural/fixture-level support，live OpenAI 签收仍是 backlog
   - 探测 API

当前 P5 native-search gate 已收口：`e2e:native-search` 覆盖 Chromium/Firefox/WebKit desktop+mobile，native citation 已计入 WebKit/Safari 签收，native-search explicit `max_tool_calls` 已 fail-closed。更广义的 legacy release sweep 也已追加完成：`e2e:web-search` 真实调用 Tavily/Exa/xAI-local/SearXNG-local，`e2e:new-source-ingestion-live` 真实覆盖 desktop+mobile source ingestion，`e2e:capability-matrix` 通过 30/30 gates。

---

## 9. Open Questions

1. 搜索结果是否跨分支共享？当前设计：是（scenario 级存储）
2. 用户是否能在推演前预览搜索结果？当前设计：否（V2 考虑）
3. 缓存范围：in-memory `cachetools.TTLCache`（V1）vs Redis（V2）
