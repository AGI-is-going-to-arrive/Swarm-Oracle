# SwarmOracle 升级探索 — 深度调研报告

> 文档类型：historical snapshot
> 当前真值：否
> 阅读方式：本文件是 2026-03-13 的探索性调研，不反映当前实现状态；其中部分推荐方向已落地或已失效。当前请以 `README.md`、`implement/README.md`、`llmdoc/*` 为准。

> 基于 MiroFish / paperclip / geo-seo-claude / agency-agents 灵感 + 近 3 个月 GitHub/Reddit/X/TrendShift 趋势分析
> 生成时间: 2026-03-13

---

## 一、当前项目基线

SwarmOracle 已完成 **P0-P9 全部 23 项优化**，410 个测试全部通过，功能涵盖：
多 Agent 模拟 → 分支时间线 → 蝴蝶效应干预 → 分层代理（千人） → 排行榜/竞猜 → BYOK → 社交媒体文案 → 语言检测 → Prometheus 可观测性

**核心差异化**：目前市面上没有同时具备「What-If 模拟 + 分支对比 + 用户竞猜」三合一的开源项目。

---

## 二、灵感项目深度解析

| 项目 | 核心亮点 | 可借鉴方向 |
|------|----------|-----------|
| **MiroFish** | GraphRAG + OASIS 多 Agent 社交模拟 → 预测报告 | 社交平台模拟引擎、趋势预测可视化、分析报告输出 |
| **paperclip** | AI Agent 自主决策循环、资源管理博弈 | 游戏化 Agent 竞争机制、**有限资源约束下的涌现行为** |
| **geo-seo-claude** | GEO 优化分析、多层评分、子代理架构 | 领域专家 Agent 编排、自动化评分体系、报告模板 |
| **agency-agents** | MCP 驱动的 Agent 协作网络 | Agent 间任务委派、工具调用链 |

---

## 三、近 3 个月 AI 趋势洞察

### 🔥 GitHub 热门方向

| 趋势类别 | 代表项目 | Star/活跃度 | 竞争评估 |
|----------|---------|:-----------:|:--------:|
| Multi-Agent 社交模拟 | AgentSociety, SimWorld | ⭐⭐⭐ 高 | 🟡 中等 — 学术驱动 |
| AI 辩论竞技场 | open-debate, llm-debate-arena, Agora | ⭐⭐ 中 | 🟢 **低** — 多为原型 |
| AI 交互叙事 | FictionX, StoryLab, WhisperQuest | ⭐⭐ 中 | 🟢 **低** — 碎片化 |
| 预测市场 + AI | socialpredict, Awesome-Prediction-Market-Tools | ⭐⭐⭐ 高 | 🟡 中等 — Web3 驱动 |
| LLM 社交推理游戏 | elimination_game, AImong Us, ai-telestrations | ⭐⭐ 中 | 🟢 **极低** |
| AI 文明模拟器 | Project Sid, aphae (AI Office Sim) | ⭐⭐ 中 | 🟢 **极低** |
| Agent 协作框架 | NexusAgent, AgentMesh, Zonny | ⭐⭐⭐ 高 | 🟡 中等 — 框架为主 |

### 💡 Reddit / X 讨论热点

1. **AI 辩论可视化** — 用户对「看 AI 互辩」的娱乐需求强烈，但现有工具缺乏视觉冲击力
2. **AI 预测游戏** — "人 vs AI" 预测对决是社交讨论高频话题（LinkedIn 的 LLM 预测对比帖高互动）
3. **AI 文明/社会实验** — Project Sid 引发广泛讨论，但无成熟开源工具
4. **AI 办公室模拟** — 像素风 + AI Agent 日常交互，"The Sims meets AI" 概念
5. **逆向图灵测试** — 人类伪装成 AI 的游戏概念，趣味性极强

---

## 四、SwarmOracle 升级方案（5 大方向）

### 💎 方向 A：AI 辩论竞技场（推荐指数 ⭐⭐⭐⭐⭐）

**对手**：open-debate (0⭐), Agora (0⭐), llm-debate-arena (3⭐) — **竞争极低**
**SwarmOracle 优势**：已有多 Agent + 分支时间线 + 排行榜

**升级内容**：

| 功能 | 说明 | 改动量 |
|------|------|:------:|
| 辩论模式 | 2-6 个 AI Agent 分正反方辩论，用户命题 | ~200 行 |
| 评委系统 | 独立评委 Agent 按论点、逻辑、说服力打分 | ~150 行 |
| ELO 排名 | 不同 LLM 模型 ELO 排行（GPT vs Claude vs Gemini） | ~100 行 |
| 辩论回放 | 流式逐字回放，类似直播体验 | 已有流式基础 |
| 用户投票 | 观众实时投票预测胜者，与评委结果对比 | 已有竞猜基础 |
| 辩论主题库 | 热门/随机/自定义话题 | ~50 行 |

