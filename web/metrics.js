import { METRICS_TAG, RepoConfig, RepoTags } from './repo-config.js';

const byId = id => document.getElementById(id);
const storageKey = 'cangjie-workbench:review-metrics:v1';
const findingsTable = byId('metrics-content');
const reportSelect = byId('report-select');
const detail = byId('metrics-detail');
const modeSelect = byId('metrics-mode');
const periodSelect = byId('metrics-period');
const calendarGrain = byId('metrics-calendar-grain');
const calendarSelect = byId('metrics-calendar-period');
const calendarLabel = byId('metrics-calendar-label');
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
const percentFormat = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const dayFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'Asia/Shanghai' });
const shortDayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' });
const yearFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', timeZone: 'Asia/Shanghai' });
const shanghaiClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
});
const dayMs = 86_400_000;
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
let calendarOptions = new Map();
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

function creationDate(value) {
  const withOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
  return validDate(value) && withOffset.test(value) ? new Date(value).toISOString() : null;
}

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
    if (value.calendar_grain !== undefined) {
      if (!['week', 'month'].includes(value.calendar_grain)) throw new Error('报告时间分组无效。');
      scope.calendar_grain = value.calendar_grain;
    }
  }
  if (value.pr_created_at !== undefined) {
    if (!value.pr_created_at || typeof value.pr_created_at !== 'object' || Array.isArray(value.pr_created_at)) {
      throw new Error('报告 PR 创建日期无效。');
    }
    const prs = new Set(scope.prs.map(String));
    const entries = Object.entries(value.pr_created_at).map(([id, date]) => [id, creationDate(date)]);
    if (entries.some(([id, date]) => !prs.has(id) || !date)) throw new Error('报告 PR 创建日期无效。');
    scope.pr_created_at = Object.fromEntries(entries);
  }
  return scope;
}

function normalizeAdoptionComments(value, scope, count, strict) {
  if (value === undefined && !strict) return undefined;
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error('逐条 Diff 评论数与报告汇总不一致。');
  }
  const prs = new Set(scope.prs);
  const ids = new Set();
  const dates = new Map(Object.entries(scope.pr_created_at ?? {}).map(([pr, date]) => [Number(pr), date]));
  const comments = value.map(row => {
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
    const rowDate = creationDate(row.pr_created_at);
    const priorDate = dates.get(row.pr);
    if (rowDate && priorDate && rowDate !== priorDate) throw new Error('同一 PR 的创建日期不一致。');
    if (rowDate) dates.set(row.pr, rowDate);
    return {
      id: row.id, pr: row.pr, comment_type: 'diff_comment', state: row.state, pr_state: row.pr_state,
      adoption: row.adoption, rationale: row.rationale, evidence,
      ...(validDate(row.pr_state_observed_at) ? { pr_state_observed_at: row.pr_state_observed_at } : {}),
      ...(validDate(row.comment_observed_at) ? { comment_observed_at: row.comment_observed_at } : {}),
    };
  });
  return comments.map(comment => ({ ...comment, pr_created_at: dates.get(comment.pr) ?? null }));
}

function normalizeReport(value) {
  if (!validPath(value?.repository) || !validDate(value.observed_at) ||
    !['diff-only-resolved-v2', reportRule].includes(value.rule_version) ||
    typeof value.collection_complete !== 'boolean' || !isCount(value.diff_comment_count)) {
    throw new Error('报告格式不正确。请使用工作台的统计导出命令生成 JSON。');
  }
  const scope = normalizeScope(value.scope, value.collection_complete);
  const adoptionComments = normalizeAdoptionComments(value.adoption_comments, scope,
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
    report.scope.type, report.scope.created_after, report.scope.created_before, report.scope.calendar_grain,
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
    const previous = combined.get(key);
    if (!previous) combined.set(key, report);
    else if (report.adoption_comments || !previous.adoption_comments) {
      const dates = new Map([...datesByPr(previous), ...datesByPr(report)]);
      combined.set(key, {
        ...report,
        scope: { ...report.scope, pr_created_at: Object.fromEntries(dates) },
        ...(report.adoption_comments ? { adoption_comments: report.adoption_comments
          .map(comment => ({ ...comment, pr_created_at: dates.get(comment.pr) ?? null })) } : {}),
      });
    }
  }
  return [...combined.values()].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) ||
    a.repository.localeCompare(b.repository));
}

