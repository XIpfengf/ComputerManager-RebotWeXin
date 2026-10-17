# 同一本机服务绑定两个微信：可行性研究

日期：2026-10-17。范围仅为研究与验收方案，不修改实现、不扫码、不更改既有绑定、不重启 Bridge。

## 结论与依据

可以在当前架构基础上实现“一个本机服务、两个微信入口、两套独立 Codex 会话”。这是有一手资料支持的设计可行性结论，不是本项目已经支持或双账号实测通过。

腾讯官方插件明确支持一个 OpenClaw Gateway 同时连接多个微信账号；为每个账号重复扫码登录，并建议按账号、渠道和对端隔离会话。因此底层渠道存在可参考的多账号实现，当前 Codex_iLink 的单账号限制不应直接推断为微信协议只能单账号。[官方多账号说明](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md#多账号)

协议扫码确认包含 bot 身份、token 和扫码用户标识；收发依赖对应连接和上下文。目标应为分别授权两个渠道连接，不能假设 A 的 Bot/token 可以接收 B 的消息，也不能把登录二维码当公开邀请二维码。[官方协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)

第二个实际微信是否具备同样接入资格、扫码后服务端是否同时保留两套有效连接，仍需真实账号验证；官方支持与当前账号可用性是两种证据。

进一步核对官方源码（以下 main 链接会随上游更新，以本研究日期为准）：

- [accounts.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/accounts.ts#L63-L110)：账号登记追加到集合；每个账号文件保存自己的 token/baseUrl/userId，旧账号清理针对相同 userId，不整体删除其他微信。
- [login-qr.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts#L451-L473)：扫码确认分别提取 bot_token、ilink_bot_id、ilink_user_id。
- [monitor.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/monitor/monitor.ts#L70-L100)：按 accountId 使用同步游标文件，并使用对应 token 拉取消息。
- [inbound.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/inbound.ts#L18-L36)：回复上下文按 accountId/userId 组合保存。
- [process-message.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/process-message.ts#L238-L263)：通过 channel/accountId/direct peer 决定会话路由。
- [channel.ts](https://github.com/Tencent/openclaw-weixin/blob/main/src/channel.ts)：按账号启动 monitor，出站选择对应账号；存在上下文歧义时不猜测目标。

这些是可以借鉴的机制，不表示本项目应整体替换为 OpenClaw，也不表示原样复制即可兼容 Codex 的 Guard 与任务恢复。

## 当前代码限制

以下结论来自本仓库固定上游及已有兼容补丁，可通过相对链接复核：

| 位置 | 当前行为 | 多账号需要改变的部分 |
| --- | --- | --- |
| [初始 schema](../vendor/codex-ilink/src/bridge/migrations/001-initial.sql) | controller、ilink_session、bindings、bridge_settings 使用 singleton=1 | 账号集合及账号范围内的绑定、主线程、项目选择 |
| [状态访问](../vendor/codex-ilink/src/bridge/sqlite-state.ts) | bindController 拒绝另一控制者；replaceILinkBinding 换绑时删除原连接队列、Outbox 等 | 添加账号不能走全局替换；更新/删除只影响目标账号，提供迁移与回退 |
| [扫码流程](../vendor/codex-ilink/src/cli/login-flow.ts) | 保存一个 controller/session，replaceExistingBinding 表示替换 | 增加明确的“添加账号”流程，原微信状态保留 |
| [消息校验](../vendor/codex-ilink/src/bridge/inbound-message.ts) | 只接收当前 controllerUserId；群聊忽略 | 保留校验，但对每条连接校验其所属控制者，不放开任意发信人 |
| [Windows 宿主](../vendor/codex-ilink/src/windows/host.ts) | 一个常驻宿主、一个 session、一个 Daemon，统一 Hook 接收 | 一个宿主管理两个连接的轮询、退避、生命周期与消息分发 |
| [Daemon](../vendor/codex-ilink/src/daemon/bridge-daemon.ts) | 一个 session/mainThreadId，单套通知处理 | 按账号建立会话上下文、主线程和独立恢复状态，集中分配 Hook 通知 |
| [Bridge](../vendor/codex-ilink/src/bridge/bridge.ts) | 回执发给当前 session 的用户，单套导航和路由 | 请求、响应、审批、队列和附件全程携带账号归属 |
| [列表快照 schema](../vendor/codex-ilink/src/bridge/migrations/002-list-snapshots.sql) | 项目/会话列表只按 kind 保存 | 按账号隔离列表编号，避免 A 的 s2 选择 B 刚列出的任务 |

部分基础已可复用：入站去重键包含 account/controller/message，游标按 account 保存，执行按 thread 路由，租约按 thread 仲裁。Outbox 虽保存目标用户，发送仍必须选择正确 token、baseUrl 与 context_token，不能只依赖 target_user_id。

## 推荐结构

保留一个 Windows 登录任务、一个本机宿主和一个 Guard 接收/租约协调层；在其内部建立多个账号上下文。每个账号有独立 token、bot 标识、controller、轮询游标/退避、主线程、当前项目和任务、队列、通知路由及媒体目录。账号范围统一采用内部稳定的 channelAccountId，并保留来源 bot/user 校验。

两个入口都指向部署这一个服务的电脑：

```text
微信 A → 连接 A → 主会话 A / 任务 A ┐
                                  ├→ 同一本机宿主 → Codex → 当前电脑
微信 B → 连接 B → 主会话 B / 任务 B ┘
```

优先使用一个数据库及带账号范围的状态访问层，统一管理迁移、事务与租约；不是为每个账号复制整个服务进程。具体实现前确认哪些表按账号、哪些按线程、哪些属于机器全局，逐项列出迁移映射。所有账号共享 Codex 用户登录和机器权限边界，不承诺独立计费或操作系统隔离。

### 会话、工具与通知

- 默认给 A/B 各自创建主线程与 Inbox 子目录；各自 new、clear、exit、model、effort、stop 只影响自身上下文。
- 记录线程来源/所属账号。项目文件可以共同访问，但微信任务列表默认隔离；导入 Desktop 已有任务时明确归属或显式共享，不能仅靠两条默认主线程宣称完整隔离。
- 审批短码需关联账号、线程、回合与请求；A 的审批回复不能批准 B 的请求。取消仅作用于自己当前微信回合。
- 附件暂存、清理、出站意图和 Outbox 必须绑定来源账号和线程，重试、重新登录后不能换收件人。
- Hook 事件先由统一层识别归属，再交给目标账号；无归属的 Desktop 任务默认不广播给两个微信。一个全局监听器不能将同一事件交给两个 Daemon 各自推送。
- 同线程仍由统一 Guard 拦截并发；不同线程也可能操作同一真实文件，线程隔离不等于文件互斥。需要对明确的写入目标/独占软件任务采用共享资源队列；对无法解析的任意工具行为，不能承诺自动识别所有冲突。
- 两个账号都可接收任务；首轮可采用统一执行队列以减少本机写入竞争。允许不同线程并行时另验 Codex 运行时、事件归属、共享工具与文件冲突，不默认承诺任意任务安全并行。

### 本机管理

新增账号列表、添加、重新登录、移除和连接状态管理。账号标识采用本机别名，凭据仍保护在用户私有状态目录。旧登录操作保留兼容行为，但不得把“添加”解释为“替换”。自启动一次加载所有已授权账号；某个账号登录失效、断网或退避不能阻塞另一个。

“再启动一套原程序/改 LOCALAPPDATA”不作为正式方案：现有单例控制、Hook、租约及通知归属仍需协调，复制进程也不是用户要求的同一个中间件。

## 实现后的验收方案

目前只制定方案，不执行扫码或修改。实现后按下面的顺序验证，失败即保留已工作的 A 账号并回退新增部分。

| 步骤 | 验证动作 | 通过标准 |
| --- | --- | --- |
| 自动化隔离 | 同 message_id、同列表编号、同审批短码模拟双账号；覆盖迁移、重试、换绑、清理 | 不串消息、不跨账号操作；老版本单账号数据可迁移 |
| 真实绑定 | 保留 A，由 B 扫新增账号专用码 | 两套连接同时有效，A 无需重新绑定；失败不替换 A |
| 独立上下文 | A/B 分别发送不同标记并续聊 | 不同 thread_id、历史正确、回复只回原账号，Desktop 可见两套历史 |
| 控制隔离 | A 等待任务时 B 发任务；分别 stop/new/model 等 | 控制范围正确，使用队列时明确告知排队，不把 B 绑到 A 线程 |
| 双向文件 | 分别用无隐私测试文件，跨盘复制到各自 cwd 后发送 | A/B 各收自己的附件，哈希匹配，清理不影响另一任务 |
| 审批与通知 | 两个独立测试任务产生审批/完成通知 | 无串批、无重复广播、通知回复进入原任务 |
| 异常恢复 | 只让 B 的连接失效/超时，再空闲重启 Bridge | A 保持可用；两套游标、Outbox、线程归属恢复，不重复执行未知提交 |
| 同线程与资源 | 显式共享测试线程及可恢复测试文件 | 同线程只有一个执行者；文件写入冲突按明确策略排队或提示 |

自动化可以证明本机逻辑，真实扫码和微信收件才证明渠道生效。无需重启 Windows 即可验收主要链路；新增 B 必须由用户用第二个微信完成扫码。第二账号不同于公共机器人分享，本研究不包含任意第三方自由加入。

## 工作量与决定

属于中等偏大的结构改动：数据库、宿主、路由、审批/通知和恢复都涉及，不能作为白名单小补丁处理。建议下一步先批准双账号最小范围，再分阶段开发：账号存储迁移 → 双连接与独立主线程 → 归属与恢复 → 实机扫码/双向消息/文件 → 审批通知与竞争。未开发前不承诺通过，也不要求用户先换绑。
