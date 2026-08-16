# 上架 dsh-market 插件市场

市场本体（`dshmarket`）的插件列表来自精选库 **awesome-dsh-plugin**：
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin

## 前提（已就绪 ✅）
- npm 包：`oss-prompt-optimizer@1.0.2`（含 `repository` 指向本仓库，市场会校验防冒名）
- GitHub 仓库：https://github.com/seven282/oss-prompt-optimizer

## 提交步骤
1. fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 编辑根目录的插件列表（README.md 或 plugins 清单，按该仓库现有表格格式）
3. 新增一行（分类建议 `tools`）：

   ```markdown
   | [oss-prompt-optimizer](https://github.com/seven282/oss-prompt-optimizer) | 将原始指令优化为 Role / Task / Context / Format 四段专业提示词：输入框 ✨ 一键优化与撤销、`prompt_optimize` 工具、自动优化钩子、可配置元提示词 | tools | ⭐0 |
   ```

4. 提 PR，说明：
   - 这是你的插件（本人提交，fork 自上游仓库）
   - npm 包名与版本：`oss-prompt-optimizer@1.0.2`
   - 安装命令：`dsh plugin --profile web add oss-prompt-optimizer`
5. 合并后 **通常一天内** 自动收录（站点 + 市场内可见）

## 收录后验证
- 网页：https://awesome-dsh-plugin.com/p/seven282/oss-prompt-optimizer/
- 市场内：重启 harness → 设置 → 插件市场 → 搜索 `prompt-optimizer`

> 提示：该仓库只收**可信来源**；market 内安装默认走 npm tarball（秒级），
> GitHub 仅作 fallback。收录 ≠ 背书，作者需自行维护后续版本。

---

## 发布后达标检查清单（2026-08-17 执行）

> 背景：PR #1033 已提交（https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1033），
> 但 CI 的「仓库满 1 天 + 提交数 ≥ 10」门槛需等待达标。以下按序执行。

### 1. 网络与推送
- [x] 确认 github.com:443 可达：间歇性断连，重试后恢复
- [x] 推送本地待推送提交：`git push origin main`
      （已推送：`d65d7a2` 改名 oss-prompt-optimizer / 此前 11 笔；远端 12 笔）
- [x] 核对远端提交数：`git rev-list --count origin/main` = 12（≥ 10 ✅）

### 2. 提交数补足（若 < 10）
- [x] 新增 `CHANGELOG.md`（记录 v1.0.0 / v1.0.1 变更）
- [x] 新增 `.github/workflows/ci.yml`（typecheck + build + test，CI 有实际价值）
- [x] 逐笔 `git add` + 有意义的提交信息，避免凑数提交
- 每笔提交都应有实际内容；达标后 `git rev-list --count origin/main` = 12 ≥ 10

### 3. PR 状态
- [x] PR #1033（首次收录）已合并（merged: true，2026-08-17）
- [x] **PR #1049**（仓库改名 follow-up，`seven282__oss-prompt-optimizer.yml`）已合并
      （merged: true，2026-08-16 13:00 UTC）
- [ ] 站点 URL 生效：https://awesome-dsh-plugin.com/p/seven282/oss-prompt-optimizer/
      （合并后约 1 天刷新，待观察）

### 4. 合并后验证
- [ ] 站点收录：https://awesome-dsh-plugin.com/p/seven282/oss-prompt-optimizer/
      （PR #1049 已合并；站点约 1 天后刷新生效）
- [ ] 市场内可见：重启 `dsh web` → 设置 → 插件市场 → 搜索 `prompt-optimizer`
- [x] 一键安装验证：`dsh plugin --profile web add oss-prompt-optimizer`
      （npm 直装验证通过，profile 已装载 `oss-prompt-optimizer 1.0.2`）

### 5. 长期维护（可选）
- [ ] 版本迭代时同步 `npm publish` 与 GitHub 推送，保持 `repository` 字段一致
- [ ] 可选：向 awesome-dsh-plugin 提交 `data/screenshots.json` 条目，市场详情页展示截图

