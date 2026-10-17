# 上游基线与第一版目标

记录日期：2026-10-17。

## 来源

- 上游项目：[Obito-404/Codex_iLink](https://github.com/Obito-404/Codex_iLink)。
- 固定提交：`081526ee91d6eaa469cc13405e73b9a73f652810`。
- 包版本：`0.1.0-rc.5`。
- 原作者版权：`Copyright (c) 2026 Obito`。
- 许可证：[MIT 原文](../vendor/codex-ilink/LICENSE)，保留原始声明。
- 导入位置：`vendor/codex-ilink/`；上游的源码、测试、文档及插件保持原目录结构，没有嵌套 `.git`。

本项目以 Codex_iLink 为中间件基础。普通微信通信依托其 iLink 实现，任务执行依托本机 Codex App Server，历史由 Codex 持久化。Codex_iLink 是第三方项目，腾讯维护的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 是微信渠道的官方实现参考，不能混为同一个项目。

## 第一版范围

第一版与固定上游版本保持功能对齐，先完成本仓库内的安装、运行与完整链路验收。保留已通过本机验证的兼容修复，暂不另造 Agent、不重写协议、不增加产品功能、不默认切换为企业微信或小程序。

完整链路：普通微信消息 → 本机 Bridge → Codex 持久化会话 → 本机操作 → 文字或附件结果 → 普通微信。Desktop 侧栏应能发现会话并查看历史。

“对齐”是上游功能与行为对齐，不表示逐字节零修改。下列差异是已经实测所必需的兼容补丁，应与产品扩展分开管理。

## 兼容差异

| 文件 | 差异及目的 |
| --- | --- |
| `src/cli/ilink.ts` | 命令输出上限增至 16 MiB，增加 30 秒超时，避免本机插件列表超过 1 MiB 时 ENOBUFS |
| `src/windows/desktop-permissions.ts` | 状态文件上限增至 16 MiB，适配本机约 1.18 MB 的 Desktop 状态 |
| `src/windows/desktop-projects.ts` | 同步调整项目状态容量上限 |
| `src/codex/codex-runtime.ts` | 对操作系统确认是同目录的 cwd 使用规范路径，修复商店版路径别名导致的附件误拒绝；不改变权限或放宽附件边界 |
| `tests/cli.test.ts` | 大插件输出回归测试 |
| `tests/desktop-permissions.test.ts` | 大状态读取与超限拒绝测试 |
| `tests/codex-runtime.test.ts` | 恢复会话后规范 cwd 传递回归测试 |
| `tests/fixtures/fake-codex-runtime.mjs` | 支持上述回归测试的测试进程参数 |

上述 8 个文件是第一版兼容补丁基线。当前工作版本另有本项目多微信扩展，涉及账号模块、SQLite 状态命名空间、宿主、CLI 和 Guard 脚本，不再声称 vendor 仅有这 8 处差异。实现与验证见 [多微信说明](multi-wechat-implementation.md)。根目录 README、NOTICE、启动脚本和项目文档属于本项目维护内容，上游原始 README 保留在 vendor 内。

后续本项目扩展还包括完整回复交付，以及第二版通道身份配置、原生身份注入/恢复、模型默认值、历史工具和配置命令，分别见 [回复交付](reply-delivery-implementation.md) 与 [第二版实现](v2-channel-profile-implementation.md)。这些属于固定上游之上的项目改造，未声称来自原作者；上游许可和来源保留。

## 已有实机证据

迁移前的评估副本使用 Node.js `24.14.0`、Codex CLI `0.162.0-alpha.17.2`：

- 类型检查通过，518 项测试全部通过。
- 普通微信扫码绑定成功；真实消息进入 Codex 并返回回复。
- “微信主会话”已在 Desktop 的 Tasks 列表出现，历史工具可读取完整对话。
- G 盘测试文件复制到 C 盘任务目录，SHA-256 一致，send_file 登记及接口投递成功；用户确认附件收到且能打开。
- 主会话 ID：`01a1458a-2b6b-73e1-bf20-fd6fc8c4451d`。
- 文件成功回传 turn：`01a1458e-428c-7991-b633-07826e00f39a`。

迁入本仓库后再次完成类型检查和 518 项测试，166 个导入文件与已验收副本逐项 SHA-256 一致。Bridge 已从 `vendor/codex-ilink/src/cli/main.ts` 启动并保持运行；原仓库外评估目录已迁入忽略目录 `.local/legacy-evaluation`，仅作可恢复备份。当前运行不依赖该备份。

兼容改动的统一补丁另存于 [codex-ilink-compatibility.patch](codex-ilink-compatibility.patch)，相对于上述固定上游提交生成。

微信凭据、运行状态与用户会话不随源码导入；沿用当前用户的私有状态目录。文件中的路径、ID 是本机验收证据，不是其他电脑的默认配置。

## 后续推进顺序

以下保留第一版基线的推进记录；当前产品阶段为第二版，部署流程、完整指令和功能状态见 [第二版手册](v2-user-guide.md) 与根README，不再按第一版目标理解当前版本。

1. 完成本仓库内运行迁移，复用既有绑定与会话，确认不再依赖仓库外评估副本。
2. Guard 已安装并确认 Trusted，真实 CLI 回合的冲突拦截与释放后放行已通过；Desktop 图形界面与微信同时输入的完整竞争场景仍待验证。
3. 验收重启恢复、断网重连、取消、审批、长任务通知与失败后不重复执行。
4. 整理可复现的首次安装、扫码、启动、停止和卸载步骤，固化第一版验收清单。
5. 第一版基线稳定后，再单独讨论电脑管家功能扩展与交互优化。

当前已启用当前用户登录自启动，手动触发同一计划任务后的微信往返已通过。按用户要求未重启或注销 Windows，因此实际重新登录触发尚未验证。详情见 [Guard 与启动验收](guard-startup-acceptance.md)。后续项目仍需逐项验收，不能据此视为全部完成。
