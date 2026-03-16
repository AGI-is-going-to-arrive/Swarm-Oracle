# 🧠 AI 开源项目创意深度调研报告

> 基于 MiroFish、Paperclip、geo-seo-claude、agency-agents 深度调研  
> 结合 X、Reddit、GitHub、Facebook 近 3 个月 AI 讨论趋势  
> 叠加前次竞品分析的验证结论  
> 日期：2026-03-11

---

## 一、四个项目核心解读

### 🐟 MiroFish — 群体智能预测引擎 ⭐（你最感兴趣）

| 维度 | 核心信息 |
|------|---------|
| **核心能力** | 用数千个 LLM Agent 在模拟 Twitter/Reddit 上交互，预测现实事件走向 |
| **五阶段流程** | 图谱构建(GraphRAG) → 环境搭建(Agent人设) → 双平台模拟 → 报告生成(ReportAgent) → 深度交互 |
| **技术栈** | Vue.js 3 + Flask + D3.js + OASIS 框架 + Zep Cloud 记忆 + Docker |
| **创新点** | 宏观（政策预演实验室）+ 微观（创意沙盒），深度交互可与模拟世界中任意角色对话 |
| **示例场景** | 武汉大学舆情推演、《红楼梦》失传结局预测、金融/时政推演 |

**关键洞察**: MiroFish 的核心魅力在于 **"让每一个如果都能看见结果"** —— 同时兼顾严肃预测和趣味仿真，用户体验是其最大差异点。

### 🛡️ OpenClaw Security Skills 生态 (用户补充洞察)

| 维度 | 核心信息 |
|------|---------|
| **现有生态** | 已有极其完备的开源解决方案，直接以 OpenClaw Skill 形式存在 |
| **代表项目** | • **prompt-security/clawsec** (最完善的套件，防投毒/监控篡改/NVD情报)<br>• **adibirzu/openclaw-security-monitor** (专治 ClawHavoc 窃密，48点扫描)<br>• **AgentSafety/ClawCare** (最强运行时防护，TS hook 拦截)<br>• **edimuj/vexscan** (Rust 高性能 AST 扫描，160+ 规则)<br>• **cisco-ai-defense/skill-scanner** (模块化 YARA + LLM-as-Judge) |
| **技术栈** | Python, Shell, TypeScript Hook, Rust |

**关键洞察**: **安全审计 Skill 赛道实际上已经高度卷化且非常成熟**。社区不仅有静态分析、运行时拦截，还有完整的自愈机制和供应链防护。任何想做这个方向的新项目，最好的方式是 **fork 现有成熟方案（如 clawsec 或 ClawCare）并作为插件加入补充规则**，而不是从零造轮子。

### 📎 Paperclip — 零人公司编排器

| 维度 | 核心信息 |
|------|---------|
| **定位** | "如果 OpenClaw 是员工，Paperclip 就是公司" |
| **核心功能** | 组织架构、预算管控、Agent 协调、成本追踪、目标对齐 |
| **技术栈** | Node.js + React + 内嵌 PostgreSQL |
| **路线图** | ClipMart（一键下载运行整个公司模板）、云端 Agent 接入、插件系统 |

**关键洞察**: 从"管代码"到"管业务目标"的跃迁；**Agent-as-employee** 范式已被验证。

### 🌍 geo-seo-claude — GEO 优化分析工具

| 维度 | 核心信息 |
|------|---------|
| **核心理念** | GEO-first, SEO-supported；只有 **11%** 域名同时被 ChatGPT 和 Google AI Overviews 引用 |
| **关键指标** | AI 可引性（134-167 词自包含块） > 品牌提及（3x 强于外链） > 实体识别 > SSR |
| **架构** | 5 层架构，5 个并行子 Agent，13 条 `/geo` 命令，6 维评分 |

**关键洞察**: **GEO 是 2026 年的新搜索范式**；品牌提及与 AI 可见性的相关性是传统外链的 3 倍。

### 🎭 agency-agents — AI 专家人格库

| 维度 | 核心信息 |
|------|---------|
| **规模** | 60+ 个专业 Agent，覆盖 9 大部门（工程、设计、营销、产品、测试、游戏开发、空间计算等） |
| **支持工具** | Claude Code、Cursor、Aider、Windsurf、Gemini CLI、OpenCode |
| **特色** | 每个 Agent 有人格、交付物、成功指标，不是通用 prompt 而是完整 workflow |

