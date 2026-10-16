# 仓库与本机目录

本机工作目录为 `G:\ComputerManager-RebotWeXin`。远端为 `XIpfengf/ComputerManager-RebotWeXin`，本轮开发成果提交到 `develop`；当前运行仍使用这一目录，切换分支后不要删除或移动它。

## 纳入 Git 的内容

```text
ComputerManager-RebotWeXin/
├── README.md                 项目目标、运行方式、验收状态
├── NOTICE                    上游来源、固定提交和许可声明
├── .gitignore                本机状态与生成文件排除规则
├── .gitattributes            保留上游已有空白与补丁格式的检查规则
├── docs/
│   ├── directory-layout.md   目录与本机部署关系
│   ├── upstream-baseline.md  固定上游及兼容差异
│   ├── codex-ilink-compatibility.patch
│   ├── guard-startup-acceptance.md
│   └── v1-acceptance.md       已验收项、证据及剩余项目
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

vendor 是固定版本源码导入，不是 Git 子模块，也不含嵌套 `.git`。本项目入口和本机兼容包装器在根目录维护，vendor 的 8 个兼容差异见基线文档。

## 仅保留本机，不推送

| 位置 | 用途 |
| --- | --- |
| `.local/legacy-evaluation/` | 已迁入仓库目录的旧评估副本，可恢复备份；当前运行不依赖它 |
| `.local/guard-acceptance/`、`.local/*probe*` | 隔离验收库与诊断结果，可能包含本机信息 |
| `.local/v1-acceptance-tests.log` | 518 项测试日志 |
| `vendor/codex-ilink/node_modules/` | 本机安装的依赖 |
| `vendor/codex-ilink/dist/` | 构建输出；全局 ilink 链接和隐藏启动宿主依赖此目录，不能在运行中清理 |
| 其他 `*.log` | 本机日志 |

## 仓库之外的运行状态

- 逻辑目录：`%LOCALAPPDATA%\Codex_iLink`，含绑定、SQLite 状态、Inbox、媒体与日志。
- 商店版 Codex 实际目录：`%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\Codex_iLink`。本机启动脚本通过已绑定 `state.sqlite` 文件的真实路径定位，不只解析父目录。
- Codex 用户设置、会话历史和插件由用户的 Codex 数据目录维护，不随本仓库推送。
- 全局 `ilink` 命令通过 npm link 指向本仓库的构建输出。
- Windows 计划任务 `Codex iLink Bridge` 调用本仓库包装器，以当前用户普通权限运行；没有安装系统级 Service。

凭据、扫码内容、状态数据库和用户聊天内容不作为源码发布。恢复或迁移电脑时需要单独处理绑定与 Codex 登录，克隆仓库不等于恢复私人运行状态。
