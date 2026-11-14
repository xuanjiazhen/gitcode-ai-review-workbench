const byId = id => document.getElementById(id);
const storageKey = 'cangjie-workbench:review-metrics:v1';
const findingsTable = byId('metrics-content');
const reportSelect = byId('report-select');
const detail = byId('metrics-detail');
const counts = [
  'all_bot_comment_count', 'diff_comment_count', 'discussion_comment_count', 'scope_pending_count',
  'finding_count', 'unclassified_candidate_count', 'resolved', 'unresolved', 'state_unknown',
  'resolved_full', 'resolved_partial', 'resolved_not_adopted', 'resolved_adoption_unknown',
  'adoption_numerator', 'adoption_denominator',
];
const decisions = {
  full: ['完全采纳', 'on'],
  partial: ['部分采纳', ''],
  not_adopted: ['未采纳', 'off'],
  unknown: ['待判定', ''],
};
const states = { resolved: ['已解决', 'on'], unresolved: ['未解决', 'off'], unknown: ['状态未知', ''] };
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
});
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
let reports = [];
let activeReport;

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function dateLabel(value) {
  return dateFormat.format(new Date(value));
}

function ratio(value) {
  return value === null ? '—' : percentFormat.format(value);
}

function evidenceReference(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password ||
      [...url.searchParams.keys()].some(key => /token|password|secret|api[_-]?key|authorization/i.test(key))) return null;
  } catch {
    // Preserve local references and evidence excerpts as plain text.
  }
  return value.trim() || null;
}

function evidenceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isCount(value) { return Number.isSafeInteger(value) && value >= 0; }

function normalizeReport(value) {
  if (typeof value?.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(value.repository) ||
    value.repository.split('/').some(part => part === '.' || part === '..') ||
    typeof value.observed_at !== 'string' || Number.isNaN(Date.parse(value.observed_at)) ||
    !['repository', 'selected_prs'].includes(value.scope?.type) || !Array.isArray(value.scope.prs) ||
    value.scope.prs.some(pr => !isCount(pr) || pr < 1) ||
    new Set(value.scope.prs).size !== value.scope.prs.length ||
    value.rule_version !== 'diff-only-resolved-v2' || typeof value.collection_complete !== 'boolean' ||
    counts.some(key => !isCount(value[key])) || !Array.isArray(value.findings)) {
    throw new Error('报告格式不正确。请使用工作台的统计导出命令生成 JSON。');
  }
  const prs = new Set(value.scope.prs);
  const ids = new Set();
  const findingStates = { resolved: 0, unresolved: 0, unknown: 0 };
  const resolvedVerdicts = { full: 0, partial: 0, not_adopted: 0, unknown: 0 };
  const findings = value.findings.map(finding => {
    if (typeof finding?.id !== 'string' || !finding.id || ids.has(finding.id) || !prs.has(finding.pr) ||
      !Object.hasOwn(states, finding.state) || !Object.hasOwn(decisions, finding.adoption) ||
      !Array.isArray(finding.comment_keys) || !finding.comment_keys.length ||
      finding.comment_keys.some(key => typeof key !== 'string' || !key.startsWith(`${finding.pr}:`)) ||
      !Array.isArray(finding.evidence) || finding.evidence.some(url => typeof url !== 'string')) {
      throw new Error('报告包含无效的意见或证据记录。');
    }
    ids.add(finding.id);
    findingStates[finding.state]++;
    if (finding.state === 'resolved') resolvedVerdicts[finding.adoption]++;
    return {
      id: finding.id, pr: finding.pr, state: finding.state, adoption: finding.adoption,
      rationale: typeof finding.rationale === 'string' ? finding.rationale : '',
      evidence: [...new Set(finding.evidence.map(evidenceReference).filter(Boolean))],
      comment_keys: finding.comment_keys,
    };
  });
  const denominator = value.resolved;
  const numerator = value.resolved_full;
  const classificationComplete = value.collection_complete && !value.unclassified_candidate_count &&
    !value.state_unknown && !value.scope_pending_count;
  const canPublish = classificationComplete && !value.resolved_adoption_unknown;
  const expectedRates = {
    adoption_rate: denominator ? numerator / denominator : null,
    adoption_assessment_coverage: denominator ? (denominator - value.resolved_adoption_unknown) / denominator : null,
    final_adoption_rate: denominator && canPublish ? numerator / denominator : null,
  };
  if (value.finding_count !== findings.length || value.resolved !== findingStates.resolved ||
    value.unresolved !== findingStates.unresolved || value.state_unknown !== findingStates.unknown ||
    value.all_bot_comment_count !== value.diff_comment_count + value.discussion_comment_count + value.scope_pending_count ||
    value.resolved_full !== resolvedVerdicts.full || value.resolved_partial !== resolvedVerdicts.partial ||
    value.resolved_not_adopted !== resolvedVerdicts.not_adopted || value.resolved_adoption_unknown !== resolvedVerdicts.unknown ||
    numerator !== value.adoption_numerator || denominator !== value.adoption_denominator ||
    Object.entries(expectedRates).some(([key, expected]) => value[key] !== expected)) {
    throw new Error('报告汇总与逐条意见不一致，请重新导出。');
  }
  return {
    repository: value.repository, observed_at: value.observed_at,
    scope: { type: value.scope.type, prs: value.scope.prs },
    rule_version: value.rule_version,
    assessment_version: typeof value.assessment_version === 'string' ? value.assessment_version : null,
    collection_complete: value.collection_complete, classification_complete_for_scope: classificationComplete,
    publishable_for_collected_scope: canPublish,
    ...Object.fromEntries(counts.map(key => [key, value[key]])), ...expectedRates, findings,
  };
}

