# 上架 dsh-market 插件市场

市场本体（`dshmarket`）的插件列表来自精选库 **awesome-dsh-plugin**：
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin

## 前提（已就绪 ✅）
- npm 包：`deepseek-harness-prompt-optimizer@1.0.1`（含 `repository` 指向本仓库，市场会校验防冒名）
- GitHub 仓库：https://github.com/seven282/deepseek-harness-prompt-optimizer

## 提交步骤
1. fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 编辑根目录的插件列表（README.md 或 plugins 清单，按该仓库现有表格格式）
3. 新增一行（分类建议 `tools`）：

   ```markdown
   | [deepseek-harness-prompt-optimizer](https://github.com/seven282/deepseek-harness-prompt-optimizer) | 将原始指令优化为 Role / Task / Context / Format 四段专业提示词：输入框 ✨ 一键优化与撤销、`prompt_optimize` 工具、自动优化钩子、可配置元提示词 | tools | ⭐0 |
   ```

4. 提 PR，说明：
   - 这是你的插件（作者 seven282）
   - npm 包名与版本：`deepseek-harness-prompt-optimizer@1.0.1`
   - 安装命令：`dsh plugin --profile web add deepseek-harness-prompt-optimizer`
5. 合并后 **通常一天内** 自动收录（站点 + 市场内可见）

## 收录后验证
- 网页：https://awesome-dsh-plugin.com/p/seven282/deepseek-harness-prompt-optimizer/
- 市场内：重启 harness → 设置 → 插件市场 → 搜索 `prompt-optimizer`

> 提示：该仓库只收**可信来源**；market 内安装默认走 npm tarball（秒级），
> GitHub 仅作 fallback。收录 ≠ 背书，作者需自行维护后续版本。