function datesByPr(report) {
  const dates = new Map(Object.entries(report.scope.pr_created_at ?? {}).map(([pr, date]) => [Number(pr), date]));
  for (const { pr, pr_created_at } of report.adoption_comments ?? []) {
    if (pr_created_at) dates.set(pr, pr_created_at);
  }
  return dates;
}

function shanghaiCivilTime(value) {
  const parts = Object.fromEntries(shanghaiClock.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function shanghaiDay(value) {
  return Math.floor(shanghaiCivilTime(value) / dayMs) * dayMs;
}

function shanghaiMidnight(day) {
  const approximate = day - 8 * 60 * 60 * 1000;
  return approximate + day - shanghaiCivilTime(approximate);
}

function calendarBucket(day, grain) {
  const date = new Date(day);
  if (grain === 'month') {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1), name: `${year}年${month + 1}月` };
  }
  const start = day - ((date.getUTCDay() + 6) % 7) * dayMs;
  const year = new Date(start + 3 * dayMs).getUTCFullYear();
  const january4 = new Date(Date.UTC(year, 0, 4));
  const first = january4.valueOf() - ((january4.getUTCDay() + 6) % 7) * dayMs;
  const number = 1 + Math.round((start - first) / (7 * dayMs));
  return { start, end: start + 7 * dayMs, name: `${year}年第 ${number} 周` };
}

function renderCalendar(batch) {
  const grain = calendarGrain.value;
  const previous = calendarSelect.value;
  calendarOptions = new Map();
  calendarSelect.hidden = calendarLabel.hidden = grain === 'all';
  if (grain === 'all') return;
  const scope = batch.reports[0]?.scope;
  const lower = scope?.created_after ? Date.parse(scope.created_after) : -Infinity;
  const upper = scope?.created_before ? Date.parse(scope.created_before) : Infinity;
  const add = bucket => {
    const start = shanghaiMidnight(bucket.start);
    const end = shanghaiMidnight(bucket.end);
    const from = Math.max(lower, start);
    const to = Math.min(upper, end);
    const key = String(bucket.start);
    if (calendarOptions.has(key) || from >= to) return;
    const partial = from !== start || to !== end;
    const label = grain === 'week' || partial
      ? `${bucket.name} · ${shortDayFormat.format(from)}至${shortDayFormat.format(to - 1)}`
      : bucket.name;
    calendarOptions.set(key, { grain, from, to, label });
  };
  if (Number.isFinite(lower) && Number.isFinite(upper)) {
    let day = shanghaiDay(lower);
    const last = shanghaiDay(upper - 1);
    while (day <= last) {
      const bucket = calendarBucket(day, grain);
      add(bucket);
      day = bucket.end;
    }
  } else {
    for (const report of batch.reports) {
      for (const date of datesByPr(report).values()) add(calendarBucket(shanghaiDay(date), grain));
    }
  }
  const ordered = [...calendarOptions].sort((a, b) => b[1].from - a[1].from);
  calendarSelect.replaceChildren(...ordered.map(([key, period]) => new Option(period.label, key)));
  if (calendarOptions.has(previous)) calendarSelect.value = previous;
  if (!ordered.length) calendarSelect.add(new Option('暂无可选时段', ''));
  calendarSelect.disabled = !ordered.length;
}

