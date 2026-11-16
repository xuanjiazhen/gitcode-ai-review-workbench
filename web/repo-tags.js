const storageKey = 'cangjie-workbench:repo-tags:v1';
const maxLength = 40;
const subscribers = new Set();
const order = new Intl.Collator('zh-CN', { numeric: true });
const repositoryPath = /^[\w.-]+(?:\/[\w.-]+)+$/u;
const forbiddenTagCharacters = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
let cachedText;
let cachedModel;
let defaults = makeModel();

function pathKey(value) {
  if (typeof value !== 'string') return '';
  const path = value.trim();
  return repositoryPath.test(path) && path.split('/').every(part => part !== '.' && part !== '..')
    ? path.toLowerCase() : '';
}

function tagName(value) {
  if (typeof value !== 'string') return '';
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return [...name].length <= maxLength && !forbiddenTagCharacters.test(name) ? name : '';
}

function key(value) {
  return tagName(value).toLowerCase();
}

function makeModel() {
  return { labels: new Map(), repositories: new Map() };
}

function assign(model, path, name) {
  const id = key(name);
  if (!model.labels.has(id)) model.labels.set(id, name);
  if (!model.repositories.has(path)) model.repositories.set(path, new Set());
  model.repositories.get(path).add(id);
}

function parseConfig(value) {
  if (value?.version !== 1 || !Array.isArray(value.repositories)) {
    throw new Error('请选择仓库标签配置 JSON。');
  }
  const model = makeModel();
  for (const row of value.repositories) {
    const path = pathKey(row?.path);
    if (!path || !Array.isArray(row.tags)) throw new Error('标签配置中有无效的仓库路径或标签列表。');
    for (const value of row.tags) {
      const name = tagName(value);
      if (!name) throw new Error(`标签名称须为 1–${maxLength} 个字符，且不能含控制字符。`);
      assign(model, path, name);
    }
  }
  return model;
}

function currentModel() {
  let raw;
  try { raw = globalThis.localStorage.getItem(storageKey); }
  catch { return cachedModel ?? defaults; }
  if (cachedModel && raw === cachedText) return cachedModel;

  let model = defaults;
  try {
    if (raw !== null) model = parseConfig(JSON.parse(raw));
  } catch {
    // Offer a usable view even if previously saved browser data is invalid.
  }
  cachedText = raw;
  cachedModel = model;
  return model;
}

function setDefaults(value) {
  defaults = parseConfig(value);
  cachedModel = undefined;
}

function copyModel(model) {
  return {
    labels: new Map(model.labels),
    repositories: new Map([...model.repositories].map(([path, ids]) => [path, new Set(ids)])),
  };
}

function names(model, ids) {
  return ids ? [...ids].map(id => model.labels.get(id)).sort(order.compare) : [];
}

function serialize(model) {
  return {
    version: 1,
    repositories: [...model.repositories.keys()].sort(order.compare).map(path => ({
      path,
      tags: names(model, model.repositories.get(path)),
    })),
  };
}

function notify() {
  for (const listener of [...subscribers]) {
    try { listener(); }
    catch (error) { globalThis.reportError?.(error); }
  }
}

function persist(model, previous) {
  const raw = JSON.stringify(serialize(model));
  if (raw === JSON.stringify(serialize(previous))) return false;
  try { globalThis.localStorage.setItem(storageKey, raw); }
  catch { throw new Error('浏览器无法保存仓库标签。'); }
  cachedText = raw;
  cachedModel = model;
  notify();
  return true;
}

function checkedPaths(paths) {
  if (typeof paths === 'string') paths = [paths];
  if (typeof paths?.[Symbol.iterator] !== 'function') throw new Error('请选择仓库。');
  const keys = [...paths].map(pathKey);
  if (keys.some(path => !path)) throw new Error('仓库路径无效。');
  return new Set(keys);
}

function changeTags(paths, tag, shouldAdd) {
  const name = tagName(tag);
  if (!name) throw new Error(`标签名称须为 1–${maxLength} 个字符，且不能含控制字符。`);
  const keys = checkedPaths(paths);
  const previous = currentModel();
  const model = copyModel(previous);
  const id = key(name);

  for (const path of keys) {
    if (shouldAdd) assign(model, path, name);
    else {
      const tags = model.repositories.get(path);
      if (!tags?.delete(id)) continue;
      if (tags.size === 0) model.repositories.delete(path);
    }
  }
  if (!shouldAdd && ![...model.repositories.values()].some(tags => tags.has(id))) model.labels.delete(id);
  return persist(model, previous);
}

function importConfig(value, { replace = false } = {}) {
  const imported = parseConfig(value);
  const previous = currentModel();
  if (replace) return persist(imported, previous);

  const model = copyModel(previous);
  for (const [path, tags] of imported.repositories) {
    for (const id of tags) assign(model, path, imported.labels.get(id));
  }
  return persist(model, previous);
}

globalThis.addEventListener?.('storage', event => {
  if (event.key !== storageKey && event.key !== null) return;
  if (event.storageArea && event.storageArea !== globalThis.localStorage) return;
  notify();
});

export const RepoTags = Object.freeze({
  maxLength,
  key,
  setDefaults,
  list() { return [...currentModel().labels.values()].sort(order.compare); },
  forRepo(path) {
    const model = currentModel();
    return names(model, model.repositories.get(pathKey(path)));
  },
  has(path, tag) { return currentModel().repositories.get(pathKey(path))?.has(key(tag)) ?? false; },
  add(paths, tag) { return changeTags(paths, tag, true); },
  remove(paths, tag) { return changeTags(paths, tag, false); },
  exportConfig() { return serialize(currentModel()); },
  importConfig,
  subscribe(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
});
