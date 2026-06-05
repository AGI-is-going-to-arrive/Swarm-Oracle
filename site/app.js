/* SwarmOracle · Oracle Noir — interactions
   Bilingual (zh default), reveal-on-scroll, quickstart tabs,
   copy, mobile drawer, cursor-aware oracle glow. No frameworks. */
(function () {
  "use strict";
  var S = "assets/screenshots/";

  /* ---- real content (verbatim) ---- */
  var FEATURES = [
    { id: "F01", img: "01-home.png", hero: false, zt: "首页提问框与开始推演", et: "Home Question Box and Start Simulation",
      zd: "在首页输入一个「如果……会怎样？」问题，确认问题和本局设置后进入多 Agent 推演。", ed: "Enter a “what if?” question on the home page, confirm the question and run settings, then start the multi-agent simulation." },
    { id: "F37", img: "02-result.png", hero: true, zt: "分享与预测卡片", et: "Sharing and Prediction Card",
      zd: "结果页可生成分享文案、复制固定链接，也可导出 1200×630 预测卡片，卡片包含问题、主导结局、可见来源和前几位 Agent 名字。", ed: "The result page can generate share copy, copy a permalink, and export a 1200×630 prediction card with the question, dominant ending, visible sources and top agents." },
    { id: "F02", img: "20-debate-arena.png", hero: false, zt: "辩论竞技场", et: "Debate Arena",
      zd: "从首页直接进入辩论竞技场，创建正方、反方和评委，按固定阶段推进一局更短的对抗讨论。", ed: "Jump straight into the Debate Arena, create affirmative, opposing and judge roles, and run a shorter staged adversarial debate." },
    { id: "F13", img: "14-roundtable.png", hero: false, zt: "世界线圆桌", et: "Worldline Roundtable",
      zd: "多条结局可用时，世界线圆桌让不同世界线的代表坐在同一张桌上讨论，已完成的圆桌会恢复保存的讨论和 Deep Dive。", ed: "When multiple endings exist, the Worldline Roundtable seats representatives of different worldlines at one table; finished tables restore the saved discussion and Deep Dive." },
    { id: "F10", img: "17-ending-chamber.png", hero: false, zt: "结局会客厅 / 神谕密室", et: "Ending Chamber / Oracle Chamber",
      zd: "从某条世界线进入会客厅追问当前结局的参与者，角色基于这条世界线已发生的事回答。", ed: "Enter the chamber from a worldline to question that ending’s participants; characters answer based on what already happened in this worldline." },
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
      zd: "打开后系统会在推演前搜索资料并把相关片段注入角色提示，推荐路径优先用服务端已配置搜索，高级路径允许本轮用自己的 provider。", ed: "When enabled, the system searches before simulating and injects relevant snippets into role prompts; the recommended path uses server-configured search, the advanced path lets you use your own provider for the round." }
  ];

  var MODES = [
    { n: "01", img: ["21-simulation.png", "02-result.png"], zt: "多分支推演", et: "Multi-branch simulation",
      zd: "一个「如果……会怎样？」问题，由 AI 代理群体模拟多条故事线，结果页用一句话回答原问题并给出置信度，每条世界线带标题、概率、故事摘要和直接回答。", ed: "One “what if?” question, simulated by a swarm of AI agents into multiple storylines; the result page answers the original question in one line with a confidence, and every worldline carries a title, probability, story summary and a direct answer." },
    { n: "02", img: ["20-debate-arena.png", "15-debate.png"], zt: "辩论竞技场", et: "Debate Arena",
      zd: "辩论竞技场创建正方、反方和评委，按固定阶段推进一局更短的对抗讨论；辩论结果页展示比分、角色和裁判结论，可加载论点地图。", ed: "The Debate Arena creates affirmative, opposing and judge roles and runs a shorter staged debate; the result page shows the score, roles and the judge’s verdict, and can load the argument map." },
    { n: "03", img: ["17-ending-chamber.png"], zt: "神谕密室 / 结局会客厅", et: "Oracle Chambers / Ending Chamber",
      zd: "从某条世界线进入结局会客厅追问当前结局的参与者，角色基于这条世界线已经发生的事回答。", ed: "Enter the Ending Chamber from a worldline to question that ending’s participants; characters answer based on what already happened in this worldline." },
    { n: "04", img: ["14-roundtable.png"], zt: "世界线圆桌", et: "Worldline Roundtable",
      zd: "世界线圆桌让不同世界线的代表坐在同一张桌上讨论，支持深度剖析、快速过审和交锋三种模式，完成后可回到已保存结果并继续 Deep Dive。", ed: "The Worldline Roundtable seats representatives of different worldlines at one table in deep-dive, quick-review or clash modes; afterwards you can return to the saved result and continue Deep Dive." },
    { n: "05", img: ["13-compare.png"], zt: "反事实对比", et: "Counterfactual compare",
      zd: "反事实对比横向展示原分支和改写后的分支，逐条消息标出红绿差异，没有可对比数据时显示空态而不是伪造分支。", ed: "Counterfactual compare shows the original and rewritten branch side by side, marking per-message diffs in red and green, and shows an empty state rather than fabricating a branch." },
    { n: "06", img: ["06-causal-map.png", "08-kg-explorer.png"], zt: "因果图谱 + 知识图谱", et: "Causal graph + knowledge graph",
      zd: "从结果页进入图谱工作台、知识图谱浏览器和时间线星系：因果图谱把事件、分叉和结局连成有向图，知识图谱用实体、事件和主张组织结果，时间线星系把多条世界线放进同一张时间图。", ed: "From the result page, enter the graph workbench, knowledge graph explorer and timeline galaxy: the causal graph wires events, forks and endings into a directed graph, the knowledge graph organizes results by entities, events and claims, and the timeline galaxy places many worldlines on one time chart." }
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
      '<h3><span data-zh="' + m.zt + '" data-en="' + m.et + '">' + m.zt + '</span><small data-zh="' + m.et + '" data-en="' + m.zt + '">' + m.et + '</small></h3>' +
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
  document.getElementById("burger").addEventListener("click", function () { drawer.classList.add("open"); });
  document.getElementById("drawerClose").addEventListener("click", function () { drawer.classList.remove("open"); });
  drawer.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { drawer.classList.remove("open"); }); });

  /* ---- quickstart tabs ---- */
  document.querySelectorAll(".qs__tab").forEach(function (t) {
    t.addEventListener("click", function () {
      document.querySelectorAll(".qs__tab").forEach(function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      var key = t.getAttribute("data-tab");
      document.querySelectorAll(".qs__panel").forEach(function (p) { p.classList.toggle("on", p.getAttribute("data-panel") === key); });
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
