# 安全策略

## 报告漏洞

**请不要在公开 issue 中描述漏洞。** 使用 GitHub 的「私下报告漏洞」入口（仓库
**Security** 标签页 → *Report a vulnerability*），或通过仓库所有者的 GitHub 主页
私信联系。

报告时请附：复现步骤、影响的版本、必要的宿主环境（dsh 版本与平台）。

## 响应时限

| 阶段 | 目标 |
|---|---|
| 确认收到 | 7 天内 |
| 初步评估（影响面 / 是否需要发版） | 14 天内 |
| 修复或缓解 | 按严重程度，高危以下一个补丁版本发出 |

## 支持的版本

只支持最新发布版本。本插件与宿主 `dsh` 的兼容范围见 `package.json` 的
`engines.dsh`（当前 `^0.2.0-rc.2`）与 [docs/compatibility.md](docs/compatibility.md)。
