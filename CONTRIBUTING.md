# 贡献指南

感谢关注本插件。这份文件只讲「人」的流程；改造代码时的机械约定（文件职责、
术语表、命名规则）见 [AGENTS.md](AGENTS.md)，兼容性硬规则的唯一权威是
[docs/compatibility.md](docs/compatibility.md)。

## 环境

- Node.js 22、pnpm 12（`package.json` 的 `packageManager` 已钉版本，corepack 用户自动对齐）。
- `pnpm install --frozen-lockfile` 安装依赖。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | `src`/`tests` 与客户端 `client/*.js` 两套类型检查 |
| `pnpm test` | 全部测试（不读密钥，CI 可跑） |
| `pnpm build` | 产出 `lib/`（发布产物，入库） |
| `pnpm preflight` | P1–P12 门禁全量 |
| `pnpm check:docs` | 文档一致性（提示级，不阻断） |

## 提交前必须通过

1. `pnpm typecheck` 与 `pnpm test` 全绿。
2. `node scripts/preflight.mjs --offline --skip-tests` 全绿。
3. **改过 `src/` 或 `client/` 就必须 `pnpm build`，且 `lib/` 与源码同一笔提交**
   （P8 会校验产物新鲜度）。
4. 提交信息用英文 conventional commits（`feat` / `fix` / `docs` / `chore`…），
   正文说明「为什么」。

## 约定速览

- 版本号十进制进位：`1.3.9` 的下一版是 `1.4.0`，不存在 `1.3.10`。
- `CHANGELOG.md` 只增不改，`###` 标题仅用
  `Added / Changed / Deprecated / Removed / Fixed / Security`。
- 不要给宿主包新增顶层静态 `import`（兼容性规则 R1，见
  [docs/compatibility.md](docs/compatibility.md)）；违反会被 P1 拦下。
