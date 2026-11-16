import { bookmarkletHref } from './collector.js';
import { RepoConfig, RepoTags, isVerified } from './repo-config.js';
import { byId, dateLabel, dialogHeader, dismissOnBackdrop, downloadJson, escape, externalLink, icon, renderIcons, tagChips, updateTagScope } from './workbench-ui.js';

const sync = byId('sync-dialog');
const tagDialog = byId('tag-dialog');
const tagFilter = byId('tag-filter');
const tagSelectAll = byId('tag-select-all');
const search = byId('search');
const fileInput = byId('file-input');
const view = {
  records: [], tags: [], visible: [], selected: new Set(),
  tag: new URLSearchParams(location.search).get('tag') ?? '',
};
let inventory;
let toastTimer;

renderIcons();

function notify(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function renderCatalog(state) {
  const { records, tags, lastChecked, warnings } = state;
  inventory = state.inventory;
  view.records = [...records].sort((a, b) => a.name.localeCompare(b.name));
  view.tags = tags;

  const verified = records.filter(isVerified).length;
  const archived = records.filter(row => row.archived).length;
  byId('catalog-total').textContent = records.length;
  byId('catalog-status').textContent = `已核实 ${verified} · 待核实 ${records.length - verified}${archived ? ` · 已归档 ${archived}` : ''}`;
  byId('data-date').textContent = lastChecked ? `最近采集 ${dateLabel(lastChecked)} · 北京时间` : `仓库清单 ${dateLabel(inventory.observedAt)} · 北京时间`;
  if (inventory.sourceUrl) byId('org-repositories').href = inventory.sourceUrl;
  const warning = byId('config-warnings');
  warning.textContent = warnings.join(' ');
  warning.hidden = !warnings.length;
  renderTagScope();
}

function renderTagScope() {
  view.tag = updateTagScope(tagFilter, view.tags, view.tag);
  renderTable();
}

function renderTable() {
  const query = search.value.trim().toLowerCase();
  const records = view.tag ? view.records.filter(row => row.tags.includes(view.tag)) : view.records;
  const rows = records.filter(row => !query ||
    `${row.path} ${row.language} ${row.description} ${row.tags.join(' ')}`.toLowerCase().includes(query));
  view.visible = rows;
  byId('repo-total').textContent = records.length;
  byId('rows').innerHTML = rows.length ? rows.map(row => {
    const metadata = [row.language, row.visibility === 'private' ? '私有' : row.visibility === 'internal' ? '内部' : '',
      row.archived ? '已归档' : ''].filter(Boolean);
    return `<tr>
      <td class="repo-select"><input type="checkbox" data-tag-pick="${escape(row.path)}" aria-label="选择 ${escape(row.name)}"${view.selected.has(row.path) ? ' checked' : ''}></td>
      <td><div class="repo-name"><span class="repo-icon">${icon('repo')}</span><div class="repo-text">
        <a href="${escape(row.url)}" target="_blank" rel="noopener noreferrer">${escape(row.name)}</a>
        ${metadata.length ? `<small>${escape(metadata.join(' · '))}</small>` : ''}
      </div></div></td>
      <td>${tagChips(row.tags) || '<span class="config-cell-note">未加标签</span>'}</td>
      <td>${row.checkedAt ? `<time datetime="${escape(new Date(row.checkedAt).toISOString())}">${escape(dateLabel(row.checkedAt))}</time>` : ''}
        ${isVerified(row) ? '' : '<span class="config-cell-note">待核实</span>'}</td>
      <td class="row-end"><a class="scope-link" href="${escape(row.settingsUrl)}" target="_blank" rel="noopener noreferrer" aria-label="打开 ${escape(row.name)} 的 GitCode 设置">设置 ${icon('external')}</a></td>
    </tr>`;
  }).join('') : '<tr><td class="empty" colspan="5">没有符合条件的仓库。</td></tr>';
  byId('result-count').textContent = `显示 ${rows.length} / ${records.length} 个仓库`;
  renderSelection();
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

function openTagBatch() {
  const selected = [...view.selected];
  const tags = view.tags;
  tagDialog.innerHTML = `${dialogHeader('tag-title', '批量编辑标签')}
    <form class="dialog-body tag-editor" id="tag-edit-form">
      <p>将操作应用到已选的 ${selected.length} 个仓库。</p>
      <div class="tag-edit-field"><label for="tag-operation">操作</label><select class="tag-field" id="tag-operation"><option value="add">添加标签</option><option value="remove">移除标签</option></select></div>
      <div class="tag-edit-field"><label for="tag-name">标签名称</label><input class="tag-field" id="tag-name" list="tag-options" placeholder="输入新标签或选择已有标签" required></div>
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
  const message = byId('tag-config-message');
  byId('tag-export').addEventListener('click', () => {
    downloadJson(RepoTags.exportConfig(), 'cangjie-repo-tags.json');
    message.classList.remove('error');
    message.textContent = '已导出标签配置。';
  });
  byId('tag-import').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
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

function openSync() {
  sync.innerHTML = `${dialogHeader('sync-title', '更新数据')}
    <div class="dialog-body">
      <p>使用已登录的 GitCode 会话读取仓库设置，生成 JSON 快照。导入后，当前浏览器中的 AI 检视管理与统计会更新仓库范围。</p>
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
  downloadJson(RepoConfig.exportSnapshot(), `cangjie-ai-review-${day}.json`);
  notify('已导出当前仓库快照。');
}

document.addEventListener('click', event => {
  const chip = event.target.closest('[data-tag-scope]');
  if (!chip) return;
  view.tag = chip.dataset.tagScope;
  renderTagScope();
  tagFilter.focus();
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

for (const dialog of [sync, tagDialog]) dismissOnBackdrop(dialog);
search.addEventListener('input', renderTable);
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey &&
      !sync.open && !tagDialog.open && !event.target.closest('input,textarea,select,[contenteditable]')) {
    event.preventDefault();
    search.focus();
  }
});

byId('top-sync').addEventListener('click', openSync);
byId('export-button').addEventListener('click', downloadSnapshot);
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const message = byId('sync-message');
  try {
    const { count, saved } = RepoConfig.importSnapshot(JSON.parse(await file.text()));
    if (!saved) {
      message.textContent = '浏览器无法保存快照。本页可临时查看，其他页面需在浏览器恢复存储后重新导入。';
      message.classList.add('error');
      return;
    }
    sync.close();
    notify(`已导入 ${count} 个仓库的快照。`);
  } catch (error) {
    message.textContent = error instanceof SyntaxError ? '无法解析 JSON 文件。' : error.message;
    message.classList.add('error');
  } finally {
    fileInput.value = '';
  }
});

async function initialize() {
  try {
    renderCatalog(await RepoConfig.load());
    RepoConfig.subscribe(renderCatalog);
    byId('top-sync').disabled = false;
    byId('export-button').disabled = false;
  } catch (error) {
    byId('data-date').textContent = '仓库配置加载失败，请刷新后重试。';
    byId('data-date').classList.add('error');
    console.error(error);
  }
}

initialize();
