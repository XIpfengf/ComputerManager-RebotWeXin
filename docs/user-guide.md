# V1.0.0部署与命令手册

当前发布版本为 V1.0.0，包含多微信、人设配置、会话快照、默认模型/强度、持续会话和可选历史归档。项目版本见根目录 VERSION，发布标签为 v1.0.0；功能以当前源码和机器人help为准。第三方组件版本见NOTICE。

## 1. 部署与运行

一个Windows当前用户下的中间件宿主，共享一个Codex执行核心，为多个扫码微信维护独立通道。使用普通微信，不需要小程序或模拟向Desktop输入框打字。会话历史可以在Codex Desktop查看。

前提为Windows x64、已安装并登录Codex Desktop、Node.js≥22.13、可联网。目标软件/API/工具须另行安装和授权；接入机器人不等于获得管理员权限或所有软件的自动控制能力。

在仓库根目录的PowerShell中准备依赖：

```powershell
Push-Location vendor/codex-ilink
npm install --ignore-scripts --package-lock=false
npm run typecheck
npm test
npm link --ignore-scripts
Pop-Location
```

npm test会先构建；npm link把本仓库构建入口链接为全局ilink，Guard使用它提供的命令。首次环境再执行：

```powershell
.\scripts\ilink.ps1 setup
.\scripts\ilink.ps1 startup enable
.\scripts\ilink.ps1 status
.\scripts\ilink.ps1 doctor
```

按setup提示绑定主微信、安装Guard，并在Codex Hooks入口审核信任。`/hooks`在交互式Codex CLI内输入，不能直接作为PowerShell命令；doctor显示已安装不代表已审核信任。setup/上游启动注册可能覆盖兼容配置，最后用根脚本startup enable重新注册商店版实际路径。已有正常绑定无需重复setup、login或扫码。

这是当前用户登录的后台计划任务，不是系统级Windows Service。关机、注销、休眠时不能正常处理新任务。干净环境首次安装、所有版本组合及Windows重新登录触发仍需按环境验收；不要将已有本机验证扩展为兼容保证。

## 2. PowerShell管理命令

均在仓库根目录运行，不发送给微信。

| 命令 | 用途 |
| --- | --- |
| `.\scripts\ilink.ps1 help` | CLI帮助 |
| `.\scripts\ilink.ps1 status` | 中间件与各微信通道状态 |
| `.\scripts\ilink.ps1 doctor` | 环境、插件、绑定及启动检查 |
| `.\scripts\ilink.ps1 setup` | 首次插件安装、绑定及启动流程 |
| `.\scripts\ilink.ps1 login` | 首次绑定主微信，不无故覆盖已有绑定 |
| `.\scripts\ilink.ps1 login --force` | 主微信授权失效时重新扫码；先stop，再登录，再start |
| `.\scripts\ilink.ps1 start` / `stop` | 启动/停止整个中间件 |
| `.\scripts\ilink.ps1 startup status` | 查看登录自启动 |
| `.\scripts\ilink.ps1 startup enable` / `disable` | 注册兼容启动任务/停用以后登录启动 |
| `.\scripts\ilink.ps1 accounts list` | 查看账号别名 |
| `.\scripts\ilink.ps1 accounts add secondary` | 用第二个微信扫码追加通道，别名不能与已有账号重复 |
| `.\scripts\ilink.ps1 config` | 查看保留的CLI超时设置，不是微信人设配置 |

startup disable不停止当前进程，停当前服务用stop。移动仓库或Codex路径变化后重新注册启动任务；运行中不要删除仓库、dist或依赖。升级应在空闲时停Bridge、保留私有数据、更新依赖并构建测试、检查Guard信任，再注册兼容启动任务并验证微信往返。

旧CLI session-timeout参数不再控制V1.0.0当前会话退出，不能用它恢复30分钟自动退出；away-timeout是离开判定的另一项配置。账号追加后宿主自动加载，不需重启Windows或重扫主微信。primary是原微信，secondary是示例别名。当前没有第二微信原地重登、移除或跨账号共享历史的管理命令；不要用login --force代替追加账号。

## 3. 微信基本指令

每条作为独立文字消息发给机器人，不带斜杠。`<n>`、`<会话ID>`、`<码>`是占位说明，不连尖括号发送，例如p2、s2。

