# 仓颉 · AI 检视工作台

工作台展示 GitCode Cangjie 组织的仓库、AI 检视状态、PR 创建时的自动检视状态，以及外部 Skill。通过仓库详情进入 GitCode 设置页，在「自定义 Skills」中执行对应 Skill 的「更新」操作。

## 复查配置

1. 打开工作台的「更新数据」，将采集书签拖到桌面浏览器的书签栏。
2. 在拥有仓库设置访问权限的 GitCode 账号中登录 `https://gitcode.com`，点击采集书签并下载 JSON。
3. 在工作台导入快照。导入结果保存在当前浏览器，可用「导出快照」备份或迁移。

采集书签使用当前 GitCode 登录会话发起只读请求。快照不含登录凭据。公开部署仅内置公开仓库目录，用户导入的设置值由浏览器保存。

- 「AI 检视」取 GitCode「关闭 AI 代码评审」的反值。
- 「PR 创建自动检视」取「PR 创建时」下的「执行 AI 代码评审」。
- 「自定义 Skill」在至少一个外部 Skill 启用时显示已启用，已读取的空列表显示未配置。
- 读取失败或缺少字段的值显示待核实。重复导入时，以该仓库采集时间较新的记录为准。

## 检视统计

在工作台打开「AI 检视统计」，选择统计批次，切换组织整体、单仓或自选多仓。可以按仓库、PR、解决状态和采纳结论筛选意见，打开详情查看证据。

在工作台仓库根目录执行以下命令，按已核实的 AI 检视配置采集最近 30 个完整北京时间自然日内创建的 PR。将 `--settings` 指向包含每个仓库状态的配置快照。可用 `--created-after` 和 `--created-before` 指定含时区的起止时间（包含起点，截止时间不含）。同一轮可复用断点目录补采，另起一轮请指定新目录。

```sh
python tools/collect-metrics.py --settings private/review-settings.json --checkpoint-dir private/metrics-run --output private/review-metrics.json
```

采集报告记录 Bot 文件 Diff 评论候选、候选解决状态和 PR 读取覆盖。组织或选定仓库的采纳率使用各仓分子和分母加总。

已有判定可从原统计工具导出。Windows 可双击 `gitcode-review-metrics/start-local.bat` 打开原工具。下面的命令使用只读模式导出 SQLite 中的结果。

```sh
python tools/export-metrics.py --db ../gitcode-review-metrics/local-app.sqlite --output private/review-metrics.json
```

也可通过 `--snapshot`、`--assessment` 和 `--config` 对现有 JSON 快照重新计算。省略这三个选项及 `--db` 时使用原工具随附的 `cangjie_docs` 全仓快照。若本地统计工具目录不是工作台的同级目录，可用 `--metrics-dir` 指定。

把生成的 JSON 导入统计页即可查看。浏览器保存导入的报告，支持再导出。组织内部报告可随私有部署放在 `data/review-metrics.json`。GitHub Pages 只发布界面和导入功能。

- 「已确认采纳率」的分子是有证据确认完全采纳的已解决独立 Diff 意见。分母包括全部已解决的独立 Diff 意见，以及暂计的已解决 Diff 候选。部分采纳、未采纳和采纳待判定的已解决独立意见只进分母。待分类的候选先按原始评论计数，完成分类后按独立意见重新计算。
- 讨论区评论、已排除的 Diff 评论、未解决或解决状态未知的意见和候选，以及评论类型待核实的记录不进分母。无分母样本按展示约定显示 0%。
- 「最终采纳率」沿用原工具口径，等范围采集、去重和采纳判定完成后，计算完全采纳数除以已解决独立 Diff 意见数。

## 本地运行

```sh
node tools/build.mjs
python -m http.server 8787 --directory dist
```

访问 `http://localhost:8787/`。GitHub Pages 工作流从 `main` 构建，发布 `dist/`。在仓库 Settings → Pages 中将 Source 设为 GitHub Actions。
