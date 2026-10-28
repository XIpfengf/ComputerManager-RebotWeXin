# V1.0.2：通道身份配置使用与验收

当前发布版本为 V1.0.2，包含持续会话和可选历史归档。本文侧重实现及验证边界，部署与全部命令见 [使用手册](user-guide.md)。当前回归与用户反馈统一见 [验收说明](acceptance.md)。

状态：开发与自动化验证完成；最终微信体验由用户验收后确认。无需重新扫码，沿用现有绑定；不重启或注销 Windows。产品要求见 [需求计划](channel-profile-requirements.md)。

## 使用方法

在微信机器人中单独发送以下命令。两个微信各自操作自己的配置，无需传通道别名。

```text
config
config help
config set name 小白狐
config set role 聪明、细心的电脑助手，也能陪我自然聊天
config set address 主人
config set traits ["聪明","有点慵懒","嘴硬心软"]
config set tone 亲近、俏皮，工作时清楚直接
config set intensity 3
config set warmth 4
config set tsundere 2
config set humor 2
config set emoji 1
config set verbosity normal
config set task-persona 1
config models
config set model gpt-6.1-sol
config set effort low
new
st
```

示例身份不会预先写入真实通道。首次初始化为中性“电脑管家”，默认模型和强度继承 Codex。模型目录以本机 `config models` 为准；不要把示例模型视为所有电脑上永远可用。

保存配置仅作用于以后新建的会话。已有会话包括正在执行的任务保持自己的身份快照；`new` 使用最新配置开启空白会话，`clear` 创建替代会话成功后再归档旧会话。两者在当前会话忙碌时均拒绝切换，需等待或明确 `stop`。`compact` 不更新身份，`exit` 返回通道主会话，可能是尚未注入身份的旧会话。

`st` 分别显示已保存版本、新会话默认值、当前身份快照与创建时参数，以及原生接口读取的当前实际模型/强度。现有 `model` / `effort` 仍只改变当前会话，且单独记录审计；不改通道默认配置或其他微信。

| 命令 | 用途 |
| --- | --- |
| `config show` | 完整 JSON，长内容自动分片、不截断 |
| `config set <字段> <值>` | 原子保存单个白名单字段；文本支持空格和换行 |
| `config models` / `config efforts` | 当前可用的完整模型 ID 与支持强度 |
| `config projects` | 列出可用 Desktop 项目和稳定键；不输出绝对路径 |
| `config set workspace inbox` | 无明确项目选择时使用通道 Inbox |
| `config set workspace project:<稳定键>` | 无明确选择时使用此项目；先前 `p<n>` 的明确选择优先 |
| `config set model inherit` / `config set effort inherit` | 恢复继承默认；实际参数在新建时解析并固定 |
| `config reload` | 校验并载入手工编辑的私有文件；不能手工改 revision |
| `config reset` | 获取两分钟内有效的一次确认码；按回复发送 `config reset confirm <码>` |

`address`、`role`、`tone` 可用 JSON 空字符串 `""` 清空；`traits` 使用 JSON 字符串数组。默认模型与明确强度不兼容时整次保存失败，不暗中替换参数。可先将 effort 设为 inherit 再换模型。重置只影响本通道的配置，保留绑定和历史。

永久配置只接受单独发送的固定文字命令。语音转写、带引用或附件的配置文本、普通聊天、模型路由、网页和工具输出不能直接进入永久配置命令入口。正常语音聊天继续沿用现有转写能力。

## 私有配置与实现

会话默认持续保持，取消 30 分钟无活动退出。后台通知不会自动把下一条消息切到其他任务，Bridge 重启后保留选择；`new`、`exit`、`s<n>`、`p<n>`、`clear` 等明确操作维持各自语义。历史归档功能已实现，自动归档默认关闭；没有永久删除，使用方式见 [生命周期方案](session-retention-plan.md)。

私有运行根目录下新增 `profiles/<通道别名>/profile.json` 和 `profile.json.bak`；格式见 [模板](examples/channel-profile.example.json)。这些文件位于仓库之外，不能作为公开源码提交。配置最大 64 KiB，严格检查字段、类型、长度、范围和版本。

同一个原有状态数据库新增四张根级表，不改变原账号命名空间、绑定或租约结构：