**关键洞察**: Agent **"人格化 + 专精化 + 可跨工具"** 是社区强需求（11 天 750+ star）。

---

## 二、近 3 个月全平台 AI 讨论热点 (2025.12 – 2026.03)

### 🔥 超高热度

| 话题 | 平台 | 核心信息 |
|------|------|---------|
| **OpenClaw 现象** | GitHub/Reddit/X | 250K+ stars，最快增长开源项目；本地运行 + 50+ 集成 |
| **MCP 协议标准化** | GitHub/Dev.to/Reddit | Linux Foundation 接管；成为 Agent↔Tool 通信标准 |
| **Multi-Agent 生产化** | Medium/arXiv/GitHub | 57% 企业已部署 AI Agent；AutoGen/CrewAI/LangGraph 成熟 |
| **AI Agent Skills 生态** | Reddit/SoloBiz/X | 57K+ skills 跨注册表，从 Claude Code 扩展到开放标准 |

### 📈 高热度

| 话题 | 平台 | 核心信息 |
|------|------|---------|
| **GEO 取代传统 SEO** | Reddit/WindowsForum | AI 搜索流量 +527%；AI 转化率是传统 4.4 倍 |
| **AI 社交模拟 (Moltbook)** | Verge/Reddit/X | 32K AI bot 自主社交；人类开始"渗透" |
| **A2A 协议** | Dev.to/GitHub | MCP 管 Agent↔Tool，A2A 管 Agent↔Agent |
| **数字孪生个人助手** | X/Facebook/Reddit | CoPaw (阿里), Y Social (学术), 数据主权意识觉醒 |
| **AI 游戏叙事** | Reddit/YouTube | SEELE 平台；95% Unity 工作室已采用 AI |
| **隐私优先本地 AI** | Reddit/HN/GitHub | Ollama 持续增长；Continue/OpenCode/Tabby 本地优先 |

### 🧊 新兴但关键

| 话题 | 信号 |
|------|------|
| **AI Agent 市场/交易** | Simplai、ClipMart、skills.sh 等平台涌现 |
| **社会认知模拟 (MetaMind)** | NeurIPS Spotlight，Theory of Mind |

---

## 三、竞品空白验证（基于前次分析 + 最新搜索）

> [!IMPORTANT]
> 前次竞品分析已验证：**Agent 社会实验室赛道极度拥挤（12+ 项目）**，而 **品牌危机模拟** 和 **Agent 铸造平台** 竞争较低。本次研究在此基础上进一步拓展搜索。

| 赛道 | 竞争密度 | 关键竞品 | 空白机会 |
|------|---------|---------|---------|
| Agent 社会模拟 | 🔴 极高 | Smallville 18K★, OASIS 2.7K★, AgentSociety 790★, Moltbook | 底层框架无空间 |
| 品牌舆论危机模拟 | 🟢 低 | Snow Globe 48★(军事), Conducttr(闭源商业) | **开源 LLM Agent 品牌危机模拟 = 空白** |
| Agent 铸造/测试平台 | 🟢 低 | agency-agents(纯模板), 各框架(纯底层) | **定义→测试→分享→编排 一站式 = 空白** |
| GEO 优化 | 🟡 中 | geo-seo-claude(Claude Only), 若干分散工具 | **跨工具 GEO + 自动执行 = 有差异** |
| 实时趋势雷达 | 🟡 中 | Google Trends, Exploding Topics, 各单平台工具 | **AI 语义理解 + 跨平台关联 = 有差异** |
| AI Skill 安全 | 🔴 极高 | clawsec, openclaw-security-monitor, ClawCare, vexscan | **已高度饱和，建议 Fork 参与贡献** |
| "What-If" 预测游戏 | 🟢 低 | Shapes Inc What-If(Very 小众闭源), MiroFish(预测但非游戏化) | **游戏化 + AI 预测 = 空白** |

---

## 四、🎯 5 个精选项目创意

> [!TIP]
> 筛选标准：① 受调研项目启发 ② 与 2026 AI 热点吻合 ③ 竞争密度低 ④ 跨平台 ⑤ 好玩又有用

---

### 💡 创意 1: **FateForge — AI "如果…会怎样" 预测游乐场**

> 灵感: MiroFish 的 "让每一个如果都能看见结果" + 游戏化体验  
> 竞争: 🟢 **极低** — 无开源竞品将 "AI 群体模拟预测" 和 "游戏化交互" 结合

#### 核心概念

