import { METRICS_TAG, RepoConfig, RepoTags } from './repo-config.js';

const byId = id => document.getElementById(id);
const storageKey = 'cangjie-workbench:review-metrics:v1';
const findingsTable = byId('metrics-content');
const reportSelect = byId('report-select');
const detail = byId('metrics-detail');
const modeSelect = byId('metrics-mode');
const periodSelect = byId('metrics-period');
const configLink = byId('metrics-config-link');
const repoSearch = byId('metrics-repo-search');
const repoOptions = byId('metrics-repo-options');
const reportRule = 'merged-resolved-raw-diff-v1';
const states = { resolved: ['已解决', 'on'], unresolved: ['未解决', 'off'], unknown: ['状态未知', ''] };
const pullStates = { merged: ['已合入', 'on'], open: ['开放中', ''], unmerged: ['关闭未合入', 'off'], unknown: ['状态未知', ''] };
const assessments = { adopted: ['已采纳', 'on'], not_adopted: ['未采纳', 'off'], unknown: ['待核验', ''] };
const exclusions = {
  open: 'PR 开放中', unmerged: 'PR 关闭未合入', unknown: 'PR 或评论状态未知', unresolved: '已合入 PR 中未解决',
};
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
const scopeTagKey = RepoTags.key(METRICS_TAG);
const pageSize = 50;
let reports = [];
let scopedRepositories = new Map();
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
  if (validDate(value.pr_state_observed_at)) scope.pr_state_observed_at = value.pr_state_observed_at;
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

function normalizeAdoptionComments(value, prs, count, strict) {
  if (value === undefined && !strict) return undefined;
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error('逐条 Diff 评论数与报告汇总不一致。');
  }
  const ids = new Set();
  return value.map(row => {
    if (!row || !prs.has(row.pr) || typeof row.id !== 'string' || !/^\d+:\d+$/.test(row.id) ||
      !row.id.startsWith(`${row.pr}:`) || ids.has(row.id) ||
      row.comment_type !== 'diff_comment' ||
      !Object.hasOwn(states, row.state) || !Object.hasOwn(pullStates, row.pr_state) ||
      !Object.hasOwn(assessments, row.adoption) || typeof row.rationale !== 'string' ||
      !Array.isArray(row.evidence) || row.evidence.some(reference => typeof reference !== 'string')) {
      throw new Error('报告包含无效的 Diff 评论或采纳结论。');
    }
    ids.add(row.id);
    const evidence = [...new Set(row.evidence.map(evidenceReference).filter(Boolean))];
    if (row.adoption !== 'unknown' && (!eligible(row) || !row.rationale.trim() || !evidence.length)) {
      throw new Error('采纳判定须针对已合入且已解决的评论，并附理由和证据。');
    }
    return {
      id: row.id, pr: row.pr, comment_type: 'diff_comment', state: row.state, pr_state: row.pr_state,
      adoption: row.adoption, rationale: row.rationale, evidence,
      ...(validDate(row.pr_state_observed_at) ? { pr_state_observed_at: row.pr_state_observed_at } : {}),
      ...(validDate(row.comment_observed_at) ? { comment_observed_at: row.comment_observed_at } : {}),
    };
  });
}

