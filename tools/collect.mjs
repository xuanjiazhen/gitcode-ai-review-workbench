import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { collectGitCodeAudit } from './collector.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write('用法：node tools/collect.mjs [--output cangjie-ai-review-audit.json]\n' +
      '从 GITCODE_WEB_TOKEN 读取 GitCode 网页 API 的授权令牌。默认输出到标准输出。\n');
    return;
  }

  const token = process.env.GITCODE_WEB_TOKEN;
  if (!token?.trim()) {
    throw new Error('未设置 GITCODE_WEB_TOKEN。也可从工作台安装采集书签，使用已登录的 GitCode 网页。');
  }

  const snapshot = await collectGitCodeAudit({
    token,
    request: (url, options) => fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Origin: 'https://gitcode.com',
        Referer: 'https://gitcode.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
    }),
    onProgress: ({ done, total }) => process.stderr.write(`已读取 ${done} / ${total} 个仓库\n`),
  });
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (!values.output) {
    process.stdout.write(json);
    return;
  }

  const output = resolve(values.output);
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, json, { mode: 0o600, flag: 'wx' });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  process.stderr.write(`采集结果已保存到 ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