```
不是严肃的政策模拟器，而是一个「AI 预测游乐场」：
用户扔出一个 "如果…" 问题 → AI Agent 群体自动演化 → 
以可视化动画/故事线展示多条平行结局 → 用户可介入干预
```

#### 目标场景

| 场景 | 示例 |
|------|------|
| 🎮 **历史 What-If** | "如果诸葛亮多活 10 年？" → Agent 群演出蜀国不同走向 |
| 📰 **新闻推演** | "如果明天某科技巨头宣布开源大模型？" → 社交平台反应模拟 |
| 📚 **故事分支** | "如果哈利波特被分到斯莱特林？" → AI 续写多条平行故事线 |
| 💼 **商业决策** | "如果我们把产品定价降低 30%？" → 市场反应模拟 |

#### 与 MiroFish 的差异

| 维度 | MiroFish | FateForge |
|------|---------|-----------|
| 定位 | 严肃预测工具 | **游戏化预测游乐场** |
| 输入门槛 | 需上传文档，配置复杂 | **一句话输入，零配置** |
| 输出形式 | 分析报告 | **可视化故事线 + 分支动画 + 排行榜** |
| 互动方式 | 与 Agent 对话 | **实时介入 + "蝴蝶效应" 触发器** |
| 社交属性 | 单用户 | **多人同场 + 预测对决 + 社区排行** |
| 技术底层 | OASIS 完整框架 | **轻量 Agent 群 + 快速迭代** |

#### 游戏化设计

```
📊 「预言家排行榜」— 用户预测结果 vs AI 模拟结果的准确度竞赛
🌿 「蝴蝶效应模式」— 改变一个小参数，观看结局如何翻天覆地
🎲 「命运骰子」— 随机生成 What-If 问题，社区竞猜
🏆 「预测积分」— 参与 → 预测 → 验证 → 获积分/徽章
```

#### 核心交互技术验证（可视化分支树与动画）

要在 Web 端实现流畅的 "故事分支树" + "SVG 路径流转动画"，并非难事，可以组合以下开源生态：

1. **核心结构网络 (Node-Based UI)**:
   - **React Flow** 或 **Vue Flow**: 这两个是业内目前最流行的节点编辑器库，完美支持平移、缩放、自定义节点渲染（把每个结局/选项作为一个 Node）。
   - **数据结构**: 采用类似视觉小说（Ren'Py/Twine）的 JSON 图结构，每个 Node 包含 `"id": "node_1", "content": "曹操兵败", "choices": ["node_1a", "node_1b"]`。

2. **分支向外生长的动画 (SVG/流转特效)**:
   - **Motion** (前身为 Framer Motion) 或 **VueUse Motion**: 处理节点的动态弹入 (Pop-in)、平滑展开布局。
   - **GSAP (GreenSock)**: 如果需要最高性能的复杂时间线（Timeline）编排，比如 "Agent A 的决策光点沿着 SVG 贝塞尔曲线流动到 Node B"，GSAP 的 `MotionPathPlugin` 是最强选择。
   - **D3.js / GoJS** (备选): 如果节点数量极大（成百上千），可以使用 D3 的 Hierarchy (Tree Layout) 将 JSON 动态计算出坐标，再配以 SVG 连线动画。

3. **视觉层面表现**:
   界面类似于 **"技能树进化界面"** 或 **"Git 提交图谱"** 的动态展开。当用户选择一个 "如果" 时，主时间线前方突然分裂出多条发光的 SVG 线条，新的 Node 动态弹出，展示对应的预测文本和参与该结局推理的 Agent 头像。

#### 跨平台

| 平台 | 形式 |
|------|------|
| Web | Vue 3 + Vue Flow + GSAP 打造炫酷树状节点界面 |
| Desktop | Tauri 桌面端封装 |
| CLI / API | Headless 模型，允许第三方接入 |
| PWA | 移动端滑动体验 |

---

### 💡 创意 3: **CrisisForge — 品牌舆论危机对抗演练平台**

> 灵感: MiroFish 的 Agent 社交模拟 + Paperclip 的编排 + agency-agents 的角色专精  
> 竞争: 🟢 **低** — 前次验证：开源领域无直接竞品

#### 核心定位

```
"品牌公关团队的战争游戏" — 
在 AI 模拟的社交平台上，红队发动舆论攻击，蓝队进行危机应对。
不是事后分析，而是事前演练。
```

#### 红蓝对抗设计

