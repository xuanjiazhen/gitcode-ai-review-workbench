import { RepoTags } from './repo-tags.js';

export { RepoTags };

const organization = 'Cangjie';
const storageKey = 'cangjie-review-workbench:v1';
const site = 'https://gitcode.com';
const settingsSuffix = '/setting/apps/atomcode_ai_review';
const subscribers = new Set();
const localWarning = '未能读取浏览器中保存的仓库快照。';
const seedWarning = '未能读取站点附带的仓库快照。';
let loadPromise;
let loaded;
let unsavedRows = [];

const pathKey = path => path.toLowerCase();
const flag = value => typeof value === 'boolean' ? value : null;
const text = value => typeof value === 'string' ? value : '';

function checkedTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return value && Number.isFinite(new Date(value).valueOf()) ? value : null;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    // Invalid optional links are omitted.
  }
  return '';
}

function normalizeSkill(skill) {
  const name = text(skill?.name).trim();
  if (!name) throw new Error('Skill 名称缺失。');
  return Object.freeze({
    name, url: safeUrl(skill.url), enabled: flag(skill.enabled),
    description: text(skill.description), updatedAt: checkedTime(skill.updatedAt),
    updateUrl: safeUrl(skill.updateUrl),
  });
}

function normalizeRow(row, inventoryOnly = false) {
  if (typeof row?.path !== 'string') throw new Error('仓库配置包含无效路径。');
  const parts = row.path.split('/');
  if (parts.length < 2 || pathKey(parts[0]) !== pathKey(organization) ||
      parts.some(part => !part || part === '.' || part === '..' || /[\\?#\s]/.test(part))) {
    throw new Error('仓库配置包含无效路径。');
  }
  parts[0] = organization;
  const path = parts.join('/');
  const url = `${site}/${parts.map(encodeURIComponent).join('/')}`;
  return Object.freeze({
    path, name: parts.at(-1), url, settingsUrl: `${url}${settingsSuffix}`,
    description: text(row.description), language: text(row.language),
    ...(Number.isSafeInteger(row.projectId) && row.projectId > 0 ? { projectId: row.projectId } : {}),
    ...(['public', 'private', 'internal'].includes(row.visibility) ? { visibility: row.visibility } : {}),
    ...(typeof row.archived === 'boolean' ? { archived: row.archived } : {}),
    aiReview: inventoryOnly ? null : flag(row.aiReview),
    autoReview: inventoryOnly ? null : flag(row.autoReview),
    skills: !inventoryOnly && Array.isArray(row.skills) ? Object.freeze(row.skills.map(normalizeSkill)) : null,
    checkedAt: inventoryOnly ? null : checkedTime(row.checkedAt),
    note: inventoryOnly ? '' : text(row.note),
  });
}

function normalizeRows(rows, inventoryOnly = false) {
  const records = rows.map(row => normalizeRow(row, inventoryOnly));
  if (new Set(records.map(row => pathKey(row.path))).size !== records.length) {
    throw new Error('仓库配置包含重复的仓库路径。');
  }
  return records;
}

function readSnapshot(value) {
  if (value?.version !== 1 || text(value.organization).toLowerCase() !== pathKey(organization) ||
      !Array.isArray(value.repositories)) {
    throw new Error('请选择 Cangjie 工作台的 JSON 快照。');
  }
  return normalizeRows(value.repositories);
}

function readInventory(value) {
  if (text(value?.organization).toLowerCase() !== pathKey(organization) ||
      !Array.isArray(value.repositories) || value.repositories.length !== value.total) {
    throw new Error('仓库清单格式不正确。');
  }
  return Object.freeze({
    organization, total: value.total, observedAt: checkedTime(value.observedAt),
    sourceUrl: safeUrl(value.sourceUrl),
    repositories: Object.freeze(normalizeRows(value.repositories, true)),
  });
}

function mergeRows(base, updates) {
  const merged = new Map(base.map(row => [pathKey(row.path), row]));
  for (const row of updates) {
    const key = pathKey(row.path);
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, row);
      continue;
    }

    // Keep the settings from a single observation, including any unknown fields it contains.
    const newer = !prior.checkedAt || (row.checkedAt && new Date(row.checkedAt) >= new Date(prior.checkedAt));
    const latest = newer ? row : prior;
    const older = newer ? prior : row;
    merged.set(key, {
      ...older, ...latest,
      path: prior.path, name: prior.name, url: prior.url, settingsUrl: prior.settingsUrl,
      description: latest.description || older.description, language: latest.language || older.language,
    });
  }
  return [...merged.values()];
}