function reportKey(report) {
  return JSON.stringify([report.repository.toLowerCase(), new Date(report.observed_at).toISOString(),
    report.scope.type, [...report.scope.prs].sort((a, b) => a - b), report.assessment_version]);
}

function readReports(value) {
  if (value?.version !== 1 || !Array.isArray(value.reports)) throw new Error('请选择工作台统计报告 JSON。');
  const parsed = value.reports.map(normalizeReport);
  if (new Set(parsed.map(reportKey)).size !== parsed.length) throw new Error('报告含重复的观测快照。');
  return parsed;
}

function mergeReports(base, newer) {
  const combined = new Map(base.map(report => [reportKey(report), report]));
  newer.forEach(report => combined.set(reportKey(report), report));
  return [...combined.values()].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) ||
    a.repository.localeCompare(b.repository));
}

function notice(message, error = false) {
  const output = byId('metrics-notice');
  output.textContent = message;
  output.classList.toggle('error', error);
}

function badge([label, style]) {
  return `<span class="pill ${style}">${label}</span>`;
}

function card(label, value, hint, featured = false) {
  return `<article class="metric${featured ? ' metrics-featured' : ''}"><span class="metric-top">${label}</span>
    <strong>${value}</strong><small>${hint}</small></article>`;
}

function adoptionLabel(finding) {
  return finding.state === 'resolved' ? decisions[finding.adoption] : ['暂不计入', ''];
}