```
🔴 红队 (AI 攻击者):
├── 谣言传播 Agent — 在模拟平台上散布负面信息
├── KOL 放大 Agent — 模拟意见领袖转发扩散
├── 情绪煽动 Agent — 制造对立情绪
└── 媒体追踪 Agent — 模拟媒体跟进报道

🔵 蓝队 (用户/AI 防御者):
├── 监控 Agent — 实时发现危机苗头
├── 公关回应 Agent — 起草声明和回应策略
├── 社区管理 Agent — 引导舆论，安抚情绪
└── 数据分析 Agent — 追踪传播路径，评估影响
```

#### 独特优势 (vs 所有竞品)

| 对比 | Snow Globe | Conducttr | MiroFish | **CrisisForge** |
|------|-----------|-----------|----------|-----------------|
| 场景 | 军事兵棋 | 企业危机 | 通用预测 | **品牌舆论** |
| Agent驱动 | ✅ | ❌ 脚本 | ✅ | ✅ |
| 对抗模式 | 单方推演 | 单方演练 | 单方模拟 | **红蓝双方对抗** |
| 平台模拟 | ❌ | ❌ | Twitter/Reddit | **Twitter/Reddit/微博/小红书** |
| 开源 | ✅ | ❌ | ✅ | ✅ |
| 本地LLM | ❌ | ❌ | ❌ | ✅ Ollama |

#### 跨平台

| 平台 | 形式 |
|------|------|
| Web | React 实时对抗仪表盘 |
| Desktop | Tauri 桌面端（离线演练） |
| CLI | `crisisforge scenario --attack "产品质量门"` |
| MCP | 作为品牌风险评估工具 |

---

### 💡 创意 4: **AgentForge — 通用 AI Agent 铸造平台**

> 灵感: agency-agents 的人格模板 + Paperclip 的 ClipMart + MCP/A2A 生态  
> 竞争: 🟢 **低** — 前次验证通过

#### 核心功能矩阵

```
🔨 Forge (铸造)     → 可视化 / YAML 定义 Agent
🧪 Arena (竞技场)   → Agent vs Agent 对抗/协作测试
🏪 Market (市场)    → 社区共享 Agent 模板
⚙️ Orchestra (编排) → 多 Agent 组装工作流
📊 Eval (评估)      → 基于真实任务的性能排行
```

#### 空白验证

```
现状:
- agency-agents → 纯 Markdown 模板，无测试/评估/编排
- CrewAI/AutoGen/LangGraph → 纯底层框架，无 Agent 定义/分享
- Paperclip ClipMart → 偏企业公司模板，非通用 Agent
- skills.sh → 偏 Skill 注册，非完整 Agent

AgentForge = 唯一同时做到:
定义 → 测试 → 评估 → 分享 → 编排 → 多工具导出
```

#### 跨平台

| 平台 | 形式 |
|------|------|
| Web | Next.js 主应用 (Builder + Market + Arena) |
| CLI | `agentforge create` / `agentforge test` / `agentforge publish` |
| VS Code | Agent 可视化编辑器扩展 |
| MCP | 作为 Agent 管理工具 |
| 导出 | Claude Code / Cursor / Aider / OpenCode 等格式 |

---

### 💡 创意 5: **OmniPulse — AI 跨平台趋势感知 + GEO 雷达**

> 灵感: MiroFish 的 GraphRAG + geo-seo-claude 的多维分析 + 实时趋势需求  
> 竞争: 🟡 **中低** — Google Trends 等只做关键词频率，无 AI 语义 + 无 GEO

#### 核心定位

```
"不是模拟未来，而是实时感知现在" + "追踪你的品牌在 AI 世界的可见度"

= 实时趋势发现引擎 + GEO 可见度追踪仪
```

#### 两大核心模块

```
模块 A: 趋势雷达
├── 采集: X / Reddit / HN / GitHub / 微博 / YouTube 
├── 理解: LLM 摘要 + NER + 情感分析
├── 关联: GraphRAG 跨平台知识图谱（同一话题多平台表现）
├── 检测: 趋势发现 + 异常点 + 预测模型
└── 输出: 实时仪表盘 + 告警

模块 B: GEO 监控
├── 追踪: 品牌在 ChatGPT/Perplexity/Gemini 中的引用变化
├── 评分: AI 可引性 + 品牌提及 + 实体识别 + 技术基础
├── 对比: 与竞品的 GEO 差距分析
└── 输出: 周报/月报 + 优化建议
```

#### 跨平台

