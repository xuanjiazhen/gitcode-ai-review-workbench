import { METRICS_TAG, RepoConfig, RepoTags, skillStatus, isVerified, hasEvidence } from './repo-config.js';
import { byId, dateLabel, dialogHeader, dismissOnBackdrop, escape, externalLink, icon, renderIcons, tagChips, updateTagScope } from './workbench-ui.js';

const detail = byId('detail-dialog');
const tagFilter = byId('tag-filter');
const search = byId('search');
const metricsTagKey = RepoTags.key(METRICS_TAG);
const view = {
  filter: 'all', records: [], tags: [],
  tag: new URLSearchParams(location.search).get('tag') ?? '',
};

renderIcons();

const filters = {
  all: ['全部仓库', () => true],
  ai: ['AI 已开启', row => row.aiReview === true],
  auto: ['自动检视已开启', row => row.autoReview === true],
  skills: ['Skill 已启用', row => skillStatus(row) === true],
  unknown: ['待核实', row => !isVerified(row)],
};

function pill(value, activeLabel = '已开启', offLabel = '已关闭') {
  const state = value === true ? 'on' : value === false ? 'off' : 'unknown';
  const label = value === true ? activeLabel : value === false ? offLabel : '待核实';
  return `<span class="pill ${state}">${label}</span>`;
}

function skillPill(row) {
  const count = row.skills?.filter(skill => skill.enabled === true).length ?? 0;
  return pill(skillStatus(row), `已启用 ${count} 项`, row.skills?.length ? '已停用' : '未配置');
}

function renderOverview(state) {
  const { inventory, lastChecked, records, tags, warnings } = state;
  view.records = [...records].sort((a, b) => Number(isVerified(b)) - Number(isVerified(a)) ||
    Number(hasEvidence(b)) - Number(hasEvidence(a)) || a.name.localeCompare(b.name));
  view.tags = tags;
  byId('data-date').textContent = lastChecked ? `最近采集 ${dateLabel(lastChecked)} · 北京时间` : `仓库清单 ${dateLabel(inventory.observedAt)} · 北京时间`;
  const warning = byId('config-warnings');
  warning.textContent = warnings.join(' ');
  warning.hidden = !warnings.length;
  renderTagScope();
  if (detail.open) {
    const path = new URLSearchParams(location.hash.slice(1)).get('repo');
    if (path) renderDetail(path);
  }
}

function scopedRecords() {
  return view.tag ? view.records.filter(row => row.tags.includes(view.tag)) : view.records;
}

function renderTagScope() {
  view.tag = updateTagScope(tagFilter, view.tags, view.tag);
  byId('tag-metrics').hidden = RepoTags.key(view.tag) !== metricsTagKey;

  const records = scopedRecords();
  const total = records.length;
  const complete = records.filter(isVerified).length;
  byId('coverage-number').innerHTML = `${complete} <span>/ ${total}</span>`;
  byId('coverage-grid').innerHTML = records.map((_, index) => `<i${index < complete ? ' class="verified"' : ''}></i>`).join('');
  byId('repo-total').textContent = total;
  const metrics = [
    ['all', '仓库总数', 'repo', `${total - complete} 个仓库待核实`],
    ['ai', 'AI 检视已开启', 'check', `${records.filter(row => row.aiReview === null).length} 个待核实`],
    ['auto', 'PR 自动检视已开启', 'bolt', `${records.filter(row => row.autoReview === null).length} 个待核实`],
    ['skills', '自定义 Skill 已启用', 'puzzle', `${records.filter(row => skillStatus(row) === null).length} 个待核实`],
  ];
  byId('metrics').innerHTML = metrics.map(([key, label, glyph, note]) => `
    <button type="button" class="metric" data-filter="${key}" aria-pressed="false">
      <span class="metric-top">${label}${icon(glyph)}</span>
      <strong>${records.filter(filters[key][1]).length}</strong><small>${note}</small>
    </button>`).join('');
  renderTable();
}

