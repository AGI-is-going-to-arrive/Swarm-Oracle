/* SwarmOracle · Oracle Noir — interactions
   Bilingual (zh default), reveal-on-scroll, quickstart tabs,
   copy, mobile drawer, cursor-aware oracle glow. No frameworks. */
(function () {
  "use strict";
  var S = "assets/screenshots/";

  /* ---- feature copy ---- */
  var FEATURES = [
    { id: "F01", img: "01-home.png", hero: false, zt: "首页提问框与开始推演", et: "Home Question Box and Start Simulation",
      zd: "在首页输入一个「如果……会怎样？」问题，确认设置后开始多 Agent 推演；开始按钮不可用时会直接说明原因（缺问题、未配置 LLM 或预算受限）。", ed: "Type a “what if?” question on the home page, confirm the settings, and start the multi-agent simulation; when the start button is unavailable, it says why (missing question, no LLM, or a budget limit)." },
    { id: "F49", img: "01-home.png", hero: false, zt: "官方样例一键体验", et: "One-Click Official Samples",
      zd: "未配置模型也能在首页一键打开推荐的完整官方样例：无需 API Key、无需选择文件，也不会调用模型；导入面板还可选择另外两套样例或本地 Snapshot。", ed: "Even without a configured model, open the recommended complete official sample from the home page with one click—no API key, file selection, or model call. The import panel also offers two more samples or a local snapshot." },
    { id: "F50", img: "21-simulation.png", hero: false, zt: "导演玩法与因果档案", et: "Director Play and Causal Archive",
      zd: "在 live 推演里使用玩法卡、锁定一次预测押注或承诺一条世界线；结局后，因果档案把出牌、判断、关键时刻与最终落点放进同一份复盘。", ed: "During a live run, play gameplay cards, lock one prediction bet, or commit to a worldline. After the ending, the Causal Archive brings cards, calls, key moments, and the final landing point into one debrief." },
    { id: "F51", img: "21-simulation.png", hero: false, zt: "Agent 状态与分支感知记忆", et: "Agent State and Branch-Aware Memory",
      zd: "从推演中的 Agent 卡打开档案，区分配置立场与已观察情绪，并标明对应世界线和轮次；记忆沿当前分支谱系承接，不混入其他分支的后续经历。", ed: "Open an agent profile from the simulation roster to separate configured stance from observed emotion and see the matching worldline and round. Memory follows the current branch lineage instead of mixing in later experience from another branch." },
    { id: "F37", img: "02-result.png", hero: true, zt: "分享与预测卡片", et: "Sharing and Prediction Card",
      zd: "结果页可生成分享文案、复制固定链接，也可导出 1200×630 预测卡片，卡片包含问题、主导结局、可见来源和前几位 Agent 名字。", ed: "The result page can generate share copy, copy a permalink, and export a 1200×630 prediction card with the question, dominant ending, visible sources and top agents." },
    { id: "F41", img: "23-full-report.png", hero: false, zt: "结果完整报告", et: "Result Full Report",
      zd: "结果页先显示摘要和章节入口；完整报告展开证据、不确定性、观察指标和可用图表，证据可跳回 replay。", ed: "The result page starts with a digest and section links; the full report opens evidence, uncertainty, watch signals, and available charts, with evidence links back to replay." },
    { id: "F02", img: "20-debate-arena.png", hero: false, zt: "辩论竞技场", et: "Debate Arena",
      zd: "从首页直接进入辩论竞技场，创建正方、反方和评委，按固定阶段推进一局更短的对抗讨论；无可用 LLM 或启动失败时，页面会显示原因。", ed: "Jump straight into the Debate Arena, create affirmative, opposing and judge roles, and run a shorter staged adversarial debate; if no LLM is usable or launch fails, the page shows the reason." },
    { id: "F13", img: "14-roundtable.png", hero: false, zt: "世界线圆桌", et: "Worldline Roundtable",
      zd: "多条结局可用时，世界线圆桌让不同世界线的代表坐在同一张桌上讨论，已完成的圆桌会恢复保存的讨论和 Deep Dive。", ed: "When multiple endings exist, the Worldline Roundtable seats representatives of different worldlines at one table; finished tables restore the saved discussion and Deep Dive." },
    { id: "F10", img: "17-ending-chamber.png", hero: false, zt: "结局会客厅 / 神谕密室", et: "Ending Chamber / Oracle Chamber",
      zd: "从某条世界线进入会客厅追问当前结局的参与者；模型配置开启时，可展开高级设置为本次会客厅选择 profile。", ed: "Enter the chamber from a worldline to question that ending’s participants; when model profiles are enabled, open Advanced settings to choose a profile for this chamber." },
    { id: "F21", img: "06-causal-map.png", hero: false, zt: "因果图谱", et: "Causal Graph",
      zd: "因果图谱把事件、分叉和结局连成有向图，用来追踪哪个事件触发了后面的变化。", ed: "The causal graph wires events, forks and endings into a directed graph to trace which event triggered later changes." },
    { id: "F23", img: "08-kg-explorer.png", hero: false, zt: "知识图谱浏览器", et: "Knowledge Graph Explorer",
      zd: "知识图谱浏览器用实体、事件和主张组织结果数据，可筛选节点、打开详情，也可从节点继续追问。", ed: "The knowledge graph explorer organizes result data by entities, events and claims; filter nodes, open details, or keep asking from a node." },
    { id: "F25", img: "13-compare.png", hero: false, zt: "反事实对比", et: "Counterfactual Compare",
      zd: "反事实对比横向展示原分支和改写后的分支，没有可对比数据时显示空态而不是伪造分支。", ed: "Counterfactual compare shows the original and rewritten branch side by side, and shows an empty state rather than fabricating a branch." },
    { id: "F29", img: "04-agent-workshop.png", hero: false, zt: "自定义 Agent 工坊", et: "Custom Agent Workshop",
      zd: "工坊可手动创建或编辑自定义 Agent，也支持从 PDF 文档生成 Agent，长文档会保留已成功生成的 Agent 并提示失败数量。", ed: "The workshop lets you hand-craft or edit custom agents, or generate them from a PDF; long documents keep the agents that succeeded and report the failure count." },
    { id: "F33", img: "05-journal.png", hero: false, zt: "预测日志", et: "Prediction Journal",
      zd: "预测日志记录你对结果的概率判断，之后可标记是否发生并查看校准情况，绑定场景时按当前用户校验可见性。", ed: "The prediction journal records your probability calls, lets you later mark whether they happened and review calibration, checking visibility per user when bound to a scenario." },
    { id: "F35", img: "10-leaderboard.png", hero: false, zt: "排行榜", et: "Leaderboard",
      zd: "排行榜展示预测分数，支持按场景类型、日期和 Agent 数筛选，筛选条件同步到 URL 方便分享当前视图。", ed: "The leaderboard shows prediction scores, filterable by scenario type, date and agent count, with filters synced to the URL for sharing the current view." },
    { id: "F38", img: "01-home.png", hero: false, config: true, zt: "搜索增强推演", et: "Search-Augmented Simulation",
      zd: "打开后，系统在推演前先做外部搜索，把相关片段注入角色提示词；默认用服务器已配置的搜索，也可以本轮换成自己的搜索服务。", ed: "When enabled, the system searches the web before simulating and injects relevant snippets into role prompts; it uses the server-configured search by default, or your own search provider for the round." },
    { id: "F48", img: "22-local-packs.png", hero: false, zt: "本地主题包", et: "Local Packs",
      zd: "首页的「本地主题包」收录一批双语预设场景，可按类型分段和关键词筛选；点一下模板即可填入问题和推荐设置。", ed: "The home page bundles bilingual preset scenario packs, filterable by genre and keyword; one click on a template fills in the question and suggested settings." },
    { id: "F44", img: "23-multi-run.png", hero: false, zt: "多次推演分布", et: "Multi-Run Distribution",
      zd: "同一个问题可运行多次；等待面板显示进度，结果页汇总各次终局分布。", ed: "Run the same question several times; the waiting panel shows progress and the result page summarizes terminal outcomes." },
    { id: "F47", img: "24-document-seed.png", hero: false, zt: "文档种子", et: "Document Seed",
      zd: "首页可上传 PDF、TXT 或 Markdown，系统把内容提炼成推演背景，让 Agent 基于你的资料展开，而不只凭一句问题。", ed: "Upload a PDF, TXT or Markdown on the home page and the system distills it into the run’s backdrop, so agents build on your material rather than a single question." },
    { id: "F42", img: "25-model-profiles.png", hero: false, zt: "模型配置", et: "Model Profiles",
      zd: "保存多套模型接入配置（服务商、地址、模型、密钥、限速等），推演、辩论或结果页会客厅开局前一键切换。", ed: "Save several model setups (provider, URL, model, key, rate limits and more) and switch in one click before a simulation, debate, or result-page chamber." },
    { id: "F45", img: "28-you-vs-oracle.png", hero: false, zt: "你的预测 vs 预言机", et: "Your Prediction vs the Oracle",
      zd: "提交自己的预测，与 AI 终局对比；无法判定时显示不可评分原因。", ed: "Submit your own prediction and compare it with the AI outcome; unresolvable cases explain why they are not scorable." },
    { id: "F46", img: "27-social.png", hero: false, zt: "社交动态与头条卡", et: "Social Feed & Headline Cards",
      zd: "结果页的「社交动态」把推演结果改写成几条社交平台风格的头条卡片，可一键复制文字或下载图片，方便分享。", ed: "The result page’s Social Feed rewrites your outcome into a few platform-styled headline cards you can copy as text or download as images." },
    { id: "F43", img: "26-gallery.png", hero: false, zt: "公开分享与画廊", et: "Public Sharing & Gallery",
      zd: "分享弹窗可导出脱敏 JSON 或单文件 HTML；问题和结局仍属于公开内容。", ed: "The share dialog exports redacted JSON or a single-file HTML gallery; the question and endings remain public content." }
  ];

  var MODES = [
    { n: "01", img: ["21-simulation.png", "02-result.png"], zt: "多分支推演", et: "Multi-branch simulation",
      zd: "一个问题展开多条世界线：实时看轮次与发言，完成后查看结论、概率和故事摘要。", ed: "Expand one question into several worldlines, watch rounds and messages live, then inspect the verdict, probabilities, and story summaries." },
    { n: "02", img: ["20-debate-arena.png", "15-debate.png"], zt: "辩论竞技场", et: "Debate Arena",
      zd: "正方、反方和评委分阶段讨论；结果页展示结论并可加载论点地图。", ed: "Proposition, opposition, and judge debate in phases; the result shows the verdict and can load an argument map." },
    { n: "03", img: ["17-ending-chamber.png"], zt: "神谕密室 / 结局会客厅", et: "Oracle Chambers / Ending Chamber",
      zd: "从某条世界线进入结局会客厅追问当前结局的参与者；需要指定模型时，展开高级设置选择 profile，不选则走全局默认。", ed: "Enter the Ending Chamber from a worldline to question that ending’s participants; when you need a specific model, open Advanced settings and choose a profile, or leave it blank for the global default." },
    { n: "04", img: ["14-roundtable.png"], zt: "世界线圆桌", et: "Worldline Roundtable",
      zd: "不同世界线的代表同桌讨论；完成后可恢复结果并继续 Deep Dive。", ed: "Representatives from different worldlines share one table; completed results can be restored for Deep Dive." },
    { n: "05", img: ["13-compare.png"], zt: "反事实对比", et: "Counterfactual compare",
      zd: "并排查看原分支和改写分支，定位它们从哪里开始分歧。", ed: "Compare the original and rewritten branches side by side and find where they diverge." },
    { n: "06", img: ["06-causal-map.png", "08-kg-explorer.png"], zt: "因果图谱 + 知识图谱", et: "Causal graph + knowledge graph",
      zd: "用因果图、知识图谱和时间线查看事件、实体、主张与世界线关系。", ed: "Use causal, knowledge, and timeline views to inspect events, entities, claims, and worldline relationships." }
  ];

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  /* ---- build feature grid ---- */
  var grid = document.getElementById("fgrid");
  FEATURES.forEach(function (f, i) {
    var card = el("article", "fcard reveal" + (f.hero ? " fcard--hero" : ""));
    card.style.setProperty("--d", (i % 3) * 70 + "ms");
    var badge = f.config ? ' <span class="badge-config" data-zh="需配置" data-en="Requires config">需配置</span>' : "";
    card.innerHTML =
      '<div class="fcard__shot"><span class="fcard__tag">' + f.id + '</span>' +
      '<img loading="lazy" decoding="async" width="' + (f.hero ? 760 : 380) + '" height="' + (f.hero ? 300 : 190) + '" src="' + S + f.img + '" data-alt-zh="' + f.zt + '" data-alt-en="' + f.et + '" alt="' + f.zt + '"></div>' +
      '<div class="fcard__body"><h3><span data-zh="' + f.zt + '" data-en="' + f.et + '">' + f.zt + '</span>' + badge + '</h3>' +
      '<p data-zh="' + f.zd + '" data-en="' + f.ed + '">' + f.zd + '</p></div>';
    grid.appendChild(card);
  });

  /* ---- build modes ---- */
  var modesList = document.getElementById("modes-list");
  MODES.forEach(function (m) {
    var sec = el("article", "mode reveal");
    var two = m.img.length > 1;
    var figs = m.img.map(function (src) {
      return '<figure class="mode__fig"><img loading="lazy" decoding="async" width="560" height="' + (two ? 220 : 300) + '" src="' + S + src + '" data-alt-zh="' + m.zt + '" data-alt-en="' + m.et + '" alt="' + m.zt + '"></figure>';
    }).join("");
    sec.innerHTML =
      '<div class="mode__text"><div class="mode__num">' + m.n + '</div>' +
      '<h3><span data-zh="' + m.zt + '" data-en="' + m.et + '">' + m.zt + '</span><small data-zh="模式 ' + m.n + '" data-en="Mode ' + m.n + '">模式 ' + m.n + '</small></h3>' +
      '<p data-zh="' + m.zd + '" data-en="' + m.ed + '">' + m.zd + '</p></div>' +
      '<div class="mode__figs ' + (two ? "two" : "") + '">' + figs + '</div>';
    modesList.appendChild(sec);
  });

  /* ---- language ---- */
  var lang = localStorage.getItem("so-lang") || "zh";
  function applyLang(l) {
    lang = l;
    document.documentElement.lang = l;
    localStorage.setItem("so-lang", l);
    document.querySelectorAll("[data-zh]").forEach(function (n) {
      var v = n.getAttribute("data-" + l);
      if (v != null) n.innerHTML = v;
    });
    document.querySelectorAll("[data-alt-zh]").forEach(function (n) {
      var v = n.getAttribute("data-alt-" + l);
      if (v != null) n.setAttribute("alt", v);
    });
    document.querySelectorAll("[data-aria-zh]").forEach(function (n) {
      var v = n.getAttribute("data-aria-" + l);
      if (v != null) n.setAttribute("aria-label", v);
    });
    document.querySelectorAll("[data-src-zh]").forEach(function (n) {
      if (n.tagName === "VIDEO") return; // video handled below (needs poster + load())
      var v = n.getAttribute("data-src-" + l);
      if (v != null && n.getAttribute("src") !== v) n.setAttribute("src", v);
    });
    // Intro video: swap poster + <source> per language, then reload
    var vid = document.getElementById("introVideo");
    if (vid) {
      var poster = vid.getAttribute("data-poster-" + l);
      if (poster != null) vid.setAttribute("poster", poster);
      var aria = vid.getAttribute("data-aria-" + l);
      if (aria != null) vid.setAttribute("aria-label", aria);
      var vsrc = vid.getAttribute("data-src-" + l);
      var source = vid.querySelector("source");
      if (vsrc != null && source && source.getAttribute("src") !== vsrc) {
        source.setAttribute("src", vsrc);
        vid.load();
      }
      // 字幕已烧录进视频，移除了 <track> VTT 软字幕轨，无需再切换 textTrack mode。
    }
    document.querySelectorAll(".lang button").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-lang") === l);
    });
  }
  document.querySelectorAll(".lang button").forEach(function (b) {
    b.addEventListener("click", function () {
      var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) { applyLang(b.getAttribute("data-lang")); return; }
      document.body.style.transition = "opacity 80ms ease"; document.body.style.opacity = "0.85";
      setTimeout(function () { applyLang(b.getAttribute("data-lang")); document.body.style.opacity = "1"; }, 80);
    });
  });
  applyLang(lang);

  /* ---- reveal on scroll ---- */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach(function (n) { io.observe(n); });

  /* ---- nav scrolled ---- */
  var nav = document.getElementById("nav");
  function onScroll() { nav.classList.toggle("scrolled", window.scrollY > 24); }
  onScroll(); window.addEventListener("scroll", onScroll, { passive: true });

  /* ---- drawer ---- */
  var drawer = document.getElementById("drawer");
  var burger = document.getElementById("burger");
  function setDrawer(open) {
    drawer.classList.toggle("open", open);
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
    drawer.inert = !open;
    burger.setAttribute("aria-expanded", open ? "true" : "false");
  }
  burger.addEventListener("click", function () { setDrawer(true); });
  document.getElementById("drawerClose").addEventListener("click", function () { setDrawer(false); burger.focus(); });
  drawer.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { setDrawer(false); }); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && drawer.classList.contains("open")) {
      setDrawer(false);
      burger.focus();
    }
  });

  /* ---- quickstart tabs ---- */
  document.querySelectorAll(".qs__tab").forEach(function (t) {
    t.addEventListener("click", function () {
      document.querySelectorAll(".qs__tab").forEach(function (x) { x.classList.remove("on"); });
      document.querySelectorAll(".qs__tab").forEach(function (x) { x.setAttribute("aria-selected", x === t ? "true" : "false"); });
      t.classList.add("on");
      var key = t.getAttribute("data-tab");
      document.querySelectorAll(".qs__panel").forEach(function (p) {
        var on = p.getAttribute("data-panel") === key;
        p.classList.toggle("on", on);
        p.hidden = !on;
      });
    });
  });

  /* ---- copy ---- */
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy").replace(/&quot;/g, '"');
      navigator.clipboard && navigator.clipboard.writeText(text);
      var lbl = btn.querySelector("span"); var prev = lbl.innerHTML;
      btn.classList.add("done"); lbl.innerHTML = lang === "zh" ? "已复制 ✓" : "Copied ✓";
      setTimeout(function () { btn.classList.remove("done"); lbl.innerHTML = prev; }, 1400);
    });
  });

  /* ---- cursor glow (desktop, motion ok) ---- */
  var glow = document.querySelector(".cursor-glow");
  if (glow && matchMedia("(hover: hover)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var hero = document.querySelector(".hero"); var raf;
    document.addEventListener("mousemove", function (ev) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = null;
        var r = hero.getBoundingClientRect();
        var inHero = ev.clientY < r.bottom + 120;
        glow.style.opacity = inHero ? "1" : "0";
        glow.style.left = ev.clientX + "px"; glow.style.top = ev.clientY + "px";
      });
    });
  }
})();
