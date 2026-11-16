# 仓颉 · AI 检视工作台

工作台展示 GitCode Cangjie 组织的仓库、AI 检视状态、PR 创建时的自动检视状态，以及外部 Skill。通过仓库详情进入 GitCode 设置页，在「自定义 Skills」中执行对应 Skill 的「更新」操作。

## 仓库配置

1. 进入「仓库配置」并打开「更新数据」，将采集书签拖到桌面浏览器的书签栏。
2. 在拥有仓库设置访问权限的 GitCode 账号中登录 `https://gitcode.com`，点击采集书签并下载 JSON。
3. 在「仓库配置」导入快照。导入结果保存在当前浏览器，可用「导出快照」备份或迁移。

采集书签使用当前 GitCode 登录会话发起只读请求。快照不含登录凭据。公开部署仅内置公开仓库目录，用户导入的设置值由浏览器保存。

- 「AI 检视」取 GitCode「关闭 AI 代码评审」的反值。
- 「PR 创建自动检视」取「PR 创建时」下的「执行 AI 代码评审」。
- 「自定义 Skill」在至少一个外部 Skill 启用时显示已启用，已读取的空列表显示未配置。
- 读取失败或缺少字段的值显示待核实。重复导入时，以该仓库采集时间较新的记录为准。

## 仓库标签

在「仓库配置」勾选仓库，用「批量编辑标签」添加或移除标签。标签可筛选配置清单和 AI 检视管理。统计页使用「商用交付&社区运作」标签对应的仓库范围。

三个页面在同一站点和浏览器中共用仓库快照与标签配置。重新导入设置快照后，已打开的管理与统计页面会同步更新。通过「标签配置」可单独导出 JSON，或将 JSON 合并到当前浏览器的标签配置。

## 检视统计

打开「AI 检视统计」后，在标签范围内查看批次、单仓或自选多仓。每条记录对应一条 AI Bot 的文件 Diff 评论，可查看 PR、解决状态、采纳判定与证据链接。

- 分母是已合入 PR 中标为已解决的 Bot Diff 评论，每条评论按 ID 计一次。
- 分子是分母中已有开发者明确确认有效或有合入修改证据落实核心意见的评论。开发者落实等效方案也可计入。已解决标记仅用于划定分母。等待核验的评论在采纳证据覆盖中单列。
- 未合入 PR、合入状态未知、已合入但未解决或解决状态未知的 Diff 评论单列展示。分母为零时，页面显示 `0%` 和 `0/0 · 暂无分母样本`。
- 汇总时先加总各仓分子与分母，再计算比例。

在工作台仓库根目录执行以下命令，按标签和已核实的 AI 检视配置采集最近 30 个完整北京时间自然日内创建的 PR。标签和设置快照可从「仓库配置」导出。可用 `--created-after` 和 `--created-before` 指定时段。重试同一轮时可复用断点目录。

```sh
python tools/collect-metrics.py --tags private/repo-tags.json --settings private/review-settings.json --checkpoint-dir private/metrics-run --output private/review-metrics.json
```

采集报告记录合入状态、评论解决状态和 PR 读取覆盖。人工核验可通过 `--adoption-evidence` 导入，每条判定绑定仓库、PR 与评论 ID、评论采集时间、理由和证据链接。已有断点可通过 `--pr-states` 使用另一次合入状态核实结果，报告保留各自的观测时间。

已有判定可从原统计工具导出。Windows 可双击 `gitcode-review-metrics/start-local.bat` 打开原工具。下面的命令使用只读模式导出 SQLite 中的结果。

```sh
python tools/export-metrics.py --db ../gitcode-review-metrics/local-app.sqlite --output private/review-metrics.json
```

也可通过 `--snapshot`、`--assessment` 和 `--config` 对现有 JSON 快照重新计算。省略这三个选项及 `--db` 时使用原工具随附的 `cangjie_docs` 全仓快照。若本地统计工具目录不是工作台的同级目录，可用 `--metrics-dir` 指定。

把生成的 JSON 导入统计页即可查看。浏览器保存导入的报告，支持再导出。私有部署可以从 `data/review-metrics.json` 加载报告，从 `data/repo-tags.json` 加载初始标签。浏览器保存的标签变更适用于同一站点上的所有页面。

## 本地运行

```sh
node tools/build.mjs
python -m http.server 8787 --directory dist
```

访问 `http://localhost:8787/`。GitHub Pages 工作流从 `main` 构建，发布 `dist/`。在仓库 Settings → Pages 中将 Source 设为 GitHub Actions。
