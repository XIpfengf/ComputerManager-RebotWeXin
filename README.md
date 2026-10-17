# ComputerManager-RebotWeXin · 第二版（V2）

通过普通微信与电脑管家对话：既能日常聊天、讨论知识和技术方案，也能让部署在本机的 Codex 查找文件、调用已授权软件与工具，并把结果发回微信。

**当前为第二版功能版本：一个本机中间件实例、多个微信独立通道、每通道独立人设与新会话默认参数、持续会话，以及可选的历史归档。** V2 是本项目的产品阶段名称；vendor 保留上游包版本 `0.1.0-rc.5`，不表示上游已发布同名 V2。

本项目基于 [Obito-404/Codex_iLink](https://github.com/Obito-404/Codex_iLink) 改造。架构为普通微信 ↔ 本机 Bridge ↔ Codex App Server，不是微信小程序，也不依赖模拟向 Desktop 输入框打字。各会话可在 Codex Desktop 查看历史。

## 第二版有哪些功能

| 能力 | 当前行为 |
| --- | --- |
| 多微信接入 | 同一个本机服务绑定多个微信，各自维护主会话、导航、审批、收发与附件上下文；控制同一台电脑 |
| 独立人设 | 名称、角色、称呼、特征、亲和/傲娇/幽默/表情程度、详略及任务语气力度可调整 |
| 会话身份快照 | 默认人设属于微信通道；每个会话固定使用创建时版本，改配置不会改写旧会话 |
| 模型与强度 | 可分别修改当前会话参数和未来新会话默认值，按本机实际可用模型校验 |
| 日常聊天与电脑任务 | 自动理解聊天、方案讨论和操作请求；遇信息不足，应查授权历史并用现有浏览器能力核实，必要时说明来源与限制 |
| 持续会话 | 无活动不自动退出，Bridge 重启保留选择；后台结果通知不抢占当前会话 |
| 文件交付 | 可搜索有权限访问的文件；任务目录内文件可通过 send_file 或最终回复中的本机文件链接交付 |
| 长回复 | 单条超过 2,000 UTF-8 字节后完整分片，不限制最终条数；交付状态持久化，支持失败后重试 |
| 任务控制 | 状态、取消、压缩、项目/会话导航和实际审批；耗时任务有等待提醒 |
| 历史归档 | 默认关闭；用户启用后每天检查30天未活动的托管会话，至少保留最近20个；当前/主/固定/忙碌/待交付会话受保护 |
| 登录自启动 | Windows 当前用户登录后的后台计划任务；不是系统级 Windows Service |

归档不是删除：历史与身份快照保留，可恢复；不等于释放聊天记录占用。当前不提供永久删除历史、自动裁减身份版本、多电脑统一管理、第二微信原地重登/移除命令。

## 部署与运行

支持范围为 Windows x64；需要已安装并登录 Codex Desktop，以及 Node.js ≥22.13。本机验证过 Node.js 24.14。新环境的完整安装体验尚未全部验收，不应视为全平台稳定发行。

以下 PowerShell 命令均在仓库根目录执行，安装依赖并构建：

```powershell
Push-Location vendor/codex-ilink
npm install --ignore-scripts --package-lock=false
npm run typecheck
npm test
npm link --ignore-scripts
Pop-Location
```

首次部署再执行 setup，根据提示绑定微信、安装 Guard 并审核信任；已有正常绑定的电脑不要重复扫码：

```powershell
.\scripts\ilink.ps1 setup
.\scripts\ilink.ps1 startup enable
.\scripts\ilink.ps1 status
.\scripts\ilink.ps1 doctor
```

setup 或上游启动注册可能覆盖兼容配置，因此最后用根脚本 `startup enable` 重新注册商店版路径适配。`/hooks` 是交互式 Codex CLI 内的入口，不能直接在 PowerShell 输入。Guard 显示已安装不等于已审核信任，详见 [Guard 与启动说明](docs/guard-startup-acceptance.md)。

日常管理与追加微信：

```powershell
.\scripts\ilink.ps1 start
.\scripts\ilink.ps1 stop
.\scripts\ilink.ps1 startup status
.\scripts\ilink.ps1 startup disable
.\scripts\ilink.ps1 accounts list
.\scripts\ilink.ps1 accounts add secondary
```

`accounts add` 为新增微信提供独立扫码，不替换原绑定。主微信授权确实失效时才在停止 Bridge 后使用 `login --force`。启动、停止、更新与账号管理的完整说明见 [第二版部署与命令手册](docs/v2-user-guide.md)。

电脑需开机、联网并保持该 Windows 用户会话；关机、注销或休眠期间无法正常处理新任务。不要移动运行中的仓库；移动目录或 Codex 路径改变后需重新注册启动任务。

## 部署后最常用的微信指令

这些是直接发给机器人的文字消息，不带 `/`；每条独立发送。PowerShell 中的管理命令与下表不是同一入口。

| 目的 | 微信命令 |
| --- | --- |
| 帮助、当前状态、权限查询 | `help`、`st`、`perm` |
| 项目列表与选择 | `p`、`p2`（选择第2项） |
| 会话列表、下一页、归档列表、进入 | `s`、`s+`、`sarc`、`s2` |
| 新建空白会话 / 回到原主会话 | `new` / `exit` |
| 替换当前会话并归档旧会话 / 压缩上下文 | `clear` / `compact` |
| 中断当前任务 | `stop` |
| 查看/调整当前会话模型与强度 | `model`、`model2`、`effort`、`effort2`；编号按最新列表选择 |
| 当前通道人设与默认设置 | `config`、`config help`、`config show` |
| 设置名字、语气、角色力度 | `config set name 小白狐`、`config set tone 亲近自然，工作时清楚直接`、`config set intensity 3` |
| 查询与设置未来默认模型 | `config models`、`config set model <完整模型ID>`、`config set effort <强度>` |
| 查看归档策略 / 只读预览 | `history policy` / `history preview` |
| 开启/关闭本通道自动归档 | `history enable` / `history disable` |
| 实际审批 | 根据机器人提示发送 `y<code>` / `n<code>`，批量审批使用提示给出的确认码 |

**保存 config 后发送 new，新配置才作用于新会话。** 已有会话保留旧快照；`model` / `effort` 改当前会话，`config set model` / `config set effort` 改未来默认值。`null` 表示继承默认，不表示没有模型。

`clear` 不适合日常续聊，它会换成空白会话并归档旧会话；`new` 与 `clear` 在当前会话忙碌时会拒绝切换，需等待或显式 stop。微信 stop 只停止当前任务，PowerShell 的 stop 则停止整个中间件。

全部配置字段、固定保留/恢复、确认码、工作目录和命令示例见 [第二版部署与命令手册](docs/v2-user-guide.md)。

## 文件、权限与数据边界

- 文件可以从其他盘符查找，但发送前需复制到当前任务实际工作目录，并具有相应读写权限。任意盘符路径不能直接作为 send_file 的发送授权。
- send_file 保留最多2个显式登记附件的规则；最终回复中的合法本机文件链接不受该条数配额限制，会去重；单文件最大100 MB。网页链接保留为链接，不自动下载；普通路径文本与代码示例不会触发外发。
- 语音在微信提供文字转写时按文本处理，没有独立音频识别引擎。config/history 管理命令需单独发送文字，不能靠语音转写、引用或附件变更永久配置。
- 新会话权限跟随创建时 Desktop 的选择，perm 只查询，不提升权限。实际软件/API/界面操作能力取决于已安装工具和运行账号授权，不保证所有软件都可自动操作。
- 多微信共享同一 Windows 用户、Codex 登录和文件系统；通道隔离不是操作系统沙箱，同时修改同一文件仍可能冲突。
- 程序、依赖在仓库；绑定、人设 JSON、状态库、任务文件和日志位于当前用户私有目录；完整对话由 Codex 保存。具体关系见 [目录结构](docs/directory-layout.md)。不将凭据、真实人设或聊天记录推送到仓库。

## 验证状态与文档导航

第二版功能已实现并部署到本机。最近一轮源码验证为类型检查及 **558 项测试通过，0失败、0跳过**；本次文档更新不表示重新运行了这些测试。真实隔离会话验证过原生身份、模型/强度、重连快照、授权历史、浏览器查证及归档/恢复接口。普通微信收发、双微信、长回复和附件已有用户实测反馈。

生产两微信的自动归档默认关闭，未为验收归档或删除真实微信历史。Windows 重启/注销触发、真实跨30天归档调度、完整拟人化梯度及所有软件/媒体/网络边界尚不能视为全部实机验收通过。第一版的518项、长回复阶段的531项等数字是历史记录，不是第二版当前测试总数。

| 文档 | 用途 |
| --- | --- |
| [第二版部署与命令手册](docs/v2-user-guide.md) | 部署后的使用入口与完整命令 |
| [第二版实现与验证](docs/v2-channel-profile-implementation.md) | 配置、身份快照、实现边界 |
| [第二版需求计划](docs/v2-channel-profile-requirements.md) | 原始需求与验收标准 |
| [持续会话与历史归档](docs/session-retention-plan.md) | 归档规则、命令与不删除边界 |
| [多微信实现](docs/multi-wechat-implementation.md) | 账号路由、绑定及隔离 |
| [回复交付](docs/reply-delivery-implementation.md) | 长回复与文件交付 |
| [目录结构](docs/directory-layout.md) | 代码、私有配置与运行数据 |
| [第一版验收记录](docs/v1-acceptance.md) | 历史基线记录 |

## 上游与许可

| 项目 | 内容 |
| --- | --- |
| 来源 | Obito-404/Codex_iLink |
| 固定上游提交 | `081526ee91d6eaa469cc13405e73b9a73f652810` |
| 保留的上游包版本 | `0.1.0-rc.5` |
| 许可 | MIT，Copyright (c) 2026 Obito，见 [NOTICE](NOTICE) 和 [许可证](vendor/codex-ilink/LICENSE) |
| 本项目改造 | Windows兼容、多微信、完整回复交付、V2人设/快照/默认参数、持续会话与历史归档 |

上游原始 README 保留在 [vendor](vendor/codex-ilink/README.md)，差异沿革见 [上游基线](docs/upstream-baseline.md)。本项目独立维护，不代表上游作者、腾讯或 OpenAI 的官方产品。源码维护在远端 develop；私有运行数据不随代码推送。
