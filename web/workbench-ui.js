import { RepoTags } from './repo-config.js';

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

export const byId = id => document.getElementById(id);

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
});

function svg(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

export function icon(name) {
  return `<span data-icon="${name}">${svg(name)}</span>`;
}

export function renderIcons() {
  for (const element of document.querySelectorAll('[data-icon]')) {
    element.innerHTML = svg(element.dataset.icon);
  }
}

export function escape(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : dateFormat.format(date);
}

export function externalLink(url, label, className = '') {
  return url ? `<a class="${className}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label} ${icon('external')}</a>` : '';
}

export function dialogHeader(id, title, eyebrow = '') {
  return `<header class="dialog-heading"><div>${eyebrow ? `<p>${escape(eyebrow)}</p>` : ''}<h2 id="${id}">${escape(title)}</h2></div>
    <form method="dialog"><button class="close-button" autofocus aria-label="关闭">${icon('close')}</button></form></header>`;
}

export function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function dismissOnBackdrop(dialog) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const { left, top, right, bottom } = dialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dialog.close();
  });
}

export function updateTagScope(select, tags, currentTag) {
  const key = RepoTags.key(currentTag);
  const known = tags.find(tag => RepoTags.key(tag) === key);
  const selected = known ?? (key ? currentTag.trim() : '');
  select.replaceChildren(new Option('全部标签', ''), ...tags.map(tag => new Option(tag, tag)));
  if (selected && !known) select.add(new Option(`${selected} · 当前无匹配标签`, selected));
  select.value = selected;

  const url = new URL(location.href);
  if (selected) url.searchParams.set('tag', selected);
  else url.searchParams.delete('tag');
  if (url.href !== location.href) history.replaceState(null, '', url);
  for (const link of document.querySelectorAll('[data-tag-route]')) {
    const route = new URL(link.dataset.tagRoute, location.href);
    if (selected) route.searchParams.set('tag', selected);
    link.href = route.href;
  }
  return selected;
}

export function tagChips(tags) {
  return tags.length ? `<div class="repo-tags" aria-label="仓库标签">${tags.map(tag =>
    `<button class="repo-tag" type="button" data-tag-scope="${escape(tag)}" aria-label="筛选标签 ${escape(tag)}">${escape(tag)}</button>`).join('')}</div>` : '';
}
