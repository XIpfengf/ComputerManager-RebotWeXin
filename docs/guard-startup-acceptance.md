# Guard 与当前用户登录启动验收

日期：2026-10-17。按用户要求，不重启或注销 Windows。

## Guard

- 通过 npm link 将 ilink 命令连接到本仓库 vendor/codex-ilink 的构建产物，安装并启用 codex-ilink-probe@codex-ilink，版本 0.1.5。
- 在真实 Codex CLI 交互终端中进入 /hooks，逐项观察 SessionStart、UserPromptSubmit、PermissionRequest 及两条 Stop Hook：均启用，Trust 为 Trusted。没有使用绕过信任参数，也没有手工编辑信任存储。
- 47 项 Hook、租约、事件接收与启动专项测试全部通过。
- 通过已安装 ilink 命令和隔离 SQLite 验证：Bridge 占用时阻止 Desktop 回合、释放后放行、Desktop 再次占用时阻止另一回合。此项属于直接命令测试。
- 真实 Codex CLI 验收会话：<本机验收编号已脱敏>。仅向该测试会话设置临时租约；提交后实际 Hook 返回 CODEX_ILINK_THREAD_BUSY，模型没有生成回复；随后精确释放该测试租约，再提交得到 GUARD_RELEASE_OK。未改动其他会话的租约。
- 这是实际 CLI 信任与事件执行链路验收；没有模拟在 Desktop 图形界面和微信同时输入的全部竞争场景，也没有触发实际高风险命令审批。

## 当前用户登录启动

- 计划任务：Codex iLink Bridge。
- 当前用户登录时触发，Interactive、Limited，隐藏运行，IgnoreNew，失败后最多重试 3 次、间隔 1 分钟，无固定运行时长上限。
- 已手动触发同一计划任务，任务进入 Running，Bridge 状态为 running；任务运行中返回码 267009 表示仍在执行，不是完成退出码。
- 不需要重新扫码，复用已绑定微信状态和已有会话。

上游直接启动在本机最初失败：计划任务不在 Codex 商店版的文件虚拟化环境中，读到了普通 LocalAppData 下的空状态库。已通过独立计划任务诊断确认：普通目录无绑定，而实际绑定文件位于应用包 LocalCache。诊断任务已移除。

初次启动路径适配放在根 scripts 内；下列说明属于该阶段，后续执行器修复同时涉及 vendor 宿主：

- register-startup.mjs 对已绑定 state.sqlite 文件做 realpath，不能只规范化父目录；将实际目录和 Codex 可执行路径传给启动包装器。
- startup-bridge.mjs 只为计划任务子进程明确设置 LOCALAPPDATA 和 CODEX_ILINK_CODEX_EXE，再运行上游 __run；不修改系统或用户注册表环境变量。
- 仍复用上游隐藏 VBS 和任务注册设置；不新增系统级 Windows Service。
- scripts/ilink.ps1 startup enable 使用这个兼容注册入口。不要直接用上游 ilink startup enable 覆盖它；若执行上游 setup，应再运行根脚本重新注册。
- 计划任务启动日志写入实际用户私有状态目录 logs/startup.log，不写进 Git。

2026-10-19 补充：Desktop 更新可能保留被旧进程占用的 `codex.exe`，同时清理同目录的工具执行器。标准 Desktop 缓存的候选目录现在必须同时含有 `codex.exe`、`codex-code-mode-host.exe` 和 `codex-command-runner.exe`。旧任务中的缓存路径失效时从同一缓存根目录重新选择完整运行时，兼容 MSIX 状态目录与程序目录不同的情况；原路径已被删除也不在包装器入口提前退出。状态库仍固定到原有绑定位置。

常驻执行连接在创建新会话、识别控制意图或提交新回合前检查运行时路径。若需要更新且当前没有活动任务，则重建连接、恢复所需会话，再提交本轮输入；其他任务仍在运行时保留原连接，明确提示本轮未创建任务，待任务结束后再发送。不会自动重新执行已失败或结果未知的任务。Desktop 更新后已在执行中的旧进程不会被强行替换，其任务仍可能需要用户检查结果。

此项修复通过类型检查及 567 项测试，覆盖缓存残留、MSIX 重定向、空闲更新和活动任务保护；独立新运行时已验证真实 PowerShell 工具执行。2026-10-19 15:41 经用户授权，在两个通道无活动任务后重启中间件；核对实际子进程路径，执行与观察连接均使用完整的新缓存目录，两个微信通道均为 running。未重启 Windows；这是当次加载记录，后续微信反馈和当前结论统一见 [验收说明](acceptance.md)，不能以独立进程检查替代手机端验证。

## 验收边界

当前已验证任务注册、当前登录下手动触发、后台运行及 Guard 信任/拦截。计划任务启动后，微信新消息 STARTUP_GUARD_OK 进入既有主会话，Codex 返回“收到，启动守卫验收信号已确认。”；对应回合 <本机验收编号已脱敏> 已完成，最终消息投递状态为 confirmed，用户明确确认已发送并收到回复。测试临时租约已清理。

此前手动启动方式的文字、历史、跨盘附件链路已通过；本轮未重复发送跨盘附件。

Windows 重启、注销再登录后的实际触发验收按用户要求跳过，不能标为已验证。Codex 更新后若可执行路径改变，应重新运行根脚本 startup enable 刷新注册。
