const byId = id => document.getElementById(id);
const storageKey = 'cangjie-workbench:review-metrics:v1';
const findingsTable = byId('metrics-content');
const reportSelect = byId('report-select');
const detail = byId('metrics-detail');
const modeSelect = byId('metrics-mode');
const periodSelect = byId('metrics-period');
const repoSearch = byId('metrics-repo-search');
const repoOptions = byId('metrics-repo-options');
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
const dayFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'Asia/Shanghai' });
const shortDayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' });
const yearFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', timeZone: 'Asia/Shanghai' });
const formatCount = new Intl.NumberFormat('zh-CN');
const repoKey = value => value.toLowerCase();
const validPath = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const query = new URLSearchParams(location.search);
const linkedRepo = validPath(query.get('repo')) ? query.get('repo') : '';
const pageSize = 50;
let reports = [];
let enabledRepos = [];
let organizationKnown = false;
let activeReports = [];
let detailRows = [];
let tablePage = 0;
let activeSingleRepo = linkedRepo;
const customRepos = new Set();
let customInitialized = false;

function scopeMode() { return modeSelect.querySelector(':checked').value; }

function setScopeMode(mode) {
  modeSelect.querySelector(`[value="${mode}"]`).checked = true;
}

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

function normalizeScope(value, complete) {
  if (!['repository', 'selected_prs'].includes(value?.type) || !Array.isArray(value.prs) ||
    value.prs.some(pr => !isCount(pr) || pr < 1) || new Set(value.prs).size !== value.prs.length) {
    throw new Error('报告 PR 范围无效。');
  }
  const scope = { type: value.type, prs: value.prs };
  if (value.created_after !== undefined || value.created_before !== undefined) {
    if (value.type !== 'selected_prs' || !validDate(value.created_after) || !validDate(value.created_before) ||
      Date.parse(value.created_after) >= Date.parse(value.created_before) ||
      !isCount(value.collected_prs) || value.collected_prs > value.prs.length ||
      complete && value.collected_prs !== value.prs.length ||
      value.failed_prs !== undefined && (!Array.isArray(value.failed_prs) ||
        value.failed_prs.some(pr => !value.prs.includes(pr)) || new Set(value.failed_prs).size !== value.failed_prs.length ||
        value.failed_prs.length !== value.prs.length - value.collected_prs)) {
      throw new Error('报告时间范围或采集覆盖不一致。');
    }
    Object.assign(scope, {
      created_after: new Date(value.created_after).toISOString(),
      created_before: new Date(value.created_before).toISOString(),
      collected_prs: value.collected_prs,
    });
    if (value.failed_prs !== undefined) scope.failed_prs = value.failed_prs;
    if (isCount(value.bot_pr_count) && value.bot_pr_count <= value.collected_prs) scope.bot_pr_count = value.bot_pr_count;
  }
  return scope;
}

function normalizeCandidates(value, prs, count) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== count ||
    new Set(value.map(row => row?.id)).size !== count ||
    value.some(row => !row || !prs.has(row.pr) || !Object.hasOwn(states, row.state) ||
      typeof row.id !== 'string' || !row.id.startsWith(`${row.pr}:`) || !/^\d+:\d+$/.test(row.id))) {
    throw new Error('报告包含无效的 Diff 候选记录。');
  }
  return value.map(({ id, pr, state }) => ({ id, pr, state }));
}