function renderTable() {
  const query = search.value.trim().toLowerCase();
  const records = scopedRecords();
  const rows = records.filter(row => filters[view.filter][1](row) &&
    (!query || `${row.path} ${row.language} ${row.description} ${row.skills?.map(skill => skill.name).join(' ') ?? ''} ${row.tags.join(' ')}`.toLowerCase().includes(query)));
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === view.filter));
  }
  byId('rows').innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td><div class="repo-name"><span class="repo-icon">${icon('repo')}</span><div class="repo-text">
        <a href="${escape(row.url)}" target="_blank" rel="noopener noreferrer">${escape(row.name)}</a>
        ${row.language ? `<small>${escape(row.language)}</small>` : ''}
        ${tagChips(row.tags)}
      </div></div></td>
      <td>${pill(row.aiReview)}</td><td>${pill(row.autoReview)}</td><td>${skillPill(row)}</td>
      <td class="row-end"><button class="row-open" type="button" data-repo="${escape(row.path)}" aria-label="查看 ${escape(row.name)} 的详情">${icon('arrow')}</button></td>
    </tr>`).join('') : '<tr><td class="empty" colspan="5">没有符合条件的仓库。</td></tr>';
  byId('result-count').textContent = `显示 ${rows.length} / ${records.length} 个仓库`;
}

function renderDetail(path) {
  const row = view.records.find(item => item.path.toLowerCase() === path.toLowerCase());
  if (!row) return;
  const skillCards = row.skills?.map(skill => `
    <article class="skill-card"><div class="skill-top"><strong>${escape(skill.name)}</strong>${pill(skill.enabled, '已启用', '已停用')}</div>
      ${skill.description ? `<p>${escape(skill.description)}</p>` : ''}
      ${skill.updatedAt ? `<p>更新于 ${escape(dateLabel(skill.updatedAt))}</p>` : ''}
      <div class="skill-links">${externalLink(skill.url, 'Skill 源文件')}${externalLink(skill.updateUrl || row.settingsUrl, '在 GitCode 更新')}</div>
    </article>`).join('');
  detail.innerHTML = `${dialogHeader('detail-title', row.name, row.path)}
    <div class="dialog-body">
      ${row.description ? `<p>${escape(row.description)}</p>` : ''}
      <div class="dialog-actions">${externalLink(row.settingsUrl, '打开 AI 检视设置', 'button button-primary')}${externalLink(row.url, '查看仓库', 'button')}
        ${row.tags.some(tag => RepoTags.key(tag) === metricsTagKey) ? `<a class="button" href="./metrics.html?repo=${encodeURIComponent(row.path)}">查看检视统计</a>` : ''}</div>
      <dl class="status-list">
        <div><dt>AI 检视</dt><dd>${pill(row.aiReview)}</dd></div>
        <div><dt>PR 创建自动检视</dt><dd>${pill(row.autoReview)}</dd></div>
        <div><dt>自定义 Skill</dt><dd>${skillPill(row)}</dd></div>
      </dl>
      ${row.checkedAt ? `<p class="checked-date">采集时间 ${escape(dateLabel(row.checkedAt))}</p>` : ''}
      ${row.note ? `<p>${escape(row.note)}</p>` : ''}
      <h3>外部 Skills${row.skills?.length ? ` (${row.skills.length})` : ''}</h3>
      ${skillCards || `<p>${row.skills === null ? '等待从 GitCode 设置页读取 Skill 列表。' : 'GitCode 设置页未配置外部 Skill。'}</p>`}
      ${row.skills?.length ? '<p class="checked-date">打开 GitCode 后，在「自定义 Skills」标签页找到对应的「更新」操作。</p>' : ''}
    </div>`;
  if (!detail.open) detail.showModal();
}

document.addEventListener('click', event => {
  const filter = event.target.closest('[data-filter]');
  if (filter) {
    view.filter = filter.dataset.filter;
    renderTable();
  }
  const chip = event.target.closest('[data-tag-scope]');
  if (chip) {
    view.tag = chip.dataset.tagScope;
    renderTagScope();
    tagFilter.focus();
  }
  const button = event.target.closest('[data-repo]');
  if (button) {
    const path = button.dataset.repo;
    history.replaceState(null, '', `#${new URLSearchParams({ repo: path })}`);
    renderDetail(path);
  }
});

tagFilter.addEventListener('change', () => {
  view.tag = tagFilter.value;
  renderTagScope();
});

dismissOnBackdrop(detail);
detail.addEventListener('close', () => {
  if (location.hash.startsWith('#repo=')) history.replaceState(null, '', location.pathname + location.search);
});

search.addEventListener('input', renderTable);
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey &&
      !detail.open && !event.target.closest('input,textarea,select,[contenteditable]')) {
    event.preventDefault();
    search.focus();
  }
});

async function initialize() {
  try {
    const state = await RepoConfig.load();
    byId('filters').innerHTML = Object.entries(filters).map(([key, [label]]) =>
      `<button type="button" class="filter" data-filter="${key}" aria-pressed="false">${label}</button>`).join('');
    renderOverview(state);
    RepoConfig.subscribe(renderOverview);
    const path = new URLSearchParams(location.hash.slice(1)).get('repo');
    if (path) renderDetail(path);
  } catch (error) {
    byId('data-date').textContent = '仓库配置加载失败，请刷新后重试。';
    byId('data-date').classList.add('error');
    console.error(error);
  }
}

initialize();