| 命令 | 行为 |
| --- | --- |
| `help` | 查看帮助 |
| `st` | 当前会话、已保存配置、身份快照、实际模型/强度及任务/连接状态 |
| `perm` | 只读查询权限/审批信息，不提升权限 |
| `p` / `p<n>` | 项目列表/选择项目；选择会退出原会话，再用s或new |
| `s` / `s+` | 当前项目/范围会话列表第一页/下一页 |
| `sarc` | 归档会话列表 |
| `s<n>` | 按最新会话列表进入；归档条目进入时恢复 |
| `new` | 使用最新配置创建空白会话；旧会话保留，不自动复制旧消息 |
| `exit` | 返回通道原主会话并取消项目选择；原主会话可能仍是旧身份 |
| `clear` | 成功创建替代会话后归档旧会话；失败保留旧绑定，不是删除全部记忆 |
| `compact` | 压缩上下文，保持线程身份快照 |
| `stop` | 停止当前微信任务，不停止整个中间件 |
| `model` / `model<n>` / `model:<完整ID>` | 列出模型/按编号或完整ID修改当前会话模型 |
| `effort` / `effort<n>` / `effort:<强度>` | 列出强度/按编号或支持标识修改当前会话强度 |
| `y<code>` / `n<code>` | 根据提示批准/拒绝一项实际审批 |
| `ya` / `na` | 先查看批量审批，再按提示带一次确认码确认 |

项目和会话列表编号约10分钟有效，不是永久标识。当前会话持续保持，不因无活动或Bridge重启自动退出，后台通知不夺取当前选择；明确new/exit/s<n>/p<n>/clear仍有各自切换语义。new/clear遇当前任务或排队会拒绝切换，需等待或显式stop。

可直接说“陪我聊聊”，也可要求“查找指定文件，复制到任务目录再发送”。信息不足应主动查授权历史、必要时浏览器查证，不编造已搜索或已执行的结果。模型的具体表达与工具可用性仍需结合实际情况判断。

## 4. 人设和未来会话默认值

| 命令 | 用途 |
| --- | --- |
| `config` / `config help` | 本通道配置概要/帮助 |
| `config show` | 完整JSON，长内容完整分片 |
| `config set <字段> <值>` | 修改一个白名单字段并递增版本 |
| `config models` / `config efforts` | 可用模型/当前选择支持的强度 |
| `config projects` | 项目稳定键，不输出绝对路径 |
| `config reload` | 校验载入手工编辑的私有文件，不能手改revision |
| `config reset` | 获取两分钟内有效的一次重置确认码 |
| `config reset confirm <码>` | 重置本通道配置，保留绑定和历史；修改配置、过期、使用或重启后旧码失效 |

全部白名单字段：

| 字段 | 范围/格式 | 示例 |
| --- | --- | --- |
| `name` | 名称1–40个Unicode码点 | `config set name 小白狐` |
| `role` | 角色描述最多4000码点 | `config set role 负责聊天和电脑任务的私人秘书` |
| `address` | 用户称呼最多40码点 | `config set address 老板` |
| `traits` | JSON数组，最多16项，每项1–64码点 | `config set traits ["聪明","勤奋","理性"]` |
| `intensity` | 整体角色力度0–5，0为中性 | `config set intensity 3` |
| `tone` | 语气描述最多1000码点 | `config set tone 自然亲近，工作时清楚直接` |
| `warmth` / `tsundere` / `humor` / `emoji` | 亲和/傲娇/幽默/表情程度，分别0–5 | `config set warmth 3` |
| `verbosity` | concise / normal / detailed | `config set verbosity normal` |
| `language` | zh-CN / en / auto | `config set language zh-CN` |
| `task-persona` | 工作角色力度0–2，有效值不超过整体力度 | `config set task-persona 1` |
| `model` | 当前可用的完整模型ID或inherit | `config set model gpt-6.1-sol` |
| `effort` | 模型支持的强度或inherit | `config set effort low` |
| `workspace` | inbox或project:<稳定键> | `config set workspace inbox` |

示例模型以config models实际目录为准。inherit保存为JSON null，表示继承适用默认值；实际创建时解析并记录。明确模型和强度不兼容会整次拒绝，可先将effort设为inherit再换模型。workspace项目键从config projects复制，不接受任意路径；明确p<n>选择优先于默认工作目录。scenePolicy当前仅支持auto，不用另设手动聊天/任务模式。