**为什么好玩**：用户可以「出题」让不同 AI 互辩，看到不同模型的思维风格差异，投票预测，积累 ELO 排名。社交分享属性强。

---

### 🏙️ 方向 B：微型 AI 文明模拟器（推荐指数 ⭐⭐⭐⭐⭐）

**对手**：Project Sid (论文级), aphae (0⭐, Godot 游戏) — **无成熟开源竞品**
**SwarmOracle 优势**：已有千人分层架构 + Blackboard 共享记忆

**升级内容**：

| 功能 | 说明 | 改动量 |
|------|------|:------:|
| 微型社会模板 | 预设场景：中世纪村庄 / 太空殖民地 / 末日避难所 | ~100 行 |
| 社会动力学指标 | 信任度、经济、权力、文化 4 维指标实时面板 | ~300 行 |
| Agent 关系图谱 | D3.js 力引导图：友谊/敌对/联盟/贸易关系 | ~400 行前端 |
| 事件系统 | 随机事件（瘟疫/发明/战争）+ 用户注入事件 | ~200 行 |
| 文明演化时间轴 | 横向时间线展示关键转折点 + 分支可视化 | ~300 行前端 |
| 社会指标历史图 | 折线图追踪每轮各指标变化趋势 | ~150 行前端 |

**为什么好玩**：类似「模拟人生」的 AI 版——你创建一个微型社会，观察 Agent 们自发形成政治、经济、文化体系，可随时注入蝴蝶效应（"如果中世纪突然出现互联网？"）。极具观赏性和分享性。

---

### 🎮 方向 C：LLM 社交推理游戏（推荐指数 ⭐⭐⭐⭐）

**对手**：elimination_game (lechmazur), AImong Us — **竞争极低，多为实验**
**SwarmOracle 优势**：已有排行榜 + 社交分享 + Agent 个性化

**升级内容**：

| 游戏模式 | 规则 | 改动量 |
|----------|------|:------:|
| 🕵️ AI 狼人杀 | 5-10 个 AI Agent + 1 个人类玩家，投票淘汰 | ~400 行 |
| 🤖 逆向图灵测试 | 全是 AI，混入 1 个人类，AI 要找出人类 | ~300 行 |
| 📝 AI 一句话故事接龙 | 每个 Agent 续写一句，最终投票最佳故事 | ~200 行 |
| 🏝️ AI 生存投票 | 类「幸存者」，AI 结盟/背叛/投票淘汰 | ~350 行 |

**为什么好玩**：轻量级、上手快、社交属性强。「你能在一群 AI 中人隐藏身份不被识破吗？」这类钩子极具传播力。

---

### 📊 方向 D：AI 趋势预测擂台（推荐指数 ⭐⭐⭐⭐）

**对手**：socialpredict (Web3 预测市场) — **视角完全不同**
**SwarmOracle 优势**：已有模拟引擎 + 竞猜评分 + 多 Agent 架构

**升级内容**：

| 功能 | 说明 | 改动量 |
|------|------|:------:|
| 实时热点接入 | 爬取 RSS/API 获取最新新闻作为模拟输入 | ~200 行 |
| 多 Agent 预测面板 | 乐观派/悲观派/数据派/阴谋论派 Agent 辩论预测 | ~150 行 |
| 预测准确度追踪 | 回溯验证：过去的预测 vs 实际结果 | ~200 行 |
| 用户 vs AI 积分榜 | 人类预测 vs AI 预测的历史对比 | 已有竞猜基础 |
| 预测报告导出 | MiroFish 风格的分析报告（PDF/Markdown） | ~150 行 |

**为什么好玩**：用户出题让 AI 预测未来事件（科技/体育/政治），然后等结果验证。长期积累形成「AI Oracle 预测排行榜」。

---

### 📖 方向 E：AI 交互叙事引擎（推荐指数 ⭐⭐⭐）

**对手**：FictionX (22⭐), StoryLab (1⭐), SEELE (商业) — **开源竞争低**
**SwarmOracle 优势**：已有分支时间线 + 干预系统 + 多结局对比

**升级内容**：

