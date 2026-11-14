import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const at = path => new URL(path, root);
const dist = at('dist/');
const inventory = JSON.parse(await readFile(at('data/inventory.json'), 'utf8'));
const snapshot = JSON.parse(await readFile(at('data/snapshot.json'), 'utf8'));

if (inventory.organization !== 'Cangjie' || inventory.repositories.length !== inventory.total ||
    new Set(inventory.repositories.map(repo => repo.path.toLowerCase())).size !== inventory.total) {
  throw new Error('Invalid Cangjie repository inventory');
}
if (snapshot.version !== 1 || snapshot.organization !== inventory.organization || !Array.isArray(snapshot.repositories)) {
  throw new Error('Invalid Cangjie audit snapshot');
}

await mkdir(dist, { recursive: true });
await cp(at('web/'), dist, { recursive: true });
await copyFile(at('tools/collector.mjs'), at('dist/collector.js'));
await copyFile(at('data/inventory.json'), at('dist/inventory.json'));
await copyFile(at('data/snapshot.json'), at('dist/snapshot.json'));
await writeFile(at('dist/.nojekyll'), '');
console.log(`Built dist/ with ${inventory.total} public repositories and ${snapshot.repositories.length} audit records.`);