function clipReport(report, period) {
  const matches = value => {
    const time = value ? Date.parse(value) : NaN;
    return time >= period.from && time < period.to;
  };
  const source = datesByPr(report);
  const prs = report.scope.prs.filter(pr => matches(source.get(pr)));
  const comments = report.adoption_comments.filter(comment => matches(comment.pr_created_at));
  const failures = report.scope.failed_prs?.filter(pr => prs.includes(pr));
  const complete = source.size === report.scope.prs.length &&
    (report.collection_complete || !!failures && failures.length === 0);
  const collected = report.collection_complete ? prs.length : failures ? prs.length - failures.length
    : new Set(comments.map(comment => comment.pr)).size;
  return {
    ...report, collection_complete: complete, diff_comment_count: comments.length, adoption_comments: comments,
    scope: {
      type: 'selected_prs', prs, calendar_grain: period.grain,
      created_after: new Date(period.from).toISOString(), created_before: new Date(period.to).toISOString(),
      collected_prs: collected, ...(failures ? { failed_prs: failures } : {}),
      pr_created_at: Object.fromEntries(prs.map(pr => [pr, source.get(pr)])),
    },
  };
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

function repositoryTable(selected, members) {
  if (selected.length < 2) return '';
  return `<section class="metrics-repo-results" aria-labelledby="repo-results-title">
    <div class="section-heading"><h2 id="repo-results-title">仓库明细</h2></div>
    <div class="table-card"><div class="table-scroll" tabindex="0" aria-label="仓库统计表格，可横向滚动">
      <table><thead><tr><th scope="col">仓库</th><th scope="col">Bot Diff 评论</th>
        <th scope="col">采纳率分母</th><th scope="col">实际采纳率</th></tr></thead>
      <tbody>${selected.map(path => {
        const report = members.get(repoKey(path));
        const comments = report?.adoption_comments;
        const stats = comments ? countAdoption(comments) : null;
        const fraction = stats?.eligible ? ratio(stats.adopted / stats.eligible) : '0%';
        return `<tr><th scope="row"><button type="button" class="metrics-repo-link"
          data-single-repo="${escape(path)}">${escape(path.split('/').at(-1))} ↗</button></th>
          <td>${comments?.length ?? '—'}</td><td>${stats?.eligible ?? '—'}</td>
          <td>${stats ? `<strong>${fraction}</strong><small class="metrics-adoption-effect">${adoptionNote(stats)}</small>` : '—'}</td></tr>`;
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
  const fullReports = [...members.values()].filter(report => report.adoption_comments !== undefined);
  const timeFiltered = calendarGrain.value !== 'all';
  const calendar = timeFiltered ? calendarOptions.get(calendarSelect.value) : null;
  activeReports = calendar ? fullReports.map(report => clipReport(report, calendar)) : timeFiltered ? [] : fullReports;
  byId('metrics-export').disabled = !activeReports.length;
  if (!selected.length) {
    findingsTable.innerHTML = `<section class="metrics-panel empty"><h2>${emptyTitle}</h2>
      <p><a href="${escape(configLink.href)}">查看仓库配置中的统计标签</a></p></section>`;
    return;
  }
  if (!fullReports.length) {
    const title = members.size ? '旧版报告暂不能计算采纳率' : '本批次暂无统计报告';
    findingsTable.innerHTML = `<section class="metrics-panel empty"><h2>${title}</h2>
      <p>导入包含 PR 合入状态和逐条 Bot Diff 评论的报告。</p></section>`;
    return;
  }
  if (timeFiltered && !calendar) {
    findingsTable.innerHTML = '<section class="metrics-panel empty"><h2>本批次暂无可按时间筛选的数据</h2><p>需要带有 PR 创建日期的报告。</p></section>';
    return;
  }
  const repoTable = repositoryTable(selected, new Map(activeReports.map(report => [repoKey(report.repository), report])));
  detailRows = activeReports.flatMap(report => report.adoption_comments.map(comment => ({ ...comment, repository: report.repository })))
    .sort((a, b) => a.repository.localeCompare(b.repository) || b.pr - a.pr || a.id.localeCompare(b.id));
  const stats = countAdoption(detailRows);
  const rate = stats.eligible ? ratio(stats.adopted / stats.eligible) : '0%';
  const incomplete = fullReports.length !== selected.length || fullReports.some(report => !report.collection_complete);
  const unknownDates = calendar ? fullReports.reduce((count, report) =>
    count + report.adoption_comments.filter(comment => !comment.pr_created_at).length, 0) : 0;

  findingsTable.innerHTML = `
    <div class="metrics-summary">
      <span><strong>${selected.length === 1 ? escape(selected[0]) : `${selected.length} 个仓库`}</strong></span>
      ${calendar ? `<span>${calendar.label}</span>` : ''}${incomplete ? '<span>部分仓库的报告缺失或不完整</span>' : ''}
      ${unknownDates ? `<span>${unknownDates} 条评论缺少 PR 创建日期，未计入本期</span>` : ''}
    </div>
    <div class="metrics">
      ${card('Bot Diff 评论', detailRows.length, '按原始评论逐条计数')}
      ${card('采纳率分母', stats.eligible, '已合入 PR 中已解决的评论')}
      ${card('实际采纳率', rate, adoptionNote(stats), true)}
    </div>
    <div class="metrics-panels">
      <section class="metrics-panel adoption-rules" aria-labelledby="adoption-rules-title">
        <h2 id="adoption-rules-title">采纳率依据</h2>
        <dl class="adoption-formula">
          <div><dt>分母 <strong>${stats.eligible}</strong></dt><dd>已合入 PR 中已解决的 Bot Diff 评论。每条评论计一次。</dd></div>
          <div><dt>分子 <strong>${stats.adopted}</strong></dt><dd>分母中经开发者确认有效，或可从合入修改核实核心意见已落实的评论。</dd></div>
        </dl>
        <p>确认采纳 ${stats.adopted} · 明确未采纳 ${stats.not_adopted}${stats.pending ? ` · ${stats.pending} 条证据待核验` : ''}</p>
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
    ? JSON.stringify(['window', report.scope.created_after, report.scope.created_before, report.scope.calendar_grain])
    : reportKey(report);
}

function windowLabel(scope) {
  const start = new Date(scope.created_after);
  const end = new Date(Date.parse(scope.created_before) - 1);
  const endLabel = yearFormat.format(start) === yearFormat.format(end) ? shortDayFormat.format(end) : dayFormat.format(end);
  return `${dayFormat.format(start)} 至 ${endLabel}`;
}

function reportCalendarLabel(report) {
  const scope = report.scope;
  if (scope.created_after) {
    const name = scope.calendar_grain === 'week' ? '周筛选 · ' : scope.calendar_grain === 'month' ? '月筛选 · ' : '';
    return `${name}${windowLabel(scope)}`;
  }
  const dates = [...datesByPr(report).values()].sort();
  const name = `${report.repository.split('/').at(-1)} · ${scope.type === 'repository' ? '全仓快照' : '指定 PR'}`;
  if (!dates.length) return name;
  return `${name} · ${windowLabel({
    created_after: dates[0], created_before: new Date(Date.parse(dates.at(-1)) + 1).toISOString(),
  })}`;
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
    const label = reportCalendarLabel(first);
    const priority = scope.calendar_grain ? 0 : scope.created_after ? 2 : 1;
    return { id, label: list.some(report => report.adoption_comments) ? label : `${label} · 旧版`, reports: list, priority };
  }).sort((a, b) => b.priority - a.priority);
}