| 表 | 内容 |
| --- | --- |
| `channel_profile_revisions` | 通道、修订、完整 JSON、文件哈希、保存时间 |
| `profile_change_intents` | 文件与数据库之间尚待完成的写入意图；完成后移除 |
| `thread_profiles` | 线程归属、完整身份快照、编译版本、指令哈希、实际模型/强度/cwd |
| `thread_model_overrides` | 当前会话模型/强度变更审计，不改创建快照 |

写入先登记意图，再写上一有效版本备份、刷新同目录临时文件并替换，最后提交修订。恢复只接受原文件哈希或候选哈希；遇第三种内容停止，不覆盖手工编辑。文件被外部修改时，普通保存和新会话会拒绝，需核对后 `config reload`；已经存在的会话仍能继续使用自己的快照。

实现模块位于 `vendor/codex-ilink/src/profiles/`。`ChannelProfileService` 负责每通道串行化、命令和新线程工厂，`ProfileStore` 管理私有文件/数据库，`compilePersona` 把角色数据编译成原生 developerInstructions。既有 send_file 指令与工具保留。恢复会话时读取该线程的固定快照，而不是当前最新配置；不改全局 Codex 设置或 AGENTS.md。

新线程通过原生 `thread/start` 指定模型，并使用该接口的 `config.model_reasoning_effort` 指定推理强度，随后核对原生返回值再保存快照和切换绑定。创建请求未知结果时沿用现有“不自动重试创建”行为；没有返回可确认的线程 ID 时不改旧绑定。快照保存失败则尽力归档已返回的未绑定线程。

## 日常聊天、历史和查证

身份强度控制自然表达，不使用固定前后缀装饰。任务时有效身份力度取整体强度与 task-persona 的较小值；错误、风险、权限和结果必须清楚，不能用人设回避工作或假装完成。

信息不足时，先看当前上下文；涉及过去交流时可调用新增动态工具 `channel_history`。该工具列出或读取当前通道拥有的会话，支持 query、cursor 和 archived；只返回用户/助手消息，排除工具输出，不提供其他微信通道记录。历史过长明确提示缩小查询，不能把没查到说成不存在。新会话不会自动拼入旧消息，只有明确涉及历史时才检索。

知识、观点或时效信息不确定时，身份指令要求主动使用现有浏览器/网络工具核实，优先原始来源，区分事实和推断并提供必要链接。检索仍不足、工具不可用或来源矛盾时如实说明并只问必要问题。此处复用 Codex 工具能力，不另建搜索 API，也不声称强制每次模型生成都一定遵循策略；实际对话质量由用户验收。

通道隔离是中间件的配置、路由和历史工具边界，不是操作系统沙箱。两个授权微信仍控制同一台电脑；具有本机文件访问权的工具不能因此被视为多租户安全隔离。

## 验证记录与用户验收

2026-10-17 的 P0 使用隔离线程实际确认 developerInstructions 身份生效、原生模型与强度返回字段、进程重连后持久化及 thread/list 可见；测试线程已归档。随后用实际实现和有效 Guard 租约创建两个测试身份，验证各自标识、更新配置后旧线程保留原快照；真实 channel_history 调用成功读到同通道归档测试会话标识，浏览器查证实际触发并获得官方来源。没有向真实微信发送测试消息，也没有改真实通道身份。原生接口参考 [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)，字段另以当前已安装版本生成的 schema 和实测为准。

自动化覆盖严格校验、双通道文件/快照边界、备份、写入恢复、第三方修改拒绝、模型强度不兼容、稳定项目键、确定性命令、确认码失效、串行保存、new/clear/legacy、语音配置阻断、当前模型审计、历史工具归属，以及长配置发送失败后的完整恢复；同时运行既有长回复、附件、双微信、Guard、取消、审批和启动回归。

类型检查及558项全量测试通过，Guard隔离冲突、原生身份及恢复接口已验证。状态库备份、配置和会话快照保存在私有目录，不作为公开源码。真实微信配置可由各通道独立维护；未为发布重置用户人设或重启Windows。

用户最终验收建议：两个微信各自设置不同名称/语气并 `new`，查看 `st` 和 Desktop 历史；各聊几轮后执行一个无风险文件任务，确认附件；修改配置后确认旧会话保持、新会话改变；提出旧聊天背景及需要查证的知识问题，检查实际来源。完整强度梯度、reset/reload 和任务中操作清单见需求计划第 10 节。用户确认前不标记V1.0.2验收完成。
