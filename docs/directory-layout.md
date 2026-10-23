# 仓库与本机目录

仓库根目录由部署者自行选择，下文以 `<仓库根目录>` 表示。远端为 `XIpfengf/ComputerManager-RebotWeXin`。服务运行时依赖所选目录，切换分支后不要删除或移动它。

## 纳入 Git 的内容

```text
ComputerManager-RebotWeXin/
├── README.md                 项目概览与文档入口
├── NOTICE                    上游来源、固定提交和许可声明
├── .gitignore                本机状态与生成文件排除规则
├── .gitattributes            保留上游已有空白与补丁格式的检查规则
├── docs/
│   ├── documentation-map.md  文档职责与同步规则
│   ├── session-delegation.md 跨会话委派契约与权限
│   ├── computer-use-channel.md 桌面控制链路与边界
│   ├── directory-layout.md   目录与本机部署关系
│   ├── upstream-baseline.md  固定上游及兼容差异
│   ├── codex-ilink-compatibility.patch
│   ├── guard-startup-acceptance.md
│   ├── acceptance.md       V1.0.0验收结果及限制
│   ├── user-guide.md      当前V1.0.0部署流程与完整命令
│   ├── channel-profile-requirements.md   V1.0.0设计和验收标准
│   ├── channel-profile-implementation.md V1.0.0使用与验证
│   ├── session-retention-plan.md 持续会话、历史归档规则及命令
│   └── examples/channel-profile.example.json 中性身份模板
├── scripts/
│   ├── ilink.ps1             日常管理入口
│   ├── register-startup.mjs  商店版状态路径适配及任务注册
│   ├── startup-bridge.mjs    计划任务启动包装器
│   └── verify-guard.mjs      隔离租约验收，不更改其他会话
└── vendor/codex-ilink/
    ├── src/                  上游 Bridge、Codex、微信与 Windows 实现
    ├── plugins/              Guard 定义与命令
    ├── tests/                自动化测试
    ├── scripts/              上游构建和发行工具
    ├── docs/                 上游原始文档
    ├── .agents/              上游插件市场定义
    ├── .github/              保留上游工作流源码，不在本仓库根执行
    └── LICENSE、README.md、package.json、pnpm-lock.yaml 等
```

vendor 是固定版本源码导入，不是 Git 子模块，也不含嵌套 `.git`。本项目入口和本机兼容包装器在根目录维护；原有 8 个兼容差异见基线文档，后续多微信扩展见多微信实现说明。

## 仅保留本机，不推送

| 位置 | 用途 |
| --- | --- |
| `.local/legacy-evaluation/` | 已迁入仓库目录的旧评估副本，可恢复备份；当前运行不依赖它 |
| `.local/guard-acceptance/`、`.local/*probe*` | 隔离验收库与诊断结果，可能包含本机信息 |
| `.local/*tests.log` | 本机测试日志，不随源码发布 |
| `vendor/codex-ilink/node_modules/` | 本机安装的依赖 |
| `vendor/codex-ilink/dist/` | 构建输出；全局 ilink 链接和隐藏启动宿主依赖此目录，不能在运行中清理 |
| 其他 `*.log` | 本机日志 |

## 仓库之外的运行状态

- 逻辑目录：`%LOCALAPPDATA%\Codex_iLink`，含绑定、SQLite 状态、Inbox、媒体与日志。
- 商店版 Codex 实际目录：`%LOCALAPPDATA%\Packages\<Codex包标识>\LocalCache\Local\Codex_iLink`。本机启动脚本通过已绑定 `state.sqlite` 文件的真实路径定位，不只解析父目录。
- Codex 用户设置、会话历史和插件由用户的 Codex 数据目录维护，不随本仓库推送。
- 全局 `ilink` 命令通过 npm link 指向本仓库的构建输出。
- 多微信扩展在同一个状态数据库中保存账号登记、线程归属与账号范围状态；新增账号的 Inbox/媒体位于私有 `accounts/<别名>/` 子目录。
- V1.0.0配置位于同一私有根目录的 `profiles/<别名>/profile.json`（以及 `.bak`），修订、恢复意图、线程快照与模型变更审计保存在原状态数据库；不随仓库上传。
- 历史归档策略、固定标记和操作记录也保存在原状态库；自动归档按微信通道独立控制、默认关闭，不删除 Codex 原始历史或用户文件。
- Windows 计划任务 `Codex iLink Bridge` 调用本仓库包装器，以当前用户普通权限运行；没有安装系统级 Service。

凭据、扫码内容、状态数据库和用户聊天内容不作为源码发布。恢复或迁移电脑时需要单独处理绑定与 Codex 登录，克隆仓库不等于恢复私人运行状态。

## 私有资料与忽略规则

真实机器路径和原始验收材料保留在 `.local/`，本机代理规则由 `.git/info/exclude` 排除。共享 `.gitignore` 排除环境密钥、SQLite 及旁路文件、真实委派授权文件和根目录运行数据；公开中性模板保留在 `docs/examples/`。忽略不等于访问控制，也不会自动移除已跟踪文件，提交前仍需审阅暂存内容。

委派授权位于私有根目录 `delegation-permissions.json`，委派记录和 outbox 位于原状态库。完整对话仍由 Codex 保存，中间件不复制整个聊天历史。目录说明只定义位置与保留边界；功能状态以 [验收说明](acceptance.md) 为准。
