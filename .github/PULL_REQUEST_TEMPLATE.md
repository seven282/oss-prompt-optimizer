<!-- 提交前逐项核对；不适用项请说明原因 -->

## 概述

<!-- 改了什么、为什么 -->

## 自查清单

- [ ] `pnpm typecheck` 与 `pnpm test` 全绿
- [ ] `node scripts/preflight.mjs --offline --skip-tests` 全绿
- [ ] 改动 `src/` 或 `client/` 时已重新 `pnpm build`，且 `lib/` 与本笔一起提交
- [ ] 遵守兼容性硬规则（R1 / R2 / R2b，见 docs/compatibility.md）
- [ ] 涉及用户可见行为时，`README.md` 与 `README.en.md` 同步更新（逐节同序）
- [ ] 有行为变化时 `CHANGELOG.md` 已加条目
