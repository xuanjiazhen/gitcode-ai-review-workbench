import { bookmarkletHref } from './collector.js';
import { RepoTags } from './repo-tags.js';

const icons = {
  chart: '<path d="M4 4v16h16M8 16v-4m5 4V8m5 8V5"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-2-15-4 18"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  sync: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
  external: '<path d="M13 5h6v6m0-6-9 9m7-1v6H5V7h6"/>',
  scan: '<path d="M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5M4 12h16"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
  repo: '<path d="M6 3h13v17H7a2 2 0 0 1-2-2V5c0-1.1.5-2 1-2Zm-1 14a2 2 0 0 1 2-2h12M9 7h6m-6 4h4"/>',
  check: '<path d="M5 12l4 4L19 6"/><path d="M19 12v7H5V5h10"/>',
  bolt: '<path d="M13 2 5 13h6l-1 9 9-12h-6l1-8Z"/>',
  puzzle: '<path d="M4 4h6a2.5 2.5 0 1 1 4 0h6v6a2.5 2.5 0 1 0 0 4v6h-6a2.5 2.5 0 1 1-4 0H4v-6a2.5 2.5 0 1 0 0-4Z"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};

const byId = id => document.getElementById(id);
const detail = byId('detail-dialog');
const sync = byId('sync-dialog');
const tagDialog = byId('tag-dialog');
const tagFilter = byId('tag-filter');
const tagSelectAll = byId('tag-select-all');
const search = byId('search');
const fileInput = byId('file-input');
const storageKey = 'cangjie-review-workbench:v1';
const site = 'https://gitcode.com';
const settingsSuffix = '/setting/apps/atomcode_ai_review';
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
});
const view = {
  filter: 'all', records: [], local: [], visible: [], selected: new Set(),
  tag: new URLSearchParams(location.search).get('tag') ?? '',
};
let inventory;
let seed;
let toastTimer;

function icon(name) {
  return `<span data-icon="${name}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg></span>`;
}

for (const element of document.querySelectorAll('[data-icon]')) {
  element.replaceWith(document.createRange().createContextualFragment(icon(element.dataset.icon)));
}

function escape(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href;
  } catch { /* An absent or invalid URL cannot be opened. */ }
  return '';
}

function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : dateFormat.format(date);
}

function pathKey(path) { return path.toLowerCase(); }

