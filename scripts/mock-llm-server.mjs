import http from "node:http";

const HOST = process.env.MOCK_LLM_HOST || "127.0.0.1";
const PORT = Number(process.env.MOCK_LLM_PORT || "18318");
const RESPONSE_DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS || "0");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function waitForDelay() {
  if (!Number.isFinite(RESPONSE_DELAY_MS) || RESPONSE_DELAY_MS <= 0) return;
  await new Promise((resolve) => {
    setTimeout(resolve, RESPONSE_DELAY_MS);
  });
}

function extractPrompt(payload) {
  if (typeof payload?.input === "string") return payload.input;
  if (Array.isArray(payload?.messages)) {
    return payload.messages
      .map((message) => {
        if (typeof message?.content === "string") return message.content;
        if (Array.isArray(message?.content)) {
          return message.content
            .map((entry) => {
              if (typeof entry === "string") return entry;
              if (typeof entry?.text === "string") return entry.text;
              return "";
            })
            .join("\n");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function isChinesePrompt(prompt) {
  return /[\u4e00-\u9fff]/.test(prompt);
}

function parseTargetAgentCount(prompt) {
  const match =
    prompt.match(/精确等于\s*(\d+)\s*个/) ||
    prompt.match(/exactly\s*(\d+)\s*(?:agents|roles?)/i);
  const parsed = Number(match?.[1] || 3);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 8) : 3;
}

function parserResponse(prompt) {
  const zh = isChinesePrompt(prompt);
  const targetAgents = parseTargetAgentCount(prompt);
  const agentSeeds = zh
    ? [
        ["顾闻", "边境联络官", "负责把局势翻译给不同派系，谨慎但不迟疑。", "支持", "CORE"],
        ["林铎", "资源调度员", "天天盯着供给和执行链，讨厌空话。", "观望", "CORE"],
        ["周汐", "民生观察员", "更在意普通人的代价，习惯追问细节。", "反对", "CORE"],
        ["韩策", "安全协调员", "先看系统性漏洞，再决定是否加码。", "中立", "IMPORTANT"],
        ["沈砚", "现场记录员", "安静、精确，擅长指出隐藏成本。", "观望", "IMPORTANT"],
        ["许衡", "舆情分析师", "对情绪变化极敏感，警惕失控反弹。", "观望", "CROWD"],
        ["叶岚", "议会观察员", "关注程序秩序，反感仓促越权。", "反对", "CROWD"],
        ["唐策", "技术顾问", "愿意试验新方案，但坚持留后手。", "支持", "CROWD"],
      ]
    : [
        ["Mara Quinn", "Frontier Liaison", "Translates pressure across factions and acts with careful urgency.", "support", "CORE"],
        ["Jonah Pike", "Resource Dispatcher", "Tracks supply pressure and distrusts vague promises.", "neutral", "CORE"],
        ["Elise Ward", "Civic Observer", "Pushes every argument back to ordinary people and concrete cost.", "oppose", "CORE"],
        ["Rhea Cole", "Safety Coordinator", "Looks for system-wide failure modes before endorsing escalation.", "neutral", "IMPORTANT"],
        ["Milan Cross", "Field Recorder", "Quiet, precise, and good at spotting hidden tradeoffs.", "neutral", "IMPORTANT"],
        ["Avery Stone", "Signal Analyst", "Reads mood shifts quickly and worries about backlash.", "neutral", "CROWD"],
        ["Nadia Hale", "Committee Clerk", "Protects procedure and dislikes improvised authority.", "oppose", "CROWD"],
        ["Theo Marsh", "Systems Adviser", "Likes bold reforms but insists on an escape hatch.", "support", "CROWD"],
      ];

  const agents = agentSeeds.slice(0, targetAgents).map(([name, role, persona, stance, tier]) => ({
    name,
    role,
    persona,
    stance,
    tier,
  }));

  return JSON.stringify({
    setting: zh
      ? {
          time_period: "近未来",
          location: "高压治理中的大型都市",
          background: "制度正在被新技术快速改写。各派都知道这次选择会改变执行链和责任边界。",
        }
      : {
          time_period: "Near future",
          location: "A high-pressure metropolitan state",
          background: "A new institutional design is being pushed into a live system. Everyone knows this decision will redraw execution and accountability lines.",
        },
    key_variable: zh ? "制度是否把最终裁量交给新规则" : "Whether the system hands final discretion to the new rule set",
    initial_title: zh ? "变局开端" : "Turning Point",
    agents,
    simulation_rounds: 3,
    branch_sensitivity: 0.55,
  });
}

function agentMessageResponse(prompt) {
  const zh = isChinesePrompt(prompt);
  const speaker =
    prompt.match(/你正在扮演角色「([^」]+)」/)?.[1] ||
    prompt.match(/speaker_name[:：]\s*([^\n]+)/i)?.[1] ||
    prompt.match(/speaker_name\"?\s*[:=]\s*\"([^\"]+)/i)?.[1] ||
    (zh ? "角色" : "Speaker");
  return JSON.stringify({
    content: zh
      ? `${speaker}强调必须把新变化装进可执行的护栏里，否则后续代价会被低估。`
      : `${speaker} argues that the system needs a guardrailed adjustment now, or the hidden cost will surface later.`,
    emotion: zh ? "冷静" : "calm",
    diverge: null,
  });
}

function forkResponse(prompt) {
  const zh = isChinesePrompt(prompt);
  return JSON.stringify({
    should_fork: false,
    reason: zh ? "当前分歧还不足以形成稳定分叉" : "The disagreement is not strong enough to justify a stable fork yet",
    branches: [],
  });
}

function memoryResponse(prompt) {
  const zh = isChinesePrompt(prompt);
  return JSON.stringify({
    situation: zh ? "局势正在围绕责任边界与执行代价收紧。" : "The situation is tightening around accountability and execution cost.",
    active_debates: zh
      ? ["谁来承担临时权力的代价", "制度护栏是否足够"]
      : ["Who absorbs the cost of emergency authority", "Whether the guardrails are strong enough"],
    key_quotes: zh
      ? ["[议员]: 不能让例外状态变成常态路径"]
      : ["[Speaker]: Emergency exceptions cannot quietly become the default path"],
    tension_points: zh
      ? ["效率与追责之间的张力"]
      : ["The tension between speed and accountability"],
    consensus: zh ? "各方都承认需要某种可回滚的安全阀。" : "All sides concede that some reversible safety valve is necessary.",
  });
}

function narrationResponse(prompt) {
  const zh = isChinesePrompt(prompt);
  return JSON.stringify({
    story: zh
      ? "辩论最初围绕效率展开，但很快转向更难回避的问题：一旦临时权力失手，谁来承担责任。几位关键角色先后把争论从口号拉回到制度护栏、执行链路和现实代价，最终让世界线在高压中收束成一条仍可被追责的路径。"
      : "The debate begins as a fight over efficiency, then tightens around the harder question: who pays when emergency authority fails. One by one, the key speakers drag the argument back to guardrails, execution chains, and concrete cost, and the worldline settles on a path that still leaves room for accountability.",
    insight: zh ? "真正改变走向的不是口号，而是谁能把代价和责任讲清楚。" : "The turning point is not rhetoric but who can make cost and accountability concrete.",
    key_moments: zh
      ? ["争论从效率转向追责", "执行护栏被明确写入方案"]
      : ["The debate shifts from speed to accountability", "Guardrails become part of the executable plan"],
  });
}

function scoringResponse(prompt) {
  const zh = isChinesePrompt(prompt);
  return JSON.stringify({
    score: 84,
    reason: zh ? "核心方向基本命中" : "Mostly matched the core direction",
  });
}

function judgeAnalysisResponse(prompt) {
  const zh = isChinesePrompt(prompt);
  const propositionLabel = zh ? "正方把责任链讲得更完整" : "The proposition made the accountability chain more complete";
  const oppositionLabel = zh ? "反方的效率压力真实，但没给出更稳的替代机制" : "The opposition exposed real speed pressure but not a steadier mechanism";

  return JSON.stringify({
    summary: zh
      ? "这场辩论的胜负并不取决于谁喊得更狠，而取决于谁把机制、代价和责任链讲得更完整。正方最后把临时权力、复核节点和追责路径扣成一条线，因此裁决更稳。反方抓到了执行迟滞的痛点，但没能把这个痛点组织成更可信的制度替代。"
      : "This debate was not decided by volume but by who made the mechanism, cost, and accountability chain cohere. The proposition ultimately tied temporary power, review timing, and liability into one cleaner line, which made the verdict more stable. The opposition surfaced a real execution delay problem, but never converted it into a more credible alternative design.",
    winner_reason: propositionLabel,
    loser_gap: oppositionLabel,
    swing_factor: zh ? "关键转折在于把抽象正义改写成可执行流程。" : "The swing factor was turning abstract fairness into an executable process.",
    closing_note: zh ? "胜方不是更大胆，而是更能承受追问。" : "The winning side was not bolder, just more durable under scrutiny.",
    dimension_rationales: {
      coherence: zh ? "正方论证链更完整。" : "The proposition kept the cleaner line of argument.",
      evidence: zh ? "双方都有例子，但正方和机制绑定得更紧。" : "Both sides used examples, but the proposition tied them more tightly to mechanism.",
      adaptability: zh ? "正方给出了更清楚的修补与回滚方案。" : "The proposition offered the clearer repair and rollback path.",
      impact: zh ? "正方更清楚地说明了制度后果。" : "The proposition made the institutional consequences easier to see.",
    },
    counterplay_explanation: "",
    adjudication: {
      winner: "proposition",
      verdict_tone: "balance",
      dimensions: {
        coherence: { proposition: 4, opposition: 3 },
        evidence: { proposition: 4, opposition: 3 },
        adaptability: { proposition: 4, opposition: 3 },
        impact: { proposition: 4, opposition: 3 },
      },
    },
  });
}

function socialCopyResponse(prompt) {
  if (/xiaohongshu|小红书/i.test(prompt)) {
    return "📕制度热议\n这次推演最有意思的地方，不是表面上的效率之争，而是“谁来承担紧急权力失手后的责任”。一开始大家都在谈速度，后来真正改变走向的是对复核节点、追责链和现实代价的追问。结果并没有给出一个绝对浪漫的答案，而是把制度护栏、回滚空间和执行后果一起摆上桌面。这样的世界线不一定最激进，但更可持续，也更值得复盘。#制度推演# #WhatIf# #SwarmOracle#";
  }
  if (/weibo|微博/i.test(prompt)) {
    return "如果紧急权力必须公开解释，制度会更慢还是更稳？这次推演给出的答案不是口号，而是责任链。速度重要，但没人负责的速度更危险。#制度推演# #SwarmOracle#";
  }
  if (/zhihu|知乎/i.test(prompt)) {
    return "## 这场推演真正回答了什么\n它回答的不是“效率和程序哪个更重要”这种抽象问题，而是谁有资格在紧急状态下做决定、谁来承担决定后的后果，以及制度如何留下复核与纠偏空间。\n\n## 为什么结果有说服力\n因为争论最终没有停留在价值宣示，而是落到了执行链、追责节点和现实代价。\n\n## 我的看法\n真正稳的制度，不是没有例外，而是连例外都能被事后追问。";
  }
  if (/reddit/i.test(prompt)) {
    return "[r/whatif] What makes an emergency institution stable is not raw speed but whether the exception path still leaves an audit trail. TL;DR: the scenario lands on accountability over improvisation.";
  }
  if (/\bX\b|twitter/i.test(prompt)) {
    return "🧵 1/3 The interesting part of this simulation was not the slogan but the accountability chain. 2/3 Once emergency power had to survive review, the debate shifted from speed to consequence. 3/3 Stable systems are the ones that can still explain themselves under pressure. #WhatIf #SwarmOracle";
  }
  return "OK";
}

function pickContent(prompt) {
  if (!prompt.trim()) return "OK";
  if (/场景解析器|simulation_rounds|branch_sensitivity/i.test(prompt)) return parserResponse(prompt);
  if (/should_fork|历史分歧分析师/i.test(prompt)) return forkResponse(prompt);
  if (/态势简报|active_debates|key_quotes/i.test(prompt)) return memoryResponse(prompt);
  if (/故事讲述者|\"story\"|key_moments/i.test(prompt)) return narrationResponse(prompt);
  if (/预测评估器|\"score\"|\"reason\"/i.test(prompt)) return scoringResponse(prompt);
  if (/终局评委与解说员|final judge and color commentator/i.test(prompt)) return judgeAnalysisResponse(prompt);
  if (/小红书|微博|知乎|Reddit|Twitter|\bX\b/i.test(prompt)) return socialCopyResponse(prompt);
  if (/回复格式 \(严格 JSON\)|\"content\"|speaker_name|Debate Arena/i.test(prompt)) return agentMessageResponse(prompt);
  return "OK";
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(payload)}\n`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    writeJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    writeJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  try {
    const payload = await readJson(req);
    const prompt = extractPrompt(payload);
    const content = pickContent(prompt);
    await waitForDelay();
    writeJson(res, 200, {
      id: "mock-chatcmpl-1",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: payload?.model || "mock-llm",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (error) {
    writeJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mock LLM server listening on http://${HOST}:${PORT}/v1/chat/completions`);
});