function readLocal() {
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    return { records: raw ? readSnapshot(JSON.parse(raw)) : [] };
  } catch {
    return { records: [], warning: localWarning };
  }
}

function asSnapshot(repositories) {
  return { version: 1, organization, exportedAt: new Date().toISOString(), repositories };
}

function currentRecords(local) {
  return mergeRows(mergeRows(mergeRows(loaded.inventory.repositories, loaded.seed), local), unsavedRows);
}

function getState() {
  if (!loaded) return null;
  const local = readLocal();
  const records = currentRecords(local.records).map(row => ({ ...row, tags: RepoTags.forRepo(row.path) }));
  const assigned = new Set(records.flatMap(row => row.tags));
  const enabledRepositories = records.filter(row => row.aiReview === true).map(row => row.path)
    .sort((a, b) => a.localeCompare(b));
  const lastChecked = records.reduce((latest, row) =>
    row.checkedAt && (!latest || new Date(row.checkedAt) > new Date(latest)) ? row.checkedAt : latest, null);

  return {
    inventory: loaded.inventory, records, tags: RepoTags.list().filter(tag => assigned.has(tag)), enabledRepositories, lastChecked,
    organizationKnown: records.length > 0 && loaded.inventory.total > 0 && records.every(row => row.aiReview !== null),
    warnings: [loaded.warning, local.warning].filter(Boolean),
  };
}

function notify() {
  if (!loaded || !subscribers.size) return;
  const state = getState();
  for (const listener of [...subscribers]) {
    try { listener(state); }
    catch (error) { globalThis.reportError?.(error); }
  }
}

async function fetchJson(file) {
  const response = await fetch(new URL(file, import.meta.url));
  if (!response.ok) throw new Error(`无法读取 ${file}（HTTP ${response.status}）。`);
  return response.json();
}

async function load() {
  if (!loadPromise) {
    loadPromise = Promise.all([
      fetchJson('./inventory.json').then(readInventory),
      fetchJson('./snapshot.json').then(readSnapshot).then(seed => ({ seed })).catch(() => ({ seed: [], warning: seedWarning })),
    ]).then(([inventory, collected]) => {
      loaded = { inventory, ...collected };
    }).catch(error => {
      loadPromise = undefined;
      throw error;
    });
  }
  await loadPromise;
  return getState();
}

function importSnapshot(value) {
  const rows = readSnapshot(value);
  const next = mergeRows(mergeRows(readLocal().records, unsavedRows), rows);
  let saved = true;
  try {
    globalThis.localStorage.setItem(storageKey, JSON.stringify(asSnapshot(next)));
    unsavedRows = [];
  } catch {
    saved = false;
    unsavedRows = next;
  }
  notify();
  return { count: rows.length, saved };
}

function exportSnapshot() {
  if (!loaded) throw new Error('仓库清单尚未加载。');
  return asSnapshot(currentRecords(readLocal().records));
}

export function skillStatus(record) {
  if (record.skills === null) return null;
  if (record.skills.some(skill => skill.enabled === true)) return true;
  return record.skills.some(skill => skill.enabled === null) ? null : false;
}

export function isVerified(record) {
  return record.aiReview !== null && record.autoReview !== null && record.skills !== null &&
    record.skills.every(skill => skill.enabled !== null);
}

export function hasEvidence(record) {
  return record.aiReview !== null || record.autoReview !== null || record.skills !== null;
}

globalThis.addEventListener?.('storage', event => {
  if (event.key !== storageKey) return;
  if (event.storageArea && event.storageArea !== globalThis.localStorage) return;
  notify();
});

RepoTags.subscribe(notify);

export const RepoConfig = Object.freeze({
  load, getState, importSnapshot, exportSnapshot,
  subscribe(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
});