function renderTable() {
  const state = byId('finding-state').value;
  const adoption = byId('finding-adoption').value;
  const search = byId('finding-search').value.trim().replace(/^#/, '').toLowerCase();
  const filtered = activeReport.findings.map((finding, index) => ({ finding, index })).filter(({ finding }) =>
    (!state || finding.state === state) &&
    (!adoption || finding.state === 'resolved' && finding.adoption === adoption) &&
    (!search || [finding.pr, finding.id, finding.rationale, ...finding.comment_keys].join(' ').toLowerCase().includes(search)));
  byId('findings-rows').innerHTML = filtered.length
    ? filtered.map(({ finding, index }) => `<tr>
      <td><a href="${prUrl(activeReport, finding)}" target="_blank" rel="noopener noreferrer">#${finding.pr} ↗</a></td>
      <td class="metrics-finding-title">${escape(finding.rationale || finding.id)}</td>
      <td>${badge(states[finding.state])}</td><td>${badge(adoptionLabel(finding))}</td>
      <td class="row-end"><button class="row-open" data-finding="${index}" aria-label="查看 PR ${finding.pr} 的意见详情">↗</button></td>
    </tr>`).join('')
    : '<tr><td class="empty" colspan="5">没有符合条件的意见。</td></tr>';
  byId('findings-count').textContent = `显示 ${filtered.length} / ${activeReport.findings.length} 条意见`;
}

function prUrl(report, finding) {
  return `https://gitcode.com/${report.repository}/pull/${finding.pr}`;
}

function renderReport(report, missingRepo) {
  activeReport = report;
  byId('metrics-export').disabled = !report;
  if (!report) {
    const title = missingRepo ? `${escape(missingRepo)} 暂无统计报告` : '暂无统计报告';
    findingsTable.innerHTML = `<section class="metrics-panel empty"><h2>${title}</h2><p>从本地统计工具导出报告，再选择「导入报告」。</p></section>`;
    return;
  }
  const decided = report.resolved - report.resolved_adoption_unknown;
  const final = report.final_adoption_rate !== null ? ratio(report.final_adoption_rate)
    : report.resolved ? '待判定' : report.publishable_for_collected_scope ? '暂无数据' : '待核实';
  const snapshotScope = report.scope.type === 'repository' ? '全仓快照' : '指定 PR';
  const boundLabel = report.classification_complete_for_scope ? '已确认采纳下限' : '当前已核实意见内确认占比';
  const bound = report.resolved ? `${report.adoption_numerator} / ${report.resolved} · ${ratio(report.adoption_rate)}` : '暂无数据';
  const pending = [
    [!report.collection_complete, '采集尚未完成'],
    [report.scope_pending_count, `${report.scope_pending_count} 条评论类型待核实`],
    [report.unclassified_candidate_count, `${report.unclassified_candidate_count} 条 Diff 评论待分类`],
    [report.state_unknown, `${report.state_unknown} 条意见的解决状态未知`],
    [report.resolved_adoption_unknown, `${report.resolved_adoption_unknown} 条已解决意见待判定采纳`],
  ].filter(([needed]) => needed).map(([, label]) => label);

  findingsTable.innerHTML = `
    <div class="metrics-summary">
      <span><strong>${escape(report.repository)}</strong></span>
      <span>${snapshotScope} · ${report.scope.prs.length} 个 PR</span>
      <span><time datetime="${escape(report.observed_at)}">${dateLabel(report.observed_at)}</time> · 北京时间</span>
    </div>
    <div class="metrics">
      ${card('独立 Diff 意见', report.finding_count, `${report.diff_comment_count} 条 Bot Diff 评论`)}
      ${card('已解决', report.resolved, `${report.unresolved} 条未解决${report.state_unknown ? ` · ${report.state_unknown} 条状态未知` : ''}`)}
      ${card('最终采纳率', final, '完全采纳 ÷ 全部已解决', true)}
      ${card('采纳判定覆盖率', ratio(report.adoption_assessment_coverage), `${decided} / ${report.resolved} 条已解决意见已判定`)}
    </div>
    <div class="metrics-panels">
      <section class="metrics-panel">
        <h2>已解决意见的采纳分布</h2>
        <dl class="status-list">
          <div><dt>完全采纳</dt><dd>${report.resolved_full}</dd></div>
          <div><dt>部分采纳</dt><dd>${report.resolved_partial}</dd></div>
          <div><dt>未采纳</dt><dd>${report.resolved_not_adopted}</dd></div>
          <div><dt>待判定</dt><dd>${report.resolved_adoption_unknown}</dd></div>
        </dl>
        <p>${boundLabel} <strong>${bound}</strong></p>
      </section>
      <section class="metrics-panel">
        <h2>统计范围</h2>
        <p>${report.all_bot_comment_count} 条 Bot 评论中，${report.diff_comment_count} 条为文件 Diff 评论，${report.discussion_comment_count} 条为讨论区评论。采纳率使用已解决的独立 Diff 意见。</p>
        ${pending.length ? `<ul class="metrics-pending">${pending.map(label => `<li>${label}</li>`).join('')}</ul>` : ''}
        ${report.resolved ? `<progress class="metrics-progress" max="${report.resolved}" value="${decided}" aria-label="采纳判定覆盖"></progress><small>${decided} / ${report.resolved} 已判定</small>` : ''}
      </section>
    </div>
    <section aria-labelledby="findings-title">
      <div class="section-heading"><div><h2 id="findings-title">检视意见</h2><p>按 PR、解决状态和采纳结论筛选，打开详情查看证据。</p></div></div>
      <div class="table-card">
        <div class="table-tools metrics-finding-tools">
          <label>解决状态 <select id="finding-state"><option value="">全部状态</option>${options(states)}</select></label>
          <label>采纳结论 <select id="finding-adoption"><option value="">全部结论</option>${options(decisions)}</select></label>
          <label class="search"><input id="finding-search" type="search" placeholder="搜索 PR 或意见…" aria-label="搜索 PR 或意见"></label>
        </div>
        <div class="table-scroll" tabindex="0" aria-label="检视意见表格，可横向滚动"><table>
          <thead><tr><th scope="col">PR</th><th scope="col">判定理由</th><th scope="col">解决状态</th><th scope="col">采纳结论</th><th scope="col" class="row-end">详情</th></tr></thead>
          <tbody id="findings-rows"></tbody>
        </table></div>
        <div class="table-foot"><span id="findings-count" role="status"></span></div>
      </div>
    </section>`;
  for (const id of ['finding-state', 'finding-adoption', 'finding-search']) byId(id).addEventListener('input', renderTable);
  renderTable();
}

function options(values) {
  return Object.entries(values).map(([key, [label]]) => `<option value="${key}">${label}</option>`).join('');
}

function selectReports(preferredKey, preferredRepo) {
  reportSelect.replaceChildren();
  for (const report of reports) {
    const scope = report.scope.type === 'repository' ? '全仓' : `${report.scope.prs.length} 个 PR`;
    const version = report.assessment_version ? ` · ${report.assessment_version}` : '';
    reportSelect.add(new Option(`${report.repository} · ${dateLabel(report.observed_at)} · ${scope}${version}`, reportKey(report)));
  }
  if (preferredRepo && !reports.some(report => report.repository.toLowerCase() === preferredRepo.toLowerCase())) {
    reportSelect.add(new Option('选择其他仓库报告', ''), 0);
    reportSelect.value = '';
    reportSelect.disabled = !reports.length;
    renderReport(undefined, preferredRepo);
    return;
  }
  if (!reports.length) reportSelect.add(new Option('暂无报告', ''));
  reportSelect.disabled = !reports.length;
  const selected = reports.find(report => reportKey(report) === preferredKey) ??
    reports.find(report => report.repository.toLowerCase() === preferredRepo?.toLowerCase()) ?? reports[0];
  if (selected) reportSelect.value = reportKey(selected);
  renderReport(selected);
}

function openFinding(finding) {
  detail.innerHTML = `<div class="dialog-heading"><div><p>${escape(activeReport.repository)}</p>
    <h2 id="metrics-detail-title">PR #${finding.pr} · 检视意见</h2></div>
    <form method="dialog"><button class="close-button" aria-label="关闭">×</button></form></div>
    <div class="dialog-body metrics-detail-body">
      <p>${badge(states[finding.state])} ${badge(adoptionLabel(finding))}</p>
      <h3>判定理由</h3><p>${escape(finding.rationale || '暂无判定理由。')}</p>
      <h3>评论编号</h3><p><code>${finding.comment_keys.map(escape).join('、')}</code></p>
      <p><a class="button button-primary" href="${prUrl(activeReport, finding)}" target="_blank" rel="noopener noreferrer">在 GitCode 查看 PR ↗</a></p>
      <h3>证据链接</h3>
      ${finding.evidence.length ? `<ul>${finding.evidence.map((reference, index) => {
        const link = evidenceUrl(reference);
        return link ? `<li><a href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">证据 ${index + 1} · ${escape(link.hostname)} ↗</a></li>`
          : `<li class="metrics-reference">${escape(reference)}</li>`;
      }).join('')}</ul>` : '<p>暂无证据记录。</p>'}
    </div>`;
  detail.showModal();
}

reportSelect.addEventListener('change', () => renderReport(reports.find(report => reportKey(report) === reportSelect.value)));
findingsTable.addEventListener('click', event => {
  const button = event.target.closest('[data-finding]');
  if (button) openFinding(activeReport.findings[Number(button.dataset.finding)]);
});
byId('metrics-import').addEventListener('click', () => byId('metrics-file').click());
byId('metrics-file').addEventListener('change', async event => {
  const field = event.currentTarget;
  const file = field.files[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('请选择小于 5 MB 的统计报告。');
    const imported = readReports(JSON.parse(await file.text()));
    if (!imported.length) throw new Error('该文件没有可显示的报告。');
    reports = mergeReports(reports, imported);
    let saved = true;
    try {
      const local = readReports(JSON.parse(localStorage.getItem(storageKey) ?? '{"version":1,"reports":[]}'));
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, reports: mergeReports(local, imported) }));
    } catch {
      saved = false;
    }
    selectReports(reportKey(imported[0]));
    notice(saved ? `已导入 ${imported.length} 份报告，保存在当前浏览器。` : '报告已打开，浏览器未能保存导入记录。', !saved);
  } catch (error) {
    notice(error instanceof SyntaxError ? '文件内容不是有效的 JSON。' : error.message, true);
  } finally {
    field.value = '';
  }
});

byId('metrics-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, reports: [activeReport] }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${activeReport.repository.split('/').at(-1)}-review-metrics.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function initialize() {
  let bundled = [];
  try {
    const response = await fetch('./review-metrics.json');
    if (!response.ok) throw new Error();
    bundled = readReports(await response.json());
  } catch {
    notice('站点报告未能加载，可从本地导入报告。', true);
  }
  try {
    const local = localStorage.getItem(storageKey);
    reports = mergeReports(bundled, local ? readReports(JSON.parse(local)) : []);
  } catch {
    reports = bundled;
    notice('浏览器保存的报告未能加载，可重新导入。', true);
  }
  const preferredRepo = new URLSearchParams(location.search).get('repo');
  selectReports(null, preferredRepo);
  byId('metrics-import').disabled = false;
}

initialize();