function normalizeReport(value) {
  if (!validPath(value?.repository) || !validDate(value.observed_at) ||
    value.rule_version !== 'diff-only-resolved-v2' || typeof value.collection_complete !== 'boolean' ||
    counts.some(key => !isCount(value[key])) || !Array.isArray(value.findings)) {
    throw new Error('报告格式不正确。请使用工作台的统计导出命令生成 JSON。');
  }
  const scope = normalizeScope(value.scope, value.collection_complete);
  const prs = new Set(scope.prs);
  const candidates = normalizeCandidates(value.candidates, prs, value.unclassified_candidate_count);
  const ids = new Set();
  const findingStates = { resolved: 0, unresolved: 0, unknown: 0 };
  const resolvedVerdicts = { full: 0, partial: 0, not_adopted: 0, unknown: 0 };
  const findingCommentKeys = new Set();
  const findings = value.findings.map(finding => {
    if (typeof finding?.id !== 'string' || !finding.id || ids.has(finding.id) || !prs.has(finding.pr) ||
      !Object.hasOwn(states, finding.state) || !Object.hasOwn(decisions, finding.adoption) ||
      !Array.isArray(finding.comment_keys) || !finding.comment_keys.length ||
      finding.comment_keys.some(key => typeof key !== 'string' || !key.startsWith(`${finding.pr}:`)) ||
      !Array.isArray(finding.evidence) || finding.evidence.some(url => typeof url !== 'string')) {
      throw new Error('报告包含无效的意见或证据记录。');
    }
    ids.add(finding.id);
    finding.comment_keys.forEach(key => findingCommentKeys.add(key));
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
  if (findingCommentKeys.size + value.unclassified_candidate_count > value.diff_comment_count ||
    candidates?.some(candidate => findingCommentKeys.has(candidate.id)) ||
    value.finding_count !== findings.length || value.resolved !== findingStates.resolved ||
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
    scope,
    rule_version: value.rule_version,
    assessment_version: typeof value.assessment_version === 'string' ? value.assessment_version : null,
    collection_complete: value.collection_complete, classification_complete_for_scope: classificationComplete,
    publishable_for_collected_scope: canPublish,
    ...Object.fromEntries(counts.map(key => [key, value[key]])), ...expectedRates, findings,
    ...(candidates === undefined ? {} : { candidates }),
  };
}

function reportKey(report) {
  return JSON.stringify([report.repository.toLowerCase(), new Date(report.observed_at).toISOString(),
    report.scope.type, report.scope.created_after, report.scope.created_before,
    [...report.scope.prs].sort((a, b) => a - b), report.assessment_version]);
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
  if (finding.candidate) return ['待分类', ''];
  return finding.state === 'resolved' ? decisions[finding.adoption] : ['暂不计入', ''];
}

function adoptionEffect(finding) {
  if (finding.state !== 'resolved') return '不计入';
  if (finding.candidate) return '暂计分母';
  if (finding.adoption === 'full') return '分子和分母';
  return '仅计分母';
}

function renderTable(reset = true) {
  if (reset) tablePage = 0;
  const state = byId('finding-state').value;
  const adoption = byId('finding-adoption').value;
  const search = byId('finding-search').value.trim().replace(/^#/, '').toLowerCase();
  const filtered = detailRows.map((finding, index) => ({ finding, index })).filter(({ finding }) =>
    (!state || finding.state === state) &&
    (!adoption || (adoption === 'candidate' ? finding.candidate : !finding.candidate && finding.state === 'resolved' && finding.adoption === adoption)) &&
    (!search || [finding.repository, finding.pr, finding.id, finding.rationale, ...finding.comment_keys].join(' ').toLowerCase().includes(search)));
  const start = tablePage * pageSize;
  const end = Math.min(start + pageSize, filtered.length);
  byId('findings-rows').innerHTML = filtered.length
    ? filtered.slice(start, end).map(({ finding, index }) => `<tr>
      <td><a href="${prUrl(finding)}" target="_blank" rel="noopener noreferrer">#${finding.pr} ↗</a><small>${escape(finding.repository.split('/').at(-1))}</small></td>
      <td class="metrics-finding-title">${escape(finding.candidate ? `Diff 评论 ${finding.id.split(':')[1]}` : finding.rationale || finding.id)}</td>
      <td>${badge(states[finding.state])}</td><td>${badge(adoptionLabel(finding))}<small class="metrics-adoption-effect">${adoptionEffect(finding)}</small></td>
      <td class="row-end"><button class="row-open" data-finding="${index}" aria-label="查看 PR ${finding.pr} 的意见详情">↗</button></td>
    </tr>`).join('')
    : '<tr><td class="empty" colspan="5">没有符合条件的意见。</td></tr>';
  byId('findings-count').textContent = filtered.length ? `显示 ${start + 1}–${end} / ${filtered.length} 条记录` : '0 条结果';
  byId('findings-prev').disabled = tablePage === 0;
  byId('findings-next').disabled = end >= filtered.length;
}

function prUrl(finding) {
  return `https://gitcode.com/${finding.repository}/pull/${finding.pr}`;
}

function adoptionBasis(stats, rows) {
  const candidates = rows.flatMap(row => row.candidates ?? []);
  const resolvedCandidates = candidates.filter(row => row.state === 'resolved').length;
  const unresolvedCandidates = candidates.filter(row => row.state === 'unresolved').length;
  const missingCandidateStates = stats.unclassified_candidate_count - candidates.length;
  const mapped = rows.reduce((total, row) =>
    total + new Set(row.findings.flatMap(finding => finding.comment_keys)).size, 0);
  const denominator = stats.resolved + resolvedCandidates;
  return {
    numerator: stats.resolved_full, denominator,
    rate: denominator ? stats.resolved_full / denominator : 0,
    coverage: denominator ? (stats.resolved - stats.resolved_adoption_unknown) / denominator : null,
    resolvedCandidates, unresolvedCandidates, mapped, missingCandidateStates,
    unknownCandidates: candidates.length - resolvedCandidates - unresolvedCandidates,
    excludedDiff: stats.diff_comment_count - mapped - stats.unclassified_candidate_count,
  };
}

function adoptionStatus(report, basis) {
  if (!basis.denominator) return '暂无分母样本';
  return report.final_adoption_rate === null ? '暂计' : '判定完成';
}

function aggregate(selected, batch, scopeKnown) {
  const selectedKeys = new Set(selected.map(repoKey));
  const members = new Map(batch.reports.filter(report => selectedKeys.has(repoKey(report.repository)))
    .map(report => [repoKey(report.repository), report]));
  const rows = [...members.values()];
  const summed = Object.fromEntries(counts.map(key => [key, rows.reduce((total, row) => total + row[key], 0)]));
  const fullCoverage = scopeKnown && !!selected.length && rows.length === selected.length && rows.every(row => row.collection_complete);
  const classificationReady = fullCoverage && rows.every(row => row.classification_complete_for_scope);
  const adoptionReady = classificationReady && rows.every(row => row.publishable_for_collected_scope);
  const stats = {
    ...summed, collection_complete: fullCoverage, classification_complete_for_scope: classificationReady,
    publishable_for_collected_scope: adoptionReady,
    final_adoption_rate: summed.resolved && adoptionReady ? summed.resolved_full / summed.resolved : null,
  };
  return { stats, rows, members };
}

function coveragePanel(selected, members) {
  const complete = selected.filter(path => members.get(repoKey(path))?.collection_complete).length;
  const withData = members.size;
  const reports = [...members.values()];
  const expected = reports.reduce((sum, report) => sum + report.scope.prs.length, 0);
  const checked = reports.reduce((sum, report) => sum + (report.scope.collected_prs ?? (report.collection_complete ? report.scope.prs.length : 0)), 0);
  const missing = selected.length - withData;
  const incomplete = withData - complete;
  return `<section class="metrics-coverage" aria-labelledby="coverage-title">
    <h2 id="coverage-title">采集覆盖</h2>
    <div class="metrics-coverage-grid">
      <div><strong class="metrics-coverage-count">${complete} / ${selected.length}</strong><p>完成采集的仓库</p></div>
      <div><strong class="metrics-coverage-count">${formatCount.format(checked)} / ${formatCount.format(expected)}</strong><p>已读取评论的 PR${missing ? '（已有报告仓库）' : ''}</p></div>
    </div>
    <progress class="metrics-coverage-progress" max="${selected.length}" value="${complete}" aria-label="仓库采集覆盖"></progress>
    <p>${[missing && `${missing} 个仓库暂无报告`, incomplete && `${incomplete} 个仓库采集未完成`].filter(Boolean).join(' · ') ||
      '已读取本次统计范围内的全部 PR。'} </p>
  </section>`;
}

function repositoryTable(selected, members) {
  if (selected.length < 2) return '';
  const peak = Math.max(1, ...[...members.values()].map(report => report.diff_comment_count));
  const ordered = [...selected].sort((a, b) =>
    (members.get(repoKey(b))?.diff_comment_count ?? -1) - (members.get(repoKey(a))?.diff_comment_count ?? -1) || a.localeCompare(b));
  return `<section class="metrics-repo-results" aria-labelledby="repo-results-title">
    <div class="section-heading"><div><h2 id="repo-results-title">仓库明细</h2></div></div>
    <div class="table-card"><div class="table-scroll" tabindex="0" aria-label="仓库统计表格，可横向滚动">
      <table>
        <thead><tr><th scope="col">仓库</th><th scope="col">采集状态</th><th scope="col">已读取 PR</th><th scope="col">Bot Diff 评论</th><th scope="col">已解决候选</th><th scope="col">待分类</th><th scope="col">已确认采纳率</th></tr></thead>
        <tbody>${ordered.map(path => {
          const report = members.get(repoKey(path));
          const collected = report?.scope.collected_prs ?? (report?.collection_complete ? report.scope.prs.length : null);
          const basis = report ? adoptionBasis(report, [report]) : null;
          const rawResolved = report?.candidates ? basis.resolvedCandidates : null;
          const adoption = basis ? `<strong>${ratio(basis.rate)}</strong>
            <small class="metrics-adoption-effect">${basis.numerator} / ${basis.denominator} · ${adoptionStatus(report, basis)}</small>` : '暂无报告';
          const state = !report ? ['暂无报告', ''] : report.collection_complete ? ['已完成', 'on'] : ['部分覆盖', 'off'];
          return `<tr><th scope="row"><button type="button" class="metrics-repo-link" data-single-repo="${escape(path)}">${escape(path.split('/').at(-1))} ↗</button></th>
            <td>${badge(state)}</td><td>${collected === null ? '—' : collected}${report ? ` / ${report.scope.prs.length}` : ''}</td>
            <td>${report ? `<span class="metrics-volume"><meter min="0" max="${peak}" value="${report.diff_comment_count}" aria-hidden="true"></meter>${report.diff_comment_count}</span>` : '—'}</td>
            <td>${rawResolved ?? '—'}</td><td>${report?.unclassified_candidate_count ?? '—'}</td><td>${adoption}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div></div>
  </section>`;
}

function adoptionPanel(report, basis) {
  const excluded = [
    [report.discussion_comment_count, '讨论区评论，包括其中的摘要和说明'],
    [basis.excludedDiff, '已排除的 Diff 评论'],
    [report.unresolved, '未解决的独立意见'],
    [report.state_unknown, '解决状态未知的独立意见'],
    [basis.unresolvedCandidates, '未解决的 Diff 候选'],
    [basis.unknownCandidates, '解决状态未知的 Diff 候选'],
    [basis.missingCandidateStates, '缺少逐条解决状态的 Diff 候选'],
    [report.scope_pending_count, '类型待核实的 Bot 评论'],
  ];
  return `<section class="metrics-panel adoption-rules" aria-labelledby="adoption-rules-title">
    <h2 id="adoption-rules-title">采纳率怎么算</h2>
    <p>本批次读取 ${report.all_bot_comment_count} 条 Bot 评论，其中 ${report.diff_comment_count} 条是文件 Diff 评论，${report.discussion_comment_count} 条在讨论区${report.scope_pending_count ? `，${report.scope_pending_count} 条类型待核实` : ''}。</p>
    <dl class="adoption-formula">
      <div><dt>分子 <strong>${basis.numerator}</strong></dt><dd>有证据确认完全采纳的已解决独立 Diff 意见。仅标记已解决不构成采纳证据。</dd></div>
      <div><dt>分母 <strong>${basis.denominator}</strong></dt><dd>${report.resolved} 条已解决独立意见，加 ${basis.resolvedCandidates} 条暂计的已解决 Diff 候选。独立意见包括完全采纳 ${report.resolved_full}、部分采纳 ${report.resolved_partial}、未采纳 ${report.resolved_not_adopted}、采纳待判定 ${report.resolved_adoption_unknown}。</dd></div>
    </dl>
    <p>${basis.mapped} 条 Diff 评论已映射为 ${report.finding_count} 条独立意见。重复评论按独立意见计数，待分类候选暂按评论计数，分类后会重新计算。</p>
    <details${report.final_adoption_rate === null ? ' open' : ''}>
      <summary>不计入分子或分母</summary>
      <ul>${excluded.map(([count, label]) => `<li>${label} <strong>${count}</strong></li>`).join('')}</ul>
    </details>
  </section>`;
}

function renderReport(selected, batch, scopeKnown) {
  const { stats: report, rows, members } = aggregate(selected, batch, scopeKnown);
  activeReports = rows;
  byId('metrics-export').disabled = !rows.length;
  if (!selected.length) {
    const title = scopeMode() === 'custom' ? '请选择至少一个仓库' : '暂无统计报告';
    findingsTable.innerHTML = `<section class="metrics-panel empty"><h2>${title}</h2><p>也可导入本地统计工具导出的报告。</p></section>`;
    return;
  }
  const coverage = coveragePanel(selected, members);
  const repoTable = repositoryTable(selected, members);
  if (!rows.length) {
    const title = selected.length === 1 ? `${escape(selected[0])} 暂无统计报告` : '暂无统计报告';
    findingsTable.innerHTML = `${coverage}<section class="metrics-panel empty"><h2>${title}</h2><p>选择其他统计批次，或导入本地统计工具导出的报告。</p></section>${repoTable}`;
    return;
  }
  detailRows = rows.flatMap(row => [
    ...row.findings.map(finding => ({ ...finding, repository: row.repository })),
    ...(row.candidates ?? []).map(candidate => ({ ...candidate, repository: row.repository, candidate: true,
      comment_keys: [candidate.id], evidence: [], rationale: '' })),
  ]).sort((a, b) => a.repository.localeCompare(b.repository) || b.pr - a.pr || a.id.localeCompare(b.id));
  const candidateRows = detailRows.filter(item => item.candidate);
  const basis = adoptionBasis(report, rows);
  const newest = rows.reduce((latest, row) => Date.parse(row.observed_at) > Date.parse(latest) ? row.observed_at : latest, rows[0].observed_at);
  const decided = report.resolved - report.resolved_adoption_unknown;
  const final = report.final_adoption_rate !== null ? ratio(report.final_adoption_rate)
    : report.publishable_for_collected_scope ? '暂无数据' : '待判定';
  const hint = report.unclassified_candidate_count ? `${report.unclassified_candidate_count} 条 Diff 评论待分类`
    : `${report.unresolved} 条未解决${report.state_unknown ? ` · ${report.state_unknown} 条状态未知` : ''}`;
  const pending = [
    [!scopeKnown, '组织范围待核实，目前显示本批次已有报告的仓库'],
    [scopeKnown && !report.collection_complete, '所选范围有仓库或 PR 数据缺失'],
    [report.scope_pending_count, `${report.scope_pending_count} 条评论类型待核实`],
    [report.unclassified_candidate_count, `${report.unclassified_candidate_count} 条 Diff 评论待分类`],
    [report.state_unknown, `${report.state_unknown} 条意见的解决状态未知`],
    [report.resolved_adoption_unknown, `${report.resolved_adoption_unknown} 条已解决意见待判定采纳`],
  ].filter(([needed]) => needed).map(([, label]) => label);

  findingsTable.innerHTML = `
    <div class="metrics-summary"><span><strong>${selected.length === 1 ? escape(selected[0]) : `${selected.length} 个仓库`}</strong></span>
      <span>最近采集 ${dateLabel(newest)}（北京时间）</span></div>
    ${coverage}
    <div class="metrics">
      ${card('Bot Diff 评论', report.diff_comment_count, `${report.discussion_comment_count} 条讨论区评论另计`)}
      ${candidateRows.length
        ? card('已解决的 Diff 候选', basis.resolvedCandidates, `${basis.unresolvedCandidates} 条未解决，${report.finding_count} 条已分类为独立意见`)
        : card('已分类独立意见', report.finding_count, hint)}
      ${card('已确认采纳率', ratio(basis.rate), `${basis.numerator} / ${basis.denominator} · ${adoptionStatus(report, basis)}`, true)}
      ${card('采纳判定覆盖率', ratio(basis.coverage),
        basis.denominator ? `${decided} / ${basis.denominator} 个分母样本已判定` : '暂无分母样本')}
    </div>
    <div class="metrics-panels">
      ${adoptionPanel(report, basis)}
      <section class="metrics-panel">
        <h2>判定进度</h2>
        <p>最终采纳率 <strong>${final}</strong></p>
        ${basis.denominator ? '' : '<p>分母为 0 时，当前值按展示约定显示 0%。</p>'}
        ${pending.length ? `<ul class="metrics-pending">${pending.map(label => `<li>${label}</li>`).join('')}</ul>` : ''}
        ${basis.denominator ? `<progress class="metrics-progress" max="${basis.denominator}" value="${decided}" aria-label="采纳判定覆盖"></progress><small>${decided} / ${basis.denominator} 已判定</small>` : ''}
      </section>
    </div>
    ${repoTable}
    <section aria-labelledby="findings-title">
      <div class="section-heading"><div><h2 id="findings-title">检视意见与候选</h2><p>按仓库、PR、解决状态和采纳结论筛选，打开详情查看 GitCode 来源。</p></div></div>
      <div class="table-card">
        <div class="table-tools metrics-finding-tools">
          <label>解决状态 <select id="finding-state"><option value="">全部状态</option>${options(states)}</select></label>
          <label>采纳结论 <select id="finding-adoption"><option value="">全部结论</option>${options(decisions)}${candidateRows.length ? '<option value="candidate">待分类候选</option>' : ''}</select></label>
          <label class="search"><input id="finding-search" type="search" placeholder="搜索 PR 或意见…" aria-label="搜索 PR 或意见"></label>
        </div>
        <div class="table-scroll" tabindex="0" aria-label="检视意见表格，可横向滚动"><table>
          <thead><tr><th scope="col">PR / 仓库</th><th scope="col">意见或候选</th><th scope="col">解决状态</th><th scope="col">采纳结论</th><th scope="col" class="row-end">详情</th></tr></thead>
          <tbody id="findings-rows"></tbody>
        </table></div>
        <div class="table-foot metrics-pagination"><span id="findings-count" role="status"></span><div><button type="button" class="button" id="findings-prev">上一页</button><button type="button" class="button" id="findings-next">下一页</button></div></div>
      </div>
    </section>`;
  for (const id of ['finding-state', 'finding-adoption', 'finding-search']) byId(id).addEventListener('input', renderTable);
  byId('findings-prev').addEventListener('click', () => { tablePage--; renderTable(false); });
  byId('findings-next').addEventListener('click', () => { tablePage++; renderTable(false); });
  renderTable();
}

function options(values) {
  return Object.entries(values).map(([key, [label]]) => `<option value="${key}">${label}</option>`).join('');
}

function batchKey(report) {
  return report.scope.created_after
    ? JSON.stringify(['window', report.scope.created_after, report.scope.created_before])
    : reportKey(report);
}

function windowLabel(scope) {
  const start = new Date(scope.created_after);
  const end = new Date(Date.parse(scope.created_before) - 1);
  const endLabel = yearFormat.format(start) === yearFormat.format(end) ? shortDayFormat.format(end) : dayFormat.format(end);
  return `${dayFormat.format(start)} 至 ${endLabel}`;
}

function batches() {
  const groups = new Map();
  for (const report of reports) {
    const key = batchKey(report);
    if (!groups.has(key)) groups.set(key, new Map());
    const group = groups.get(key);
    const repo = repoKey(report.repository);
    if (!group.has(repo)) group.set(repo, report);
  }
  return [...groups].map(([id, group]) => {
    const list = [...group.values()];
    const first = list[0];
    const scope = first.scope;
    const label = scope.created_after
      ? windowLabel(scope)
      : `${first.repository.split('/').at(-1)} · ${scope.type === 'repository' ? '全仓快照' : '指定 PR'} · ${dateLabel(first.observed_at)}${first.assessment_version ? ` · ${first.assessment_version}` : ''}`;
    return { id, label, reports: list, window: !!scope.created_after };
  }).sort((a, b) => Number(b.window) - Number(a.window));
}

function renderPeriods(preferred) {
  const list = batches();
  periodSelect.replaceChildren(...list.map(batch => new Option(batch.label, batch.id)));
  if (!list.length) periodSelect.add(new Option('暂无统计批次', ''));
  if (list.some(batch => batch.id === preferred)) periodSelect.value = preferred;
  periodSelect.disabled = !list.length;
  renderScope();
}

function availableRepos(batch) {
  const unique = new Map([...enabledRepos, ...batch.reports.map(report => report.repository)]
    .map(path => [repoKey(path), path]));
  if (linkedRepo && !unique.has(repoKey(linkedRepo))) unique.set(repoKey(linkedRepo), linkedRepo);
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}

function currentBatch() {
  return batches().find(batch => batch.id === periodSelect.value) ?? { label: '', reports: [] };
}

function renderRepoPicker(batch, available, replaceOptions = true) {
  const listing = new Set(batch.reports.map(report => repoKey(report.repository)));
  if (replaceOptions) {
    const search = repoSearch.value.trim().toLowerCase();
    const choices = available.filter(path => repoKey(path).includes(search));
    repoOptions.innerHTML = choices.length ? choices.map(path => `<label>
      <input type="checkbox" value="${escape(path)}"${customRepos.has(repoKey(path)) ? ' checked' : ''}>
      <span>${escape(path.split('/').at(-1))}<small>${listing.has(repoKey(path)) ? '有报告' : '暂无报告'}</small></span>
    </label>`).join('') : '<p class="empty">没有匹配的仓库。</p>';
  }
  byId('metrics-repo-all').disabled = !available.length || available.every(path => customRepos.has(repoKey(path)));
  byId('metrics-repo-clear').disabled = !available.some(path => customRepos.has(repoKey(path)));
}

function renderScope(replaceOptions = true) {
  const batch = currentBatch();
  const available = availableRepos(batch);
  const existing = new Set(batch.reports.map(report => repoKey(report.repository)));
  const mode = scopeMode();
  byId('metrics-single-picker').hidden = mode !== 'single';
  byId('metrics-repo-picker').hidden = mode !== 'custom';
  let selected;
  if (mode === 'single') {
    if (!available.some(path => path === activeSingleRepo)) {
      activeSingleRepo = available.find(path => repoKey(path) === repoKey(activeSingleRepo)) ??
        batch.reports[0]?.repository ?? available[0] ?? '';
    }
    reportSelect.replaceChildren(...available.map(path => new Option(
      `${path}${existing.has(repoKey(path)) ? '' : ' · 暂无报告'}`, path)));
    if (!available.length) reportSelect.add(new Option('暂无可选仓库', ''));
    reportSelect.disabled = !available.length;
    reportSelect.value = activeSingleRepo;
    selected = activeSingleRepo ? [activeSingleRepo] : [];
  } else if (mode === 'custom') {
    if (!customInitialized) {
      batch.reports.forEach(report => customRepos.add(repoKey(report.repository)));
      customInitialized = true;
    }
    renderRepoPicker(batch, available, replaceOptions);
    selected = available.filter(path => customRepos.has(repoKey(path)));
  } else {
    selected = organizationKnown ? enabledRepos : available;
  }
  const visibleReports = selected.filter(path => existing.has(repoKey(path))).length;
  const scopeKnown = mode !== 'overview' || organizationKnown;
  byId('metrics-scope-summary').textContent = `已选 ${selected.length} 个仓库 · ${visibleReports} 个有报告${scopeKnown ? '' : ' · 组织清单待核实'}`;
  renderReport(selected, batch, scopeKnown);
}

function openFinding(finding) {
  detail.innerHTML = `<div class="dialog-heading"><div><p>${escape(finding.repository)}</p>
    <h2 id="metrics-detail-title">PR #${finding.pr} · ${finding.candidate ? 'Diff 候选' : '检视意见'}</h2></div>
    <form method="dialog"><button class="close-button" aria-label="关闭">×</button></form></div>
    <div class="dialog-body metrics-detail-body">
      <p>${badge(states[finding.state])} ${badge(adoptionLabel(finding))}</p>
      <p>采纳率计入方式 <strong>${adoptionEffect(finding)}</strong></p>
      <h3>判定理由</h3><p>${escape(finding.rationale || (finding.candidate ? '该评论待分类和去重。' : '暂无判定理由。'))}</p>
      <h3>评论编号</h3><p><code>${finding.comment_keys.map(escape).join('、')}</code></p>
      <p><a class="button button-primary" href="${prUrl(finding)}" target="_blank" rel="noopener noreferrer">在 GitCode 查看 PR ↗</a></p>
      <h3>证据链接</h3>
      ${finding.evidence.length ? `<ul>${finding.evidence.map((reference, index) => {
        const link = evidenceUrl(reference);
        return link ? `<li><a href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">证据 ${index + 1} · ${escape(link.hostname)} ↗</a></li>`
          : `<li class="metrics-reference">${escape(reference)}</li>`;
      }).join('')}</ul>` : '<p>暂无证据记录。</p>'}
    </div>`;
  detail.showModal();
}

reportSelect.addEventListener('change', () => { activeSingleRepo = reportSelect.value; renderScope(); });
modeSelect.addEventListener('change', () => renderScope());
periodSelect.addEventListener('change', () => renderScope());
repoSearch.addEventListener('input', () => {
  const batch = currentBatch();
  renderRepoPicker(batch, availableRepos(batch));
});
repoOptions.addEventListener('change', event => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  const key = repoKey(input.value);
  if (input.checked) customRepos.add(key);
  else customRepos.delete(key);
  renderScope(false);
});
byId('metrics-repo-all').addEventListener('click', () => {
  availableRepos(currentBatch()).forEach(path => customRepos.add(repoKey(path)));
  renderScope();
});
byId('metrics-repo-clear').addEventListener('click', () => { customRepos.clear(); renderScope(); });
findingsTable.addEventListener('click', event => {
  const button = event.target.closest('[data-finding]');
  if (button) openFinding(detailRows[Number(button.dataset.finding)]);
  const repoButton = event.target.closest('[data-single-repo]');
  if (repoButton) {
    activeSingleRepo = repoButton.dataset.singleRepo;
    setScopeMode('single');
    renderScope();
    reportSelect.focus();
  }
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
    if (imported.length === 1) {
      setScopeMode('single');
      activeSingleRepo = imported[0].repository;
    }
    renderPeriods(batchKey(imported[0]));
    notice(saved ? `已导入 ${imported.length} 份报告，保存在当前浏览器。` : '报告已打开，浏览器未能保存导入记录。', !saved);
  } catch (error) {
    notice(error instanceof SyntaxError ? '文件内容不是有效的 JSON。' : error.message, true);
  } finally {
    field.value = '';
  }
});