文本支持空格和换行，traits使用英文双引号和方括号；address、role、tone可用JSON空字符串清空，例如 `config set address ""`。未知字段、格式、类型、长度或版本不符合要求会拒绝；见 [配置模板](examples/channel-profile.example.json)。

**默认配置绑定微信通道，每个会话固定使用创建时快照。** 保存后发new或clear才让新/替代线程使用最新配置；旧线程和归档恢复沿用原快照，compact不升级身份。model/effort改当前会话，config set model/effort改未来默认值。人设不会提升权限或替代真实执行证据。

config/history只接受明确独立的文字管理命令；语音转写、引用、附件、网页、工具输出及自然语言路由不能进入永久配置入口。普通语音聊天仍可使用微信转写。

## 5. 历史归档

| 命令 | 用途 |
| --- | --- |
| `history help` / `history policy` | 帮助/规则、开关和最近扫描摘要 |
| `history preview` | 只读预览候选与排除理由 |
| `history enable` / `history disable` | 开启/关闭每日自动扫描归档，默认关闭 |
| `history archive` | 预览并产生本批次两分钟一次确认码 |
| `history archive confirm <码>` | 重新检查，仅归档本次已预览且仍符合条件的候选 |
| `history pin <会话ID>` / `history unpin <会话ID>` | 固定保留/取消中间件固定标记 |
| `history restore <会话ID>` | 恢复归档、保留身份、不切换当前选择；再用s/s<n>进入 |
| `history reconcile` | 对账接口结果未知的操作，不盲目重发 |

固定规则为30天无可靠消息活动、至少保留最近20个未归档会话。仅处理归属明确的本通道托管线程，排除当前、主、固定、执行/排队/审批、租约和待交付会话；时间或状态不明则保留。enable表示授权按规则每日执行，不会每天再次确认；只想查看请用preview。

归档收起旧线程，完整历史与身份快照保留、可恢复，不等于释放记录空间。没有永久删除或自动裁减人设修订命令。实现与保护边界见 [历史策略](session-retention-plan.md)。

## 6. 文件、长回复与维护边界

跨盘文件先按授权查找，再复制到当前任务实际cwd，通过send_file或最终回复中的合法本机Markdown文件链接发送。目录外、缺失或校验失败会提示；普通路径/代码示例不触发外发，网页URL不自动下载。send_file最多2个显式登记附件；合法文件链接无该条数配额、会去重，单文件最大100 MB。不同媒体和大文件仍需分别验证。

正文按每条2000 UTF-8字节以内完整分片，不设最终条数上限；交付状态持久化并支持失败重试。约两分钟未完成有等待提醒，可st查看或stop停止；提醒不是卡死诊断，也不承诺断网或登录失效时即时送达。

排查从PowerShell的status、doctor和startup status开始。私有目录通常为%LOCALAPPDATA%\Codex_iLink；商店版可能重定向至应用包LocalCache下，根启动脚本复用已绑定state.sqlite的实际路径。人设保存在profiles/<别名>/profile.json，状态库另存修订、快照和归档策略；完整聊天由Codex用户目录保存。具体见 [目录说明](directory-layout.md)。凭据、真实人设、数据库和原始日志不能作为公开源码提交。

当前验证和未覆盖范围统一见 [验收说明](acceptance.md)，文档更新职责见 [文档职责](documentation-map.md)。

## 7. 桌面操作与跨会话委派

可以直接描述已授权的桌面操作；窗口可读和任务成功须以实际工具结果为准，不能凭进程存在推断完成。失败时先检查工具配置与连接，见 [Computer Use 通道](computer-use-channel.md)。

委派示例：`告诉「会话准确名称」，检查指定任务并把最终结果返回给我。` 管家不切换自身会话，由目标沿用自己的上下文、模型与权限。`查询委派列表`、`查询委派 <编号> 的状态`、`取消尚未投递的委派 <编号>` 用于跟踪。忙碌时排队，不打断；名称不唯一时需补充名称或 ID。已执行任务不能用取消队列命令停止。

其他微信共享未分配 Desktop 会话须由部署者在私有 `delegation-permissions.json` 按 ID 授权，不能抢占其他通道的明确归属。结果以文本回传，委派附件尚未实现。完整授权结构、状态和恢复规则见 [微信跨会话委派](session-delegation.md)。