| 平台 | 形式 |
|------|------|
| Web | React + D3.js 实时可视化 |
| Desktop | Tauri 轻量端（离线仪表盘） |
| Mobile | PWA + 推送告警 |
| CLI | `omnipulse scan --topic "AI agents"` |
| MCP | 作为数据源供其他 Agent 使用 |

---

## 五、综合评估矩阵

| 创意 | 创新性 | 市场需求 | 竞争密度 | 技术可行性 | 趣味性 | 社区潜力 | **综合** |
|------|--------|---------|---------|-----------|--------|---------|---------|
| 🎮 FateForge | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 🟢 极低 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **🥇 S** |
| ⚔️ CrisisForge | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 🟢 低 | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **🥈 A** |
| 🔨 AgentForge | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 🟢 低 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | **🥈 A** |
| 📡 OmniPulse | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 🟡 中低 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | **🥉 B+** |

---

## 六、🏆 最终推荐

### 首推: FateForge 🎮

**理由**:
1. **好玩又有用** — 这是你最看重的特质，FateForge 完美继承了 MiroFish 的 "让每一个如果都能看见结果"，但以游戏化方式实现
2. **竞争几乎为零** — 没有开源项目将 AI 群体预测 + 游戏化交互结合
3. **前端实现高度可行** — React Flow / Vue Flow 结合 GSAP 能够完美支撑大动态、高交互的"故事分支树"特效
4. **天然社交传播** — 预测对决 + 排行榜 + 社区挑战 = 病毒传播潜力
5. **MiroFish 精神续作** — 保留核心技术创新，降低使用门槛，扩大用户群

> ❌ **关于放弃 SkillGuard 赛道的决策备注：**
> 根据你提供的最新信息，安全审计领域已经属于 **强庄盘踞**。像 prompt-security/clawsec 这样的企业级开源套件不仅内置了 SHA256/Ed25519 签名、防篡改监控、NVD 漏洞关联，还能自动回滚。AgentSafety/ClawCare 甚至介入了底层 TypeScript Hook 做运行时沙盒。
> 
> 这个赛道的技术壁垒和生态位太高，如果是为了做一个独立的开源项目争取社区爆发，这不是个好选择（费力且很难形成独特认知）。更好的做法是：如果在后续开发其他 Agent 项目时需要安全，直接用 `npx clawhub install clawsec` 即可，若有定制需求直接提 PR 或 Fork。

### 组合策略
```
Phase 1 (3-4 周): FateForge MVP 前端核心构建 (React Flow + GSAP 分支动画) + 对接基础多结局 LLM 引擎
Phase 2 (4-6 周): 接入完善的多智能体引擎（如轻量化改进的 OASIS）处理更复杂的 "What-If" 推演逻辑
```

---

## 七、通用技术栈建议

| 层级 | 推荐 | 理由 |
|------|------|------|
| **前端** | Vue 3 (遵循 MiroFish) 或 React | MiroFish 用 Vue，社区更大用 React |
| **桌面** | Tauri 2.0 | Rust，比 Electron 轻 10x |
| **后端** | Python (FastAPI) | AI 生态对接最广 |
| **Agent 通信** | MCP + A2A | 2026 标准化协议 |
| **本地 LLM** | Ollama | 零门槛本地推理 |
| **图谱** | Neo4j / Zep Cloud | GraphRAG 标配 |
| **部署** | Docker + Vercel | 自托管 + 云端皆可 |

---

## 附：信息来源

- **项目源码**: [MiroFish](https://github.com/666ghj/MiroFish), [Paperclip](https://github.com/paperclipai/paperclip), [geo-seo-claude](https://github.com/zubair-trabzada/geo-seo-claude), [agency-agents](https://github.com/msitarzewski/agency-agents)
- **DeepWiki 文档**: [MiroFish DeepWiki](https://deepwiki.com/666ghj/MiroFish), [geo-seo-claude DeepWiki](https://deepwiki.com/zubair-trabzada/geo-seo-claude)
- **趋势来源**: GitHub Trending, Reddit (r/LocalLLaMA, r/MachineLearning, r/OpenSource), X/Twitter AI 社区, HackerNews, Dev.to
- **前次竞品分析**: [竞品全景分析](file:///Users/yangjunjie/.gemini/antigravity/brain/f4091c5a-98ec-40cd-9a60-a932986fd61a/competitive_landscape_analysis.md)
- **置信度**: Medium-High — 竞品分析已做两轮交叉验证；趋势数据来自多个独立平台