byId('metrics-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, reports: activeReports }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const name = activeReports.length === 1 ? activeReports[0].repository.split('/').at(-1) : 'cangjie';
  link.download = `${name}-review-metrics.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function initialize() {
  let bundled = [];
  const getJson = async path => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('读取失败');
    return response.json();
  };
  const [reportsResult, settingsResult, inventoryResult] = await Promise.allSettled([
    getJson('./review-metrics.json').then(readReports), getJson('./snapshot.json'), getJson('./inventory.json'),
  ]);
  if (reportsResult.status === 'fulfilled') bundled = reportsResult.value;
  else {
    notice('站点报告未能加载，可从本地导入报告。', true);
  }
  const settings = new Map();
  for (const value of [settingsResult.value, readLocalSettings()]) {
    if (value?.version !== 1 || value.organization !== 'Cangjie' || !Array.isArray(value.repositories)) continue;
    for (const row of value.repositories) {
      if (!validPath(row?.path) || typeof row.aiReview !== 'boolean') continue;
      const key = repoKey(row.path);
      const previous = settings.get(key);
      const time = validDate(row.checkedAt) ? Date.parse(row.checkedAt) : 0;
      if (!previous || time >= previous.time) settings.set(key, { ...row, time });
    }
  }
  const inventory = inventoryResult.value?.repositories;
  organizationKnown = Array.isArray(inventory) && inventory.length > 0 &&
    inventory.every(row => validPath(row?.path) && settings.has(repoKey(row.path)));
  if (organizationKnown) {
    enabledRepos = inventory.map(({ path }) => path).filter(path => settings.get(repoKey(path)).aiReview)
      .sort((a, b) => a.localeCompare(b));
  }
  try {
    const local = localStorage.getItem(storageKey);
    reports = mergeReports(bundled, local ? readReports(JSON.parse(local)) : []);
  } catch {
    reports = bundled;
    notice('浏览器保存的报告未能加载，可重新导入。', true);
  }
  if (linkedRepo) setScopeMode('single');
  renderPeriods();
  byId('metrics-import').disabled = false;
}

function readLocalSettings() {
  try { return JSON.parse(localStorage.getItem('cangjie-review-workbench:v1')); }
  catch { return null; }
}

initialize();
