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

## 本地运行

```sh
node tools/build.mjs
python -m http.server 8787 --directory dist
```

访问 `http://localhost:8787/`。GitHub Pages 工作流从 `main` 构建，发布 `dist/`。在仓库 Settings → Pages 中将 Source 设为 GitHub Actions。