function recordFrom(row) {
  if (!row || typeof row.path !== 'string') return null;
  const parts = row.path.split('/');
  if (parts.length < 2 || pathKey(parts[0]) !== 'cangjie' ||
      parts.some(part => !part || part === '.' || part === '..' || /[\\?#\s]/.test(part))) return null;
  parts[0] = 'Cangjie';
  const path = parts.join('/');
  const url = `${site}/${parts.map(encodeURIComponent).join('/')}`;
  const flag = value => typeof value === 'boolean' ? value : null;
  const skills = Array.isArray(row.skills) ? row.skills.map(skill => {
    if (!skill || typeof skill.name !== 'string' || !skill.name.trim()) {
      throw new Error('Skill 名称缺失。');
    }
    return {
      name: skill.name.trim(), url: safeUrl(skill.url), enabled: flag(skill.enabled),
      description: typeof skill.description === 'string' ? skill.description : '',
      updatedAt: dateLabel(skill.updatedAt) ? skill.updatedAt : null,
      updateUrl: safeUrl(skill.updateUrl),
    };
  }) : null;
  return {
    path, name: path.split('/').at(-1), url, settingsUrl: `${url}${settingsSuffix}`,
    description: typeof row.description === 'string' ? row.description : '',
    language: typeof row.language === 'string' ? row.language : '',
    aiReview: flag(row.aiReview), autoReview: flag(row.autoReview), skills,
    checkedAt: dateLabel(row.checkedAt) ? row.checkedAt : null,
    note: typeof row.note === 'string' ? row.note : '',
  };
}

function parseSnapshot(value) {
  if (value?.version !== 1 || typeof value.organization !== 'string' ||
      pathKey(value.organization) !== 'cangjie' || !Array.isArray(value.repositories)) {
    throw new Error('请选择 Cangjie 工作台的 JSON 快照。');
  }
  const rows = value.repositories.map(recordFrom);
  if (rows.some(row => !row)) throw new Error('快照包含无法识别的仓库路径。');
  if (new Set(rows.map(row => pathKey(row.path))).size !== rows.length) throw new Error('快照包含重复仓库。');
  return rows;
}

function skillStatus(record) {
  if (record.skills === null) return null;
  if (record.skills.some(skill => skill.enabled === true)) return true;
  return record.skills.some(skill => skill.enabled === null) ? null : false;
}

function isVerified(record) {
  return record.aiReview !== null && record.autoReview !== null && record.skills !== null &&
    record.skills.every(skill => skill.enabled !== null);
}

function hasEvidence(record) {
  return record.aiReview !== null || record.autoReview !== null || record.skills !== null;
}

function mergeRows(base, updates) {
  const merged = new Map(base.map(row => [pathKey(row.path), row]));
  for (const row of updates) {
    const key = pathKey(row.path);
    const old = merged.get(key);
    if (!old) {
      merged.set(key, row);
    } else {
      const newer = !old.checkedAt || (row.checkedAt && new Date(row.checkedAt) >= new Date(old.checkedAt));
      const current = newer ? row : old;
      merged.set(key, {
        ...current, description: current.description || old.description, language: current.language || old.language,
      });
    }
  }
  return [...merged.values()];
}

function snapshot(rows) {
  return { version: 1, organization: 'Cangjie', exportedAt: new Date().toISOString(), repositories: rows };
}

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

function notify(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function renderOverview() {
  view.records = mergeRows(mergeRows(inventory.repositories.map(recordFrom), seed), view.local);
  view.records.sort((a, b) => Number(isVerified(b)) - Number(isVerified(a)) || Number(hasEvidence(b)) - Number(hasEvidence(a)) || a.name.localeCompare(b.name));
  const lastChecked = view.records.map(row => row.checkedAt).filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0];
  byId('data-date').textContent = lastChecked ? `最近采集 ${dateLabel(lastChecked)} · 北京时间` : `仓库清单 ${dateLabel(inventory.observedAt)} · 北京时间`;
  renderTagScope();
}

function scopedRecords() {
  return view.tag ? view.records.filter(row => RepoTags.has(row.path, view.tag)) : view.records;
}

function renderTagScope() {
  const tags = RepoTags.list();
  view.tag = tags.find(tag => RepoTags.key(tag) === RepoTags.key(view.tag)) ?? '';
  tagFilter.innerHTML = `<option value="">全部标签</option>${tags.map(tag => `<option>${escape(tag)}</option>`).join('')}`;
  tagFilter.value = view.tag;
  const statsLink = byId('tag-metrics');
  statsLink.hidden = !view.tag;
  statsLink.href = view.tag ? `./metrics.html?${new URLSearchParams({ tag: view.tag })}` : './metrics.html';
  const url = new URL(location.href);
  if (view.tag) url.searchParams.set('tag', view.tag);
  else url.searchParams.delete('tag');
  if (url.href !== location.href) history.replaceState(null, '', url);

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
    (!query || `${row.path} ${row.language} ${row.description} ${row.skills?.map(skill => skill.name).join(' ') ?? ''} ${RepoTags.forRepo(row.path).join(' ')}`.toLowerCase().includes(query)));
  view.visible = rows;
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === view.filter));
  }
  byId('rows').innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td class="repo-select"><input type="checkbox" data-tag-pick="${escape(row.path)}" aria-label="选择 ${escape(row.name)}"${view.selected.has(row.path) ? ' checked' : ''}></td>
      <td><div class="repo-name"><span class="repo-icon">${icon('repo')}</span><div class="repo-text">
        <a href="${escape(row.url)}" target="_blank" rel="noopener noreferrer">${escape(row.name)}</a>
        ${row.language ? `<small>${escape(row.language)}</small>` : ''}
        ${tagChips(row.path)}
      </div></div></td>
      <td>${pill(row.aiReview)}</td><td>${pill(row.autoReview)}</td><td>${skillPill(row)}</td>
      <td class="row-end"><button class="row-open" type="button" data-repo="${escape(row.path)}" aria-label="查看 ${escape(row.name)} 的详情">${icon('arrow')}</button></td>
    </tr>`).join('') : '<tr><td class="empty" colspan="6">没有符合条件的仓库。</td></tr>';
  byId('result-count').textContent = `显示 ${rows.length} / ${records.length} 个仓库`;
  renderSelection();
}

function tagChips(path) {
  const tags = RepoTags.forRepo(path);
  return tags.length ? `<div class="repo-tags" aria-label="仓库标签">${tags.map(tag =>
    `<button class="repo-tag" type="button" data-tag-scope="${escape(tag)}" aria-label="筛选标签 ${escape(tag)}">${escape(tag)}</button>`).join('')}</div>` : '';
}

function renderSelection() {
  const selected = view.selected.size;
  const visibleSelected = view.visible.filter(row => view.selected.has(row.path)).length;
  tagSelectAll.disabled = view.visible.length === 0;
  tagSelectAll.checked = visibleSelected > 0 && visibleSelected === view.visible.length;
  tagSelectAll.indeterminate = visibleSelected > 0 && visibleSelected < view.visible.length;
  const count = byId('tag-selection-count');
  count.hidden = selected === 0;
  count.textContent = `已选 ${selected} 个仓库${selected > visibleSelected ? `，其中 ${selected - visibleSelected} 个未显示` : ''}`;
  byId('tag-batch').disabled = selected === 0;
  byId('tag-clear-selection').hidden = selected === 0;
}

function updateRowSelections() {
  for (const box of document.querySelectorAll('[data-tag-pick]')) {
    box.checked = view.selected.has(box.dataset.tagPick);
  }
  renderSelection();
}

function externalLink(url, label, className = '') {
  return url ? `<a class="${className}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label} ${icon('external')}</a>` : '';
}