function normalizeReport(value) {
  if (!validPath(value?.repository) || !validDate(value.observed_at) ||
    !['diff-only-resolved-v2', reportRule].includes(value.rule_version) ||
    typeof value.collection_complete !== 'boolean' || !isCount(value.diff_comment_count)) {
    throw new Error('报告格式不正确。请使用工作台的统计导出命令生成 JSON。');
  }
  const scope = normalizeScope(value.scope, value.collection_complete);
  const adoptionComments = normalizeAdoptionComments(value.adoption_comments, new Set(scope.prs),
    value.diff_comment_count, value.rule_version === reportRule);
  return {
    repository: value.repository, observed_at: value.observed_at, scope,
    rule_version: adoptionComments === undefined ? value.rule_version : reportRule,
    assessment_version: typeof value.assessment_version === 'string' ? value.assessment_version : null,
    collection_complete: value.collection_complete, diff_comment_count: value.diff_comment_count,
    ...(adoptionComments === undefined ? {} : { adoption_comments: adoptionComments }),
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
  for (const report of newer) {
    const key = reportKey(report);
    if (!combined.get(key)?.adoption_comments || report.adoption_comments) combined.set(key, report);
  }
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

function eligible(comment) {
  return comment.pr_state === 'merged' && comment.state === 'resolved';
}

function category(comment) {
  if (comment.pr_state !== 'merged') return comment.pr_state;
  return eligible(comment) ? 'eligible' : comment.state;
}

function adoptionEffect(comment) {
  if (!eligible(comment)) return '不计入分子或分母';
  return comment.adoption === 'adopted' ? '计入分子和分母' : '仅计入分母';
}

function renderTable(reset = true) {
  if (reset) tablePage = 0;
  const scope = byId('finding-state').value;
  const adoption = byId('finding-adoption').value;
  const search = byId('finding-search').value.trim().replace(/^#/, '').toLowerCase();
  const filtered = detailRows.map((comment, index) => ({ comment, index })).filter(({ comment }) =>
    (scope === 'excluded' ? !eligible(comment) : category(comment) === scope) &&
    (!adoption || (eligible(comment) && comment.adoption === adoption)) &&
    (!search || [comment.repository, comment.pr, comment.id, comment.rationale].join(' ').toLowerCase().includes(search)));
  const start = tablePage * pageSize;
  const end = Math.min(start + pageSize, filtered.length);
  byId('findings-rows').innerHTML = filtered.length
    ? filtered.slice(start, end).map(({ comment, index }) => `
      <tr>
        <td><a href="${prUrl(comment)}" target="_blank" rel="noopener noreferrer">#${comment.pr} ↗</a>
          <small>${escape(comment.repository.split('/').at(-1))}</small></td>
        <td class="metrics-finding-title">${escape(comment.id.split(':')[1])}<small>${escape(comment.rationale)}</small></td>
        <td>${badge(pullStates[comment.pr_state])}</td>
        <td>${badge(states[comment.state])}</td>
        <td>${eligible(comment) ? badge(assessments[comment.adoption]) : '—'}
          <small class="metrics-adoption-effect">${adoptionEffect(comment)}</small></td>
        <td class="row-end"><button type="button" class="row-open" data-finding="${index}"
          aria-label="查看 PR ${comment.pr} 的 Diff 评论 ${comment.id.split(':')[1]}">↗</button></td>
      </tr>`).join('')
    : '<tr><td class="empty" colspan="6">没有匹配的 Diff 评论。</td></tr>';
  byId('findings-count').textContent = filtered.length ? `显示 ${start + 1}–${end} / ${filtered.length} 条评论` : '0 条结果';
  byId('findings-prev').disabled = tablePage === 0;
  byId('findings-next').disabled = end >= filtered.length;
}

function prUrl(comment) {
  return `https://gitcode.com/${comment.repository}/pull/${comment.pr}`;
}

function countAdoption(comments) {
  const stats = { eligible: 0, adopted: 0, not_adopted: 0, pending: 0, open: 0, unmerged: 0, unknown: 0, unresolved: 0 };
  for (const comment of comments) {
    const group = category(comment);
    stats[group]++;
    if (group === 'eligible') stats[comment.adoption === 'unknown' ? 'pending' : comment.adoption]++;
  }
  return stats;
}

function coveragePanel(selected, members) {
  const reports = [...members.values()];
  const complete = reports.filter(report => report.collection_complete && report.adoption_comments !== undefined).length;
  const legacyCount = reports.filter(report => report.adoption_comments === undefined).length;
  const expected = reports.reduce((sum, report) => sum + report.scope.prs.length, 0);
  const checked = reports.reduce((sum, report) => sum + (report.scope.collected_prs ?? (report.collection_complete ? report.scope.prs.length : 0)), 0);
  const missing = selected.length - reports.length;
  const incomplete = reports.length - complete - legacyCount;
  return `<section class="metrics-coverage" aria-labelledby="coverage-title">
    <h2 id="coverage-title">采集覆盖</h2>
    <div class="metrics-coverage-grid">
      <div><strong class="metrics-coverage-count">${complete} / ${selected.length}</strong><p>已采集且有逐条 Diff 报告的仓库</p></div>
      <div><strong class="metrics-coverage-count">${formatCount.format(checked)} / ${formatCount.format(expected)}</strong>
        <p>已读取评论的 PR${missing ? '（已有报告仓库）' : ''}</p></div>
    </div>
    <progress class="metrics-coverage-progress" max="${selected.length}" value="${complete}" aria-label="仓库采集覆盖"></progress>
    <p>${[missing && `${missing} 个仓库暂无报告`, legacyCount && `${legacyCount} 个仓库的旧报告缺少逐条 Diff 数据`,
      incomplete && `${incomplete} 个仓库采集未完成`].filter(Boolean).join(' · ') || '已读取本批次范围内的全部 PR。'}</p>
  </section>`;
}

function repositoryTable(selected, members) {
  if (selected.length < 2) return '';
  return `<section class="metrics-repo-results" aria-labelledby="repo-results-title">
    <div class="section-heading"><h2 id="repo-results-title">仓库明细</h2></div>
    <div class="table-card"><div class="table-scroll" tabindex="0" aria-label="仓库统计表格，可横向滚动">
      <table><thead><tr><th scope="col">仓库</th><th scope="col">采集状态</th><th scope="col">Bot Diff 评论</th>
        <th scope="col">采纳率分母</th><th scope="col">实际采纳率</th><th scope="col">证据覆盖率</th></tr></thead>
      <tbody>${selected.map(path => {
        const report = members.get(repoKey(path));
        const comments = report?.adoption_comments;
        const state = !report ? ['暂无报告', ''] : !comments ? ['旧版报告', '']
          : report.collection_complete ? ['已完成', 'on'] : ['部分覆盖', 'off'];
        const stats = comments ? countAdoption(comments) : null;
        const fraction = stats?.eligible ? ratio(stats.adopted / stats.eligible) : '0%';
        const coverage = stats?.eligible ? ratio((stats.adopted + stats.not_adopted) / stats.eligible) : '—';
        return `<tr><th scope="row"><button type="button" class="metrics-repo-link"
          data-single-repo="${escape(path)}">${escape(path.split('/').at(-1))} ↗</button></th>
          <td>${badge(state)}</td><td>${comments?.length ?? '—'}</td><td>${stats?.eligible ?? '—'}</td>
          <td>${stats ? `<strong>${fraction}</strong><small class="metrics-adoption-effect">${adoptionNote(stats)}</small>` : '—'}</td>
          <td>${coverage}</td></tr>`;
      }).join('')}</tbody></table>
    </div></div>
  </section>`;
}

function adoptionNote(stats) {
  const fraction = `${stats.adopted} / ${stats.eligible}`;
  if (!stats.eligible) return `${fraction} · 暂无分母样本`;
  return stats.pending ? `${fraction} · ${stats.pending} 条待核验` : fraction;
}

function renderReport(selected, batch, emptyTitle) {
  const selectedKeys = new Set(selected.map(repoKey));
  const members = new Map(batch.reports.filter(report => selectedKeys.has(repoKey(report.repository)))
    .map(report => [repoKey(report.repository), report]));
  const currentReports = [...members.values()].filter(report => report.adoption_comments !== undefined);
  activeReports = currentReports;
  byId('metrics-export').disabled = !activeReports.length;
  if (!selected.length) {
    findingsTable.innerHTML = `<section class="metrics-panel empty"><h2>${emptyTitle}</h2>
      <p><a href="${escape(configLink.href)}">查看仓库配置中的统计标签</a></p></section>`;
    return;
  }
  const coverage = coveragePanel(selected, members);
  const repoTable = repositoryTable(selected, members);
  if (!currentReports.length) {
    const title = members.size ? '旧版报告暂不能计算采纳率' : '本批次暂无统计报告';
    findingsTable.innerHTML = `${coverage}<section class="metrics-panel empty"><h2>${title}</h2>
      <p>导入包含 PR 合入状态和逐条 Bot Diff 评论的报告。</p></section>${repoTable}`;
    return;
  }
  detailRows = currentReports.flatMap(report => report.adoption_comments.map(comment => ({ ...comment, repository: report.repository })))
    .sort((a, b) => a.repository.localeCompare(b.repository) || b.pr - a.pr || a.id.localeCompare(b.id));
  const stats = countAdoption(detailRows);
  const newest = currentReports.reduce((date, report) => Date.parse(report.observed_at) > Date.parse(date) ? report.observed_at : date, currentReports[0].observed_at);
  const mergeChecked = currentReports.map(report => report.scope.pr_state_observed_at)
    .filter(validDate).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const assessed = stats.adopted + stats.not_adopted;
  const rate = stats.eligible ? ratio(stats.adopted / stats.eligible) : '0%';
  const proof = stats.eligible ? ratio(assessed / stats.eligible) : '—';
  const incomplete = currentReports.length !== selected.length || currentReports.some(report => !report.collection_complete);

  findingsTable.innerHTML = `
    <div class="metrics-summary">
      <span><strong>${selected.length === 1 ? escape(selected[0]) : `${selected.length} 个仓库`}</strong></span>
      <span>评论采集 ${dateLabel(newest)}（北京时间）</span>${mergeChecked && mergeChecked !== newest ? `<span>合入状态核实 ${dateLabel(mergeChecked)}（北京时间）</span>` : ''}${incomplete ? '<span>仅汇总已采集的逐条记录</span>' : ''}
    </div>
    ${coverage}
    <div class="metrics">
      ${card('Bot Diff 评论', detailRows.length, '按原始评论逐条计数')}
      ${card('采纳率分母', stats.eligible, '已合入 PR 中已解决的评论')}
      ${card('实际采纳率', rate, adoptionNote(stats), true)}
      ${card('证据覆盖率', proof, `${assessed} / ${stats.eligible} 条分母评论已核验`)}
    </div>
    <div class="metrics-panels">
      <section class="metrics-panel adoption-rules" aria-labelledby="adoption-rules-title">
        <h2 id="adoption-rules-title">采纳率依据</h2>
        <dl class="adoption-formula">
          <div><dt>分母 <strong>${stats.eligible}</strong></dt><dd>已合入 PR 中已解决的 Bot Diff 评论。每条评论计一次。</dd></div>
          <div><dt>分子 <strong>${stats.adopted}</strong></dt><dd>分母中经开发者确认有效，或可从合入修改核实核心意见已落实的评论。</dd></div>
        </dl>
        <p>确认采纳 ${stats.adopted} · 明确未采纳 ${stats.not_adopted} · 证据待核验 ${stats.pending}</p>
        ${stats.eligible ? `<progress class="metrics-progress" max="${stats.eligible}" value="${assessed}" aria-label="证据核验覆盖"></progress>` : ''}
      </section>
      <section class="metrics-panel" aria-labelledby="excluded-comments-title">
        <h2 id="excluded-comments-title">分母之外的 Diff 评论</h2>
        <dl class="status-list">${Object.entries(exclusions).map(([key, label]) =>
          `<div><dt>${label}</dt><dd>${stats[key]}</dd></div>`).join('')}</dl>
      </section>
    </div>
    ${repoTable}
    <section aria-labelledby="findings-title">
      <div class="section-heading"><div><h2 id="findings-title">Bot Diff 评论明细</h2><p>查看每条评论的 PR 状态、解决状态和采纳依据。</p></div></div>
      <div class="table-card">
        <div class="table-tools metrics-finding-tools">
          <label>统计归类 <select id="finding-state"><option value="eligible">计入采纳率</option><option value="excluded">其余 Diff 评论</option>${Object.entries(exclusions)
            .map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
          <label>采纳结论 <select id="finding-adoption"><option value="">全部</option>${Object.entries(assessments)
            .map(([key, [label]]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
          <label class="search"><input id="finding-search" type="search" placeholder="搜索仓库、PR 或评论…" aria-label="搜索仓库、PR 或评论"></label>
        </div>
        <div class="table-scroll" tabindex="0" aria-label="Bot Diff 评论表格，可横向滚动"><table>
          <thead><tr><th scope="col">PR / 仓库</th><th scope="col">评论编号</th><th scope="col">PR 状态</th><th scope="col">评论状态</th>
            <th scope="col">采纳结论</th><th scope="col" class="row-end">详情</th></tr></thead>
          <tbody id="findings-rows"></tbody>
        </table></div>
        <div class="table-foot metrics-pagination"><span id="findings-count" role="status"></span><div><button type="button" class="button" id="findings-prev">上一页</button><button type="button" class="button" id="findings-next">下一页</button></div></div>
      </div>
    </section>`;
  for (const id of ['finding-state', 'finding-adoption', 'finding-search']) byId(id).addEventListener('input', renderTable);
  if (!stats.eligible && detailRows.length) byId('finding-state').value = 'excluded';
  byId('findings-prev').addEventListener('click', () => { tablePage--; renderTable(false); });
  byId('findings-next').addEventListener('click', () => { tablePage++; renderTable(false); });
  renderTable();
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
    const repo = repoKey(report.repository);
    if (!scopedRepositories.has(repo)) continue;
    const key = batchKey(report);
    if (!groups.has(key)) groups.set(key, new Map());
    const group = groups.get(key);
    const previous = group.get(repo);
    if (!previous || (!previous.adoption_comments && report.adoption_comments)) group.set(repo, report);
  }
  return [...groups].map(([id, group]) => {
    const list = [...group.values()];
    const first = list[0];
    const scope = first.scope;
    const label = scope.created_after
      ? windowLabel(scope)
      : `${first.repository.split('/').at(-1)} · ${scope.type === 'repository' ? '全仓快照' : '指定 PR'} · ${dateLabel(first.observed_at)}${first.assessment_version ? ` · ${first.assessment_version}` : ''}`;
    return { id, label: list.some(report => report.adoption_comments) ? label : `${label} · 旧版`, reports: list, window: !!scope.created_after };
  }).sort((a, b) => Number(b.window) - Number(a.window));
}

function renderPeriods(preferred = periodSelect.value) {
  const list = batches();
  periodSelect.replaceChildren(...list.map(batch => new Option(batch.label, batch.id)));
  if (!list.length) periodSelect.add(new Option('暂无统计批次', ''));
  if (list.some(batch => batch.id === preferred)) periodSelect.value = preferred;
  periodSelect.disabled = !list.length;
  renderScope();
}

function availableRepos() {
  return [...scopedRepositories.values()].map(row => row.path).sort((a, b) => a.localeCompare(b));
}

function currentBatch() {
  return batches().find(batch => batch.id === periodSelect.value) ?? { label: '', reports: [] };
}

function repoAvailability(path, withReport) {
  const current = scopedRepositories.get(repoKey(path))?.aiReview === false ? '当前已关闭 AI 检视' : '';
  return [withReport ? '' : '暂无报告', current].filter(Boolean).join(' · ');
}

function renderRepoPicker(batch, available, replaceOptions = true) {
  const listing = new Set(batch.reports.map(report => repoKey(report.repository)));
  if (replaceOptions) {
    const search = repoSearch.value.trim().toLowerCase();
    const choices = available.filter(path => repoKey(path).includes(search));
    repoOptions.innerHTML = choices.length ? choices.map(path => {
      const status = repoAvailability(path, listing.has(repoKey(path)));
      return `<label>
        <input type="checkbox" value="${escape(path)}"${customRepos.has(repoKey(path)) ? ' checked' : ''}>
        <span>${escape(path.split('/').at(-1))}<small>${status || '有报告'}</small></span>
      </label>`;
    }).join('') : '<p class="empty">没有匹配的仓库。</p>';
  }
  byId('metrics-repo-all').disabled = !available.length || available.every(path => customRepos.has(repoKey(path)));
  byId('metrics-repo-clear').disabled = !available.some(path => customRepos.has(repoKey(path)));
}

function renderScope(replaceOptions = true) {
  const batch = currentBatch();
  const available = availableRepos();
  const existing = new Set(batch.reports.map(report => repoKey(report.repository)));
  const mode = scopeMode();
  byId('metrics-single-picker').hidden = mode !== 'single';
  byId('metrics-repo-picker').hidden = mode !== 'custom';
  let selected;
  let emptyTitle = '当前标签下没有可统计的仓库';
  if (mode === 'single') {
    const requested = available.find(path => repoKey(path) === repoKey(activeSingleRepo));
    const outOfScope = activeSingleRepo && !requested;
    const singleRepo = outOfScope ? '' : requested ?? available.find(path => existing.has(repoKey(path))) ?? available[0] ?? '';
    reportSelect.replaceChildren(...available.map(path => {
      const status = repoAvailability(path, existing.has(repoKey(path)));
      return new Option(status ? `${path} · ${status}` : path, path);
    }));
    if (outOfScope) {
      reportSelect.add(new Option('请选择统计范围内的仓库', ''), 0);
      emptyTitle = '该仓库不在当前统计范围';
    } else if (!available.length) {
      reportSelect.add(new Option('暂无可选仓库', ''));
    }
    reportSelect.disabled = !available.length;
    reportSelect.value = singleRepo;
    selected = singleRepo ? [singleRepo] : [];
  } else if (mode === 'custom') {
    if (!customInitialized && available.length) {
      batch.reports.forEach(report => customRepos.add(repoKey(report.repository)));
      customInitialized = true;
    }
    renderRepoPicker(batch, available, replaceOptions);
    selected = available.filter(path => customRepos.has(repoKey(path)));
    if (available.length) emptyTitle = '请选择至少一个仓库';
  } else {
    selected = available;
  }
  const visibleReports = selected.filter(path => existing.has(repoKey(path))).length;
  byId('metrics-scope-summary').textContent =
    `范围内 ${available.length} 个仓库 · 已选 ${selected.length} 个 · ${visibleReports} 个有报告`;
  renderReport(selected, batch, emptyTitle);
}

function openFinding(comment) {
  detail.innerHTML = `<div class="dialog-heading"><div><p>${escape(comment.repository)}</p>
    <h2 id="metrics-detail-title">PR #${comment.pr} · Diff 评论</h2></div>
    <form method="dialog"><button class="close-button" aria-label="关闭">×</button></form></div>
    <div class="dialog-body metrics-detail-body">
      <p>${badge(pullStates[comment.pr_state])} ${badge(states[comment.state])}
        ${eligible(comment) ? badge(assessments[comment.adoption]) : ''}</p>
      <p>采纳率计入方式 <strong>${adoptionEffect(comment)}</strong></p>
      <h3>评论编号</h3><p><code>${escape(comment.id)}</code></p>
      <p><a class="button button-primary" href="${prUrl(comment)}" target="_blank" rel="noopener noreferrer">在 GitCode 查看 PR ↗</a></p>
      <h3>判定理由</h3><p>${escape(comment.rationale || (eligible(comment) ? '目前缺少采纳结论的证据。' : '该评论未达到计入分母的条件。'))}</p>
      <h3>采纳证据</h3>
      ${comment.evidence.length ? `<ul>${comment.evidence.map((reference, index) => {
        const link = evidenceUrl(reference);
        return link ? `<li><a href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">证据 ${index + 1} · ${escape(link.hostname)} ↗</a></li>`
          : `<li class="metrics-reference">${escape(reference)}</li>`;
      }).join('')}</ul>` : '<p>暂无证据记录。</p>'}
      ${comment.pr_state_observed_at ? `<p>PR 状态观测于 ${dateLabel(comment.pr_state_observed_at)}</p>` : ''}
      ${comment.comment_observed_at ? `<p>评论状态观测于 ${dateLabel(comment.comment_observed_at)}</p>` : ''}
    </div>`;
  detail.showModal();
}

reportSelect.addEventListener('change', () => { activeSingleRepo = reportSelect.value; renderScope(); });
modeSelect.addEventListener('change', () => renderScope());
periodSelect.addEventListener('change', () => renderScope());
repoSearch.addEventListener('input', () => {
  const batch = currentBatch();
  renderRepoPicker(batch, availableRepos());
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
  availableRepos().forEach(path => customRepos.add(repoKey(path)));
  renderScope();
});
byId('metrics-repo-clear').addEventListener('click', () => {
  customRepos.clear();
  renderScope();
});
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
    const parsed = readReports(JSON.parse(await file.text()));
    const imported = parsed.filter(report => scopedRepositories.has(repoKey(report.repository)));
    if (!imported.length) throw new Error(`该文件没有「${METRICS_TAG}」范围内的仓库报告。`);
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
    const skipped = parsed.length - imported.length;
    notice(saved ? `已导入 ${imported.length} 份报告${skipped ? `，另有 ${skipped} 份在标签范围之外` : ''}。`
      : '报告已打开，浏览器未能保存导入记录。', !saved);
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
  configLink.href = `./repositories.html?${new URLSearchParams({ tag: METRICS_TAG })}`;
  let bundled = [];
  const loadReports = async () => {
    const response = await fetch('./review-metrics.json');
    if (!response.ok) throw new Error('读取失败');
    return readReports(await response.json());
  };
  const [reportsResult, configResult] = await Promise.allSettled([loadReports(), RepoConfig.load()]);
  if (reportsResult.status === 'fulfilled') bundled = reportsResult.value;
  else {
    notice('站点报告未能加载，可从本地导入报告。', true);
  }
  if (configResult.status === 'fulfilled') updateConfiguration(configResult.value);
  try {
    const local = localStorage.getItem(storageKey);
    reports = mergeReports(bundled, local ? readReports(JSON.parse(local)) : []);
  } catch {
    reports = bundled;
    notice('浏览器保存的报告未能加载，可重新导入。', true);
  }
  if (linkedRepo) setScopeMode('single');
  renderPeriods();
  RepoConfig.subscribe(config => {
    updateConfiguration(config);
    renderPeriods();
  });
  byId('metrics-import').disabled = false;
}

function updateConfiguration(config) {
  scopedRepositories = new Map(config.records.filter(row => row.tags.some(tag => RepoTags.key(tag) === scopeTagKey))
    .map(row => [repoKey(row.path), row]));
}

initialize();
