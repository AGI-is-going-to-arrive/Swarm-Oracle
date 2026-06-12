import { type PublicArtifact } from '../types';

/**
 * Builds a self-contained premium HTML file containing the de-identified public artifact.
 * Features a pure vanilla JS safe renderer that uses `.textContent` to avoid innerHTML injection.
 * Styled with the SwarmOracle OKLCH color palette and supports full accessibility + bilingual views.
 */
export function buildSingleFileGalleryHtml(artifact: PublicArtifact, lang: 'en' | 'zh'): string {
  const isZh = lang === 'zh';
  const titleText = isZh ? 'SwarmOracle 公开预测快照' : 'SwarmOracle Public Forecast Snapshot';
  const disclaimerText = isZh
    ? '本页为公开脱敏快照，不包含任何私有配置、密钥或用户凭证。'
    : 'This page is a public de-identified snapshot and does not contain private configurations or credentials.';

  const labelQuestion = isZh ? '推演问题' : 'Simulation Question';
  const labelBranches = isZh ? '决策分支时间线' : 'Timelines';
  const labelAgents = isZh ? '参与推演的 Agent 群' : 'Agent Swarm';
  const labelSources = isZh ? '已验证来源' : 'Verified Sources';
  const labelExcerpts = isZh ? '分支对话片段' : 'Excerpts';
  const labelProb = isZh ? '概率' : 'Probability';

  // Prevent script injection breakout by escaping closing script tag sequences
  const jsonStr = JSON.stringify(artifact).replace(/<\/script>/gi, '<\\/script>');

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titleText}</title>
  <style>
    :root {
      --color-primary: oklch(55% 0.22 350);
      --color-primary-dim: oklch(65% 0.18 350);
      --color-danger: oklch(60% 0.18 25);
      --color-success: oklch(65% 0.15 150);
      --color-warning: oklch(75% 0.16 80);
      --color-base: oklch(98% 0.005 80);
      --color-surface: oklch(99% 0.002 80);
      --color-text-primary: oklch(20% 0.01 80);
      --color-text-secondary: oklch(45% 0.01 80);
      --color-text-muted: oklch(65% 0.01 80);
      --color-border-subtle: oklch(90% 0.01 80);
      --color-border-default: oklch(85% 0.01 80);
      --font-body: 'Instrument Sans', 'Noto Sans SC', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      --font-heading: 'Cormorant Garamond', 'Noto Serif SC', Georgia, serif;
    }

    body {
      font-family: var(--font-body);
      background-color: var(--color-base);
      color: var(--color-text-primary);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }

    .container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 40px 20px;
    }

    header {
      border-bottom: 2px solid var(--color-border-default);
      padding-bottom: 24px;
      margin-bottom: 32px;
      text-align: center;
    }

    header h1 {
      font-family: var(--font-heading);
      font-size: 2.2rem;
      margin: 0 0 8px 0;
      color: var(--color-primary);
    }

    header p {
      color: var(--color-text-secondary);
      font-size: 1rem;
      margin: 0;
    }

    .card {
      background-color: var(--color-surface);
      border: 1px solid var(--color-border-subtle);
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.03);
      padding: 32px;
    }

    .question-section {
      margin-bottom: 28px;
    }

    .label {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--color-primary);
      font-weight: 700;
      margin-bottom: 6px;
      display: block;
    }

    .question {
      font-family: var(--font-heading);
      font-size: 1.8rem;
      line-height: 1.3;
      margin: 0;
      color: var(--color-text-primary);
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 32px;
      margin-top: 32px;
    }

    @media (min-width: 768px) {
      .grid {
        grid-template-columns: 2fr 1fr;
      }
    }

    section {
      border-top: 1px solid var(--color-border-subtle);
      padding-top: 24px;
    }

    section h3 {
      font-family: var(--font-heading);
      font-size: 1.4rem;
      margin: 0 0 16px 0;
    }

    .list {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .item {
      border: 1px solid var(--color-border-subtle);
      border-radius: 8px;
      padding: 20px;
      background-color: var(--color-base);
    }

    .item-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
      gap: 12px;
    }

    .item-title {
      font-family: var(--font-heading);
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0;
    }

    .confidence-badge {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.02em;
    }

    .confidence-high {
      background-color: oklch(90% 0.1 150 / 0.2);
      color: var(--color-success);
      border: 1px solid oklch(65% 0.15 150 / 0.3);
    }

    .confidence-medium {
      background-color: oklch(92% 0.1 80 / 0.2);
      color: var(--color-warning);
      border: 1px solid oklch(75% 0.16 80 / 0.3);
    }

    .confidence-low {
      background-color: oklch(92% 0.1 25 / 0.2);
      color: var(--color-danger);
      border: 1px solid oklch(60% 0.18 25 / 0.3);
    }

    .bar-wrapper {
      margin-bottom: 12px;
    }

    .bar-outer {
      background-color: var(--color-border-subtle);
      border-radius: 4px;
      height: 8px;
      overflow: hidden;
      position: relative;
    }

    .bar-inner {
      background-color: var(--color-primary);
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .bar-text {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--color-text-secondary);
      text-align: right;
      margin-top: 4px;
    }

    .verdict-box {
      background-color: var(--color-surface);
      border-left: 3px solid var(--color-primary);
      padding: 12px 16px;
      border-radius: 0 8px 8px 0;
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chip {
      background-color: var(--color-base);
      border: 1px solid var(--color-border-subtle);
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 0.9rem;
      color: var(--color-text-secondary);
    }

    .sources-box {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .source-row {
      background-color: var(--color-base);
      border: 1px solid var(--color-border-subtle);
      border-radius: 6px;
      padding: 8px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
    }

    .source-domain {
      font-weight: 600;
      color: var(--color-text-secondary);
    }

    .source-count {
      background-color: var(--color-primary-dim);
      color: #fff;
      border-radius: 12px;
      padding: 2px 8px;
      font-size: 0.75rem;
      font-weight: bold;
    }

    .disclaimer {
      font-size: 0.85rem;
      color: var(--color-text-muted);
      border-top: 1px solid var(--color-border-subtle);
      margin-top: 48px;
      padding-top: 16px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${titleText}</h1>
      <p>${disclaimerText}</p>
    </header>

    <div class="card">
      <div class="question-section">
        <span class="label">${labelQuestion}</span>
        <h2 class="question" id="rendered-question"></h2>
      </div>

      <div class="grid">
        <div>
          <section>
            <h3>${labelBranches}</h3>
            <div class="list" id="rendered-branches"></div>
          </section>
        </div>

        <div>
          <section>
            <h3>${labelAgents}</h3>
            <ul class="chips" id="rendered-agents"></ul>
          </section>

          <section style="margin-top: 24px;">
            <h3>${labelSources}</h3>
            <div class="sources-box" id="rendered-sources"></div>
          </section>
        </div>
      </div>

      <div class="disclaimer">
        <p>${disclaimerText}</p>
      </div>
    </div>
  </div>

  <script id="swarm-artifact" type="application/json">${jsonStr}</script>
  <script>
    (function() {
      const dataEl = document.getElementById('swarm-artifact');
      if (!dataEl) return;
      try {
        const artifact = JSON.parse(dataEl.textContent);

        // Render Question
        document.getElementById('rendered-question').textContent = artifact.question;

        // Render Agents
        const agentsContainer = document.getElementById('rendered-agents');
        if (artifact.display_agent_names && artifact.display_agent_names.length > 0) {
          artifact.display_agent_names.forEach(name => {
            const li = document.createElement('li');
            li.className = 'chip';
            li.textContent = name;
            agentsContainer.appendChild(li);
          });
        } else {
          const li = document.createElement('li');
          li.textContent = '${isZh ? '无' : 'None'}';
          agentsContainer.appendChild(li);
        }

        // Render Sources
        const sourcesContainer = document.getElementById('rendered-sources');
        if (artifact.source_summary && artifact.source_summary.domains && artifact.source_summary.domains.length > 0) {
          artifact.source_summary.domains.forEach(item => {
            const row = document.createElement('div');
            row.className = 'source-row';

            const domainSpan = document.createElement('span');
            domainSpan.className = 'source-domain';
            domainSpan.textContent = item.domain;

            const countSpan = document.createElement('span');
            countSpan.className = 'source-count';
            countSpan.textContent = item.source_count;

            row.appendChild(domainSpan);
            row.appendChild(countSpan);
            sourcesContainer.appendChild(row);
          });
        } else {
          const div = document.createElement('div');
          div.textContent = '${isZh ? '无' : 'None'}';
          sourcesContainer.appendChild(div);
        }

        // Render Branches
        const branchesContainer = document.getElementById('rendered-branches');
        const verdicts = artifact.branch_verdicts || [];
        const probabilityBars = artifact.probability_bars || [];
        const excerpts = artifact.transcript_excerpts || [];

        const sortedBars = probabilityBars.slice().sort((a, b) => a.branch_index - b.branch_index);

        if (sortedBars.length > 0) {
          sortedBars.forEach(bar => {
            const item = document.createElement('article');
            item.className = 'item';

            const itemHeader = document.createElement('div');
            itemHeader.className = 'item-header';

            const title = document.createElement('h4');
            title.className = 'item-title';
            title.textContent = bar.label;
            itemHeader.appendChild(title);

            const verdict = verdicts.find(v => v.branch_index === bar.branch_index);
            if (verdict) {
              const meta = document.createElement('div');
              const badge = document.createElement('span');
              badge.className = 'confidence-badge confidence-' + verdict.confidence;

              let confText = verdict.confidence;
              if (verdict.confidence === 'high') confText = '${isZh ? '高置信度' : 'High Confidence'}';
              else if (verdict.confidence === 'medium') confText = '${isZh ? '中置信度' : 'Medium Confidence'}';
              else if (verdict.confidence === 'low') confText = '${isZh ? '低置信度' : 'Low Confidence'}';

              badge.textContent = confText;
              meta.appendChild(badge);
              itemHeader.appendChild(meta);
            }

            item.appendChild(itemHeader);

            // Probability Bar
            const barWrapper = document.createElement('div');
            barWrapper.className = 'bar-wrapper';

            const barOuter = document.createElement('div');
            barOuter.className = 'bar-outer';

            const percentage = Math.round(bar.probability * 100);
            const barInner = document.createElement('div');
            barInner.className = 'bar-inner';
            barInner.role = 'progressbar';
            barInner.setAttribute('aria-valuenow', percentage);
            barInner.setAttribute('aria-valuemin', '0');
            barInner.setAttribute('aria-valuemax', '100');
            barInner.style.width = percentage + '%';
            barOuter.appendChild(barInner);

            const barText = document.createElement('div');
            barText.className = 'bar-text';
            barText.textContent = percentage + '% ${labelProb}';

            barWrapper.appendChild(barOuter);
            barWrapper.appendChild(barText);
            item.appendChild(barWrapper);

            // Verdict Box
            if (verdict) {
              const verdictBox = document.createElement('div');
              verdictBox.className = 'verdict-box';
              verdictBox.textContent = verdict.verdict;
              item.appendChild(verdictBox);
            }

            // Excerpts
            const branchExcerpts = excerpts.filter(ex => ex.branch_index === bar.branch_index);
            if (branchExcerpts.length > 0) {
              const excHeader = document.createElement('h5');
              excHeader.style.margin = '16px 0 8px 0';
              excHeader.style.fontSize = '0.85rem';
              excHeader.style.color = 'var(--color-text-secondary)';
              excHeader.style.textTransform = 'uppercase';
              excHeader.textContent = '${labelExcerpts}';
              item.appendChild(excHeader);

              const excWrapper = document.createElement('div');
              excWrapper.style.display = 'flex';
              excWrapper.style.flexDirection = 'column';
              excWrapper.style.gap = '8px';

              branchExcerpts.forEach(ex => {
                const excLine = document.createElement('div');
                excLine.style.fontSize = '0.9rem';

                const agentSpan = document.createElement('strong');
                agentSpan.style.color = 'var(--color-primary)';
                agentSpan.textContent = ex.agent_name + ': ';

                const textSpan = document.createElement('span');
                textSpan.style.fontStyle = 'italic';
                textSpan.style.color = 'var(--color-text-secondary)';
                textSpan.textContent = ex.text;

                excLine.appendChild(agentSpan);
                excLine.appendChild(textSpan);
                excWrapper.appendChild(excLine);
              });
              item.appendChild(excWrapper);
            }

            branchesContainer.appendChild(item);
          });
        } else {
          const emptyDiv = document.createElement('div');
          emptyDiv.textContent = '${isZh ? '无' : 'None'}';
          branchesContainer.appendChild(emptyDiv);
        }
      } catch (err) {
        console.error('Failed to render artifact:', err);
      }
    })();
  </script>
</body>
</html>`;
}