function dialogHeader(id, title, eyebrow = '') {
  return `<header class="dialog-heading"><div>${eyebrow ? `<p>${escape(eyebrow)}</p>` : ''}<h2 id="${id}">${escape(title)}</h2></div>
    <form method="dialog"><button class="close-button" autofocus aria-label="关闭">${icon('close')}</button></form></header>`;
}

function openTagBatch() {
  const selected = [...view.selected];
  const tags = RepoTags.list();
  tagDialog.innerHTML = `${dialogHeader('tag-title', '批量编辑标签')}
    <form class="dialog-body tag-editor" id="tag-edit-form">
      <p>将操作应用到已选的 ${selected.length} 个仓库。</p>
      <label>操作<select class="tag-field" id="tag-operation"><option value="add">添加标签</option><option value="remove">移除标签</option></select></label>
      <label>标签名称<input class="tag-field" id="tag-name" list="tag-options" placeholder="输入新标签或选择已有标签" required></label>
      <datalist id="tag-options">${tags.map(tag => `<option value="${escape(tag)}"></option>`).join('')}</datalist>
      <div class="dialog-actions"><button class="button button-primary" type="submit">应用到所选仓库</button></div>
      <p id="tag-edit-message" class="dialog-message error" role="status"></p>
    </form>`;
  const input = byId('tag-name');
  const operation = byId('tag-operation');
  operation.addEventListener('change', () => {
    input.placeholder = operation.value === 'add' ? '输入新标签或选择已有标签' : '输入或选择要移除的标签';
  });
  byId('tag-edit-form').addEventListener('submit', event => {
    event.preventDefault();
    const message = byId('tag-edit-message');
    try {
      const remove = operation.value === 'remove';
      const changed = remove ? RepoTags.remove(selected, input.value) : RepoTags.add(selected, input.value);
      if (!changed) {
        message.textContent = remove ? '所选仓库没有这个标签。' : '所选仓库已拥有这个标签。';
        return;
      }
      tagDialog.close();
      notify(remove ? '已从所选仓库移除标签。' : '已为所选仓库添加标签。');
    } catch (error) {
      message.textContent = error.message;
    }
  });
  tagDialog.showModal();
  input.focus();
}

function openTagConfig() {
  tagDialog.innerHTML = `${dialogHeader('tag-title', '仓库标签配置')}
    <div class="dialog-body">
      <p>标签保存在当前浏览器，AI 检视管理和统计共用。导入会把文件里的标签合并到现有配置。</p>
      <div class="dialog-actions">
        <button class="button" id="tag-export" type="button">${icon('download')}导出标签配置</button>
        <button class="button button-primary" id="tag-import" type="button">${icon('upload')}导入标签配置</button>
        <input id="tag-file" type="file" accept="application/json,.json" hidden>
      </div>
      <p id="tag-config-message" class="dialog-message" role="status"></p>
    </div>`;
  const input = byId('tag-file');
  byId('tag-export').addEventListener('click', () => {
    downloadJson(RepoTags.exportConfig(), 'cangjie-repo-tags.json');
    byId('tag-config-message').textContent = '已导出标签配置。';
  });
  byId('tag-import').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const message = byId('tag-config-message');
    try {
      const changed = RepoTags.importConfig(JSON.parse(await file.text()));
      message.classList.remove('error');
      message.textContent = changed ? '已合并标签配置。' : '标签配置已包含在当前浏览器中。';
    } catch (error) {
      message.classList.add('error');
      message.textContent = error instanceof SyntaxError ? '无法解析标签配置文件。' : error.message;
    } finally {
      input.value = '';
    }
  });
  tagDialog.showModal();
}