function renderPeriods(preferred = periodSelect.value) {
  const list = batches();
  periodSelect.replaceChildren(...list.map(batch => new Option(batch.label, batch.id)));
  if (!list.length) periodSelect.add(new Option('暂无统计批次', ''));
  if (list.some(batch => batch.id === preferred)) periodSelect.value = preferred;
  periodSelect.disabled = !list.length;
  renderCalendar(currentBatch());
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
        <span>${escape(path.split('/').at(-1))}${status ? `<small>${status}</small>` : ''}</span>
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
  byId('metrics-scope-summary').textContent =
    `范围内 ${available.length} 个仓库 · 已选 ${selected.length} 个`;
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
      ${comment.pr_created_at ? `<p>PR 创建于 ${dayFormat.format(new Date(comment.pr_created_at))}</p>` : ''}
    </div>`;
  detail.showModal();
}

reportSelect.addEventListener('change', () => { activeSingleRepo = reportSelect.value; renderScope(); });
modeSelect.addEventListener('change', () => renderScope());
const changeCalendar = () => {
  renderCalendar(currentBatch());
  renderScope();
};
periodSelect.addEventListener('change', changeCalendar);
calendarGrain.addEventListener('change', changeCalendar);
calendarSelect.addEventListener('change', () => renderScope());
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
