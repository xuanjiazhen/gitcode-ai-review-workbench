import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const at = path => new URL(path, root);
const dist = at('dist/');
const publicBuild = process.argv.includes('--public');
const inventory = JSON.parse(await readFile(at('data/inventory.json'), 'utf8'));
const snapshot = JSON.parse(await readFile(at('data/snapshot.json'), 'utf8'));
const metricSource = await readFile(at('data/review-metrics.json'), 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '{"version":1,"reports":[]}';
});
const reviewMetrics = JSON.parse(metricSource);
const tagsSource = await readFile(at('data/repo-tags.json'), 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '{"version":1,"repositories":[]}';
});
const tags = JSON.parse(tagsSource);

if (inventory.organization !== 'Cangjie' || inventory.repositories.length !== inventory.total ||
    new Set(inventory.repositories.map(repo => repo.path.toLowerCase())).size !== inventory.total) {
  throw new Error('Invalid Cangjie repository inventory');
}
if (snapshot.version !== 1 || snapshot.organization !== inventory.organization || !Array.isArray(snapshot.repositories)) {
  throw new Error('Invalid Cangjie audit snapshot');
}
if (reviewMetrics.version !== 1 || !Array.isArray(reviewMetrics.reports)) {
  throw new Error('Invalid review metrics export');
}
if (tags.version !== 1 || !Array.isArray(tags.repositories)) {
  throw new Error('Invalid repository tags');
}
if (publicBuild && (snapshot.repositories.length || reviewMetrics.reports.length || tags.repositories.length)) {
  throw new Error('GitHub Pages requires empty review data and tags');
}
if (publicBuild && inventory.repositories.some(repo => repo.visibility != null && repo.visibility !== 'public')) {
  throw new Error('GitHub Pages requires a public repository inventory');
}

await mkdir(dist, { recursive: true });
await cp(at('web/'), dist, { recursive: true });
await copyFile(at('tools/collector.mjs'), at('dist/collector.js'));
await copyFile(at('data/inventory.json'), at('dist/inventory.json'));
await writeFile(at('dist/snapshot.json'), publicBuild
  ? JSON.stringify({ version: 1, organization: inventory.organization, repositories: [] })
  : await readFile(at('data/snapshot.json'), 'utf8'));
await writeFile(at('dist/review-metrics.json'), publicBuild ? '{"version":1,"reports":[]}' : metricSource);
await writeFile(at('dist/repo-tags.json'), tagsSource);
await writeFile(at('dist/.nojekyll'), '');
console.log(`Built dist/ with ${inventory.total} repositories and ${snapshot.repositories.length} audit records.`);