function renderDetail(path) {
  const row = view.records.find(item => pathKey(item.path) === pathKey(path));
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
        <a class="button" href="./metrics.html?repo=${encodeURIComponent(row.path)}">查看检视统计</a></div>
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

function openSync() {
  sync.innerHTML = `${dialogHeader('sync-title', '更新数据')}
    <div class="dialog-body">
      <p>使用已登录的 GitCode 会话读取仓库设置，生成 JSON 快照。导入结果保存在当前浏览器。</p>
      <ol><li>将「采集 AI 检视配置」拖到桌面浏览器的书签栏。</li>
        <li>打开 GitCode 并登录拥有仓库设置访问权限的账号，然后点击该书签。</li>
        <li>将下载的 JSON 快照导入工作台。</li></ol>
      <div class="dialog-actions">
        <a class="button bookmarklet" id="bookmarklet" draggable="true">${icon('download')}采集 AI 检视配置</a>
        <button class="button button-primary" id="import-button" type="button">${icon('upload')}导入 JSON</button>
        ${externalLink(inventory?.sourceUrl, '打开 GitCode', 'button')}
      </div>
      <p id="sync-message" class="dialog-message" role="status"></p>
    </div>`;
  const bookmarklet = byId('bookmarklet');
  bookmarklet.href = bookmarkletHref();
  bookmarklet.addEventListener('click', event => {
    event.preventDefault();
    byId('sync-message').textContent = '请先将按钮拖到书签栏，再到 GitCode 页面点击书签。';
  });
  byId('import-button').addEventListener('click', () => fileInput.click());
  if (!sync.open) sync.showModal();
}

function downloadSnapshot() {
  const day = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date());
  downloadJson(snapshot(view.records), `cangjie-ai-review-${day}.json`);
  notify('已导出当前仓库快照。');
}

function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`无法读取 ${path} (${response.status})`);
  return response.json();
}

async function initialize() {
  try {
    const [list, startingSnapshot] = await Promise.all([readJson('./inventory.json'), readJson('./snapshot.json')]);
    inventory = list;
    seed = parseSnapshot(startingSnapshot);
    try {
      const local = localStorage.getItem(storageKey);
      if (local) view.local = parseSnapshot(JSON.parse(local));
    } catch {
      notify('未能读取浏览器中保存的快照。');
    }
    byId('filters').innerHTML = Object.entries(filters).map(([key, [label]]) => `
      <button type="button" class="filter" data-filter="${key}" aria-pressed="false">${label}</button>`).join('');
    renderOverview();
    const path = new URLSearchParams(location.hash.slice(1)).get('repo');
    if (path) renderDetail(path);
  } catch (error) {
    byId('data-date').textContent = '仓库清单加载失败，请刷新后重试。';
    byId('data-date').classList.add('error');
    console.error(error);
  }
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
byId('rows').addEventListener('change', event => {
  const box = event.target.closest('[data-tag-pick]');
  if (!box) return;
  if (box.checked) view.selected.add(box.dataset.tagPick);
  else view.selected.delete(box.dataset.tagPick);
  renderSelection();
});
tagSelectAll.addEventListener('change', () => {
  for (const row of view.visible) {
    if (tagSelectAll.checked) view.selected.add(row.path);
    else view.selected.delete(row.path);
  }
  updateRowSelections();
});
byId('tag-clear-selection').addEventListener('click', () => {
  view.selected.clear();
  updateRowSelections();
  tagFilter.focus();
});
byId('tag-batch').addEventListener('click', openTagBatch);
byId('tag-config').addEventListener('click', openTagConfig);
RepoTags.subscribe(() => { if (inventory && seed) renderTagScope(); });

detail.addEventListener('close', () => {
  if (location.hash.startsWith('#repo=')) history.replaceState(null, '', location.pathname + location.search);
});
for (const dialog of [detail, sync, tagDialog]) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const { left, top, right, bottom } = dialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dialog.close();
  });
}

search.addEventListener('input', renderTable);
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey &&
      !detail.open && !sync.open && !tagDialog.open && !event.target.closest('input,textarea,select,[contenteditable]')) {
    event.preventDefault();
    search.focus();
  }
});

byId('nav-repos').addEventListener('click', () => byId('repos').scrollIntoView({ block: 'start' }));
for (const id of ['nav-sync', 'top-sync']) byId(id).addEventListener('click', openSync);
byId('export-button').addEventListener('click', downloadSnapshot);
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const message = byId('sync-message');
  try {
    const rows = parseSnapshot(JSON.parse(await file.text()));
    const next = mergeRows(view.local, rows);
    try {
      localStorage.setItem(storageKey, JSON.stringify(snapshot(next)));
    } catch {
      message.textContent = '当前浏览器无法保存快照，刷新页面后需要重新导入。';
      message.classList.add('error');
      view.local = next;
      renderOverview();
      return;
    }
    view.local = next;
    renderOverview();
    sync.close();
    notify(`已导入 ${rows.length} 个仓库的快照。`);
  } catch (error) {
    message.textContent = error instanceof SyntaxError ? '无法解析 JSON 文件。' : error.message;
    message.classList.add('error');
  } finally {
    fileInput.value = '';
  }
});

initialize();