| 功能 | 说明 | 改动量 |
|------|------|:------:|
| 角色扮演模式 | 用户扮演其中一个角色，其余由 AI 驱动 | ~300 行 |
| 分支叙事图 | 可视化故事分支树，点击切换时间线 | 已有 BranchTree |
| 多结局画廊 | 收集所有可能结局，解锁成就系统 | ~200 行 |
| 叙事风格模板 | 武侠/科幻/推理/日常 预设 | ~100 行 |
| 语音叙事 | TTS 朗读故事，沉浸式体验 | ~150 行 |

---

## 五、综合推荐 & 实施优先级

| 排名 | 方向 | 趣味性 | 竞争度 | 复用率 | 社交性 | 开发量 | 推荐 |
|:----:|------|:------:|:------:|:------:|:------:|:------:|:----:|
| 1 | **B: 微型 AI 文明模拟器** | ⭐⭐⭐⭐⭐ | 🟢 极低 | 90% | ⭐⭐⭐⭐⭐ | 中 | **🏆 首选** |
| 2 | **A: AI 辩论竞技场** | ⭐⭐⭐⭐ | 🟢 低 | 85% | ⭐⭐⭐⭐ | 小 | **🥈 最快上线** |
| 3 | **C: LLM 社交推理游戏** | ⭐⭐⭐⭐⭐ | 🟢 极低 | 70% | ⭐⭐⭐⭐⭐ | 中 | **🥉 最有传播力** |
| 4 | D: AI 趋势预测擂台 | ⭐⭐⭐⭐ | 🟡 中 | 80% | ⭐⭐⭐ | 中 | 实用型 |
| 5 | E: AI 交互叙事引擎 | ⭐⭐⭐ | 🟡 中 | 75% | ⭐⭐⭐ | 大 | 细分市场 |

### 🔥 最佳组合策略

**Phase 1 (2 周)**：在现有 SwarmOracle 基础上增加 **AI 辩论竞技场** 模式 — 开发量最小，已有 Agent/流式/排行榜基础
**Phase 2 (4 周)**：升级为 **微型 AI 文明模拟器** — 增加社会动力学面板 + 关系图谱 + 事件系统
**Phase 3 (2 周)**：叠加 **LLM 社交推理游戏** 模式 — 狼人杀/逆向图灵测试，最大化传播力

**最终产品定位**：**SwarmOracle 2.0 — AI Agent 社会实验室**
> "创建微型社会，出辩题让 AI 辩论，和 AI 玩狼人杀，预测未来趋势 — 一个让你「上帝视角」观察 AI 社会的开源平台"

---

## 六、技术架构复用分析

```
现有 SwarmOracle 架构复用率 > 80%

✅ 完全复用                    🔧 需扩展                    ❌ 需新建
─────────────────────────────────────────────────────────────────
Agent 生成 (parser)          辩论规则引擎                  社会动力学模块
模拟循环 (simulator)          评委/裁判 Agent               关系图谱 (D3.js)
分支时间线 (branches)         游戏模式路由                  游戏匹配/房间
Blackboard 共享记忆           ELO 计算                     实时事件面板
排行榜/竞猜 (leaderboard)     投票机制                     文明指标仪表盘
流式推送 (WebSocket)          AI 个性化增强
社交分享 (social copy)        模板管理
BYOK (API Key)               前端新页面/组件
Prometheus 监控
语言检测/i18n
Docker 部署
```

---

## 七、参考项目与资源

| 类别 | 项目/链接 |
|------|----------|
| 社交模拟 | [AgentSociety](https://github.com/AgentSociety), [SimWorld](https://github.com/SimWorld), [MiroFish](https://github.com/666ghj/MiroFish) |
| AI 辩论 | [open-debate](https://github.com/tomwalczak/open-debate), [Agora](https://github.com/bernhardbrugger/agora), [llm-debate-arena](https://github.com/shibing624/llm-debate-arena) |
| AI 游戏 | [elimination_game](https://github.com/lechmazur/elimination_game), AImong Us, ai-telestrations |
| 文明模拟 | Project Sid (MIT), [aphae](https://github.com/rsanandres/aphae) |
| 交互叙事 | [FictionX](https://github.com/wyseos/fictionx-story-gen), [StoryLab](https://github.com/asharomu/StoryLab-AI-Qwen3-32B), WhisperQuest |
| Agent 框架 | [NexusAgent](https://github.com/NetMindAI-Open/NexusAgent), [agency-agents](https://github.com/msitarzewski/agency-agents) |
| 预测市场 | [socialpredict](https://github.com/openpredictionmarkets/socialpredict), [Awesome-Prediction-Market-Tools](https://github.com/aarora4/Awesome-Prediction-Market-Tools) |
