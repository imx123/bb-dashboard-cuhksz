# CUHK(SZ) Blackboard Classic Dashboard

> **测试环境（2026-10-10）：** `cmd /c ver` 报告 Windows build `10.0.26300.9550`、AMD64；使用 bundled Node `24.19.0`、npm `11.19.1`、bundled Python `3.12.14`、Electron `44.4.3` 和 Playwright Chromium `153.0.8010.12`。受限测试主机无法访问 WMI/CIM edition caption，因此不从注册表残留值推断系统版本名称。
>
> **当前状态：** owner 已完成当前 runtime/session 代码修复，本轮 `npm.cmd run build` 已由 owner 执行并 PASS。final_review 静态复核完成，未发现新的业务阻断。本轮没有运行测试、typecheck、应用、浏览器探针或真实学校登录。Python 21/21、Classic TypeScript 18/18、完成标记 5/5、stdio 8 工具、typecheck 和无 flags Electron live/mock 结果，全部是这些修复之前的历史记录，不能证明当前代码。当前 runtime 和人工测试状态：`USER TEST PENDING / UNTESTED`。真实学校身份认证、真实课程对照和 Windows 安装包仍是 BLOCKED。待验证范围和历史证据见 [交付状态](docs/DELIVERY.md)。

[English README](README.md)

这是一个面向香港中文大学（深圳）Blackboard Classic 的本地只读开发预览。Dashboard 根源码来自 [CUHK-Blackboard-Dashboard](https://github.com/tayang-cc/CUHK-Blackboard-Dashboard)，Python sidecar 来自 [bb-mcp](https://github.com/changshenhan/bb-mcp)。当前上游 SHA、导入路径和许可证记录见 [M0 基线报告](docs/M0-baseline.md)。

Dashboard 展示课程、公告、作业和课程资料链接。连接器不提交作业、不上传文件、不下载课件。登录和 MFA 只在用户自己操作的、可见的官方 Blackboard 页面中完成。本项目与 CUHK、Blackboard、Anthology 及两个上游项目均无官方合作关系。

## 已验证范围

- 上一轮 fixture 运行覆盖了有边界的 Classic 结构化快照、Python stdio MCP sidecar、Node provider 和真实 Electron 主进程 IPC；当前 runtime 尚未重新运行这些路径。
- owner 在本轮代码修复后执行了 `npm.cmd run build` 并 PASS；typecheck 和下方测试计数仍是历史记录。

离线 fixture 和登录 harness 证据都是当前 runtime/session 修复之前的历史记录。当前代码已包含 complete 后保留用户持有的 Playwright context、用活跃授权 context 读取课程、按课程区分 `AUTH_REQUIRED`、有界 snapshot 超时保留部分数据，以及同源 iframe/读取预算；本轮没有运行这些路径，状态仍为 `USER TEST PENDING / UNTESTED`。浏览器启动和 `AUTH_REQUIRED` 结果都不能当作学校身份认证成功。真人学校验收和安装包边界见 [交付状态](docs/DELIVERY.md)。

## Windows 开发安装

使用干净工作区和受支持的 Node 24 安装。在 CMD 或 PowerShell 中进入仓库目录后运行：

```bat
npm.cmd ci --no-audit --no-fund
node node_modules/electron/install.js
npm.cmd run build
```

sidecar 使用独立的 Python 3.10+ 环境。不要使用系统 Python 3.14。安装后先检查解释器版本。在 Windows CMD 窗口中，安装 Playwright 前先为当前窗口设置浏览器目录：

```bat
py -3.12 -m venv sidecar\bb-mcp\.venv
sidecar\bb-mcp\.venv\Scripts\python.exe --version
set PLAYWRIGHT_BROWSERS_PATH=%CD%\.work\ms-playwright
sidecar\bb-mcp\.venv\Scripts\python.exe -m pip install -r sidecar\bb-mcp\requirements.txt
sidecar\bb-mcp\.venv\Scripts\python.exe -m playwright install chromium
```

如果使用 PowerShell，请在两个安装命令前执行 `$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.work\ms-playwright'`，只作用于当前 PowerShell 进程。这样浏览器资源保存在项目工作区，不会改动全局浏览器配置。

如果 Python launcher 没有目标独立 3.12，请使用另一个独立安装的 3.10+ 解释器创建同一路径的项目 venv。Playwright 浏览器资源应保存在项目目录或临时工作区，不要改全局浏览器配置。

CUHK(SZ) Dashboard 使用以下入口：

```bat
Start-CUHK-Classic.cmd
```

不需要账号的离线演示：

```bat
Start-CUHK-Classic-Fixture.cmd
```

fixture 只读取 `test/fixtures/classic`，界面会显示离线标签。`Open-CUHK.cmd` 直接打开已经 build 的 Dashboard，不负责 build。旧的 `Start-CUHK.cmd`、`Check-CUHK.cmd` 和 `cuhk.cmd` 属于继承的多学校 CLI 流程，不应作为 CUHK(SZ) Classic Dashboard 的验收证据。

## 测试命令

```bat
sidecar\bb-mcp\.venv\Scripts\python.exe -m unittest -v sidecar\bb-mcp\test_connector.py
sidecar\bb-mcp\.venv\Scripts\python.exe sidecar\bb-mcp\_mcp_selftest.py
node --import tsx --test test/classic-dashboard.test.ts
node --import tsx --test test/dashboard-completion.test.ts
node scripts/verify-classic-login.mjs
npm.cmd run typecheck
npm.cmd run build
node scripts/verify-classic-electron.mjs
npm.cmd test
```

以上命令保留用于复现和用户验证。本轮只有 owner 当前的 `npm.cmd run build` 已执行；测试、typecheck、应用、浏览器探针和全套回归均未运行。

上一阶段全套测试记录会作为历史保留：当前 runtime/session 修复前共 169 项，158 PASS、3 个已知基线 FAIL、8 SKIP；当前 runtime 尚未测试。只把当前进程的 `TEMP`、`TMP` 指向可写工作区可以消除未来定向运行中的无关临时文件 EPERM。

## 本地人工验收

当前人工验证状态为 `USER TEST PENDING / UNTESTED`。owner build 已准备好；先运行 fixture 模式；进行学校检查时，关闭 fixture 窗口，运行 `Start-CUHK-Classic.cmd` 并点击登录。浏览器中看到课程页面本身不代表 Dashboard 已完成认证。应用应提示浏览器已打开；只在这个可见的官方 Blackboard 页面中完成学校登录，然后回到 Dashboard 点击“我已登录，检查连接”。如果浏览器被关闭，先点击“重新打开登录窗口”。浏览器打开或返回 `AUTH_REQUIRED` 都不代表身份认证成功。账号、密码和 MFA 只填写在可见的官方 Blackboard 页面中；不要把凭据、Cookie 或验证码粘贴到聊天、issue、终端日志或 fixture 中。

登录后至少核对 3 门不同课程的名称和课程 ID。每门课分别将一个公告、一项作业截止字段和一个资料来源链接与 Blackboard 页面对照。确认只有明确证据才显示截止时刻，只有日期的项目保持日期，未知日期保持未知，时间使用 `Asia/Shanghai`；权限拒绝和部分读取错误应继续显示。关闭并重新打开 Dashboard，验证本地手动完成标记只属于同一账号。记录日期、课程 ID 和观察结论，不记录私人课程正文或登录凭据。

人工验收与 fixture 测试必须分开。MCP handshake、renderer 截图或 typecheck 通过，都不能证明学校登录或真实课程页面可用。

## 隐私与只读边界

继承的多学校流程会把原有本地配置和加密授权状态写入配置的数据目录。CUHK(SZ) Classic 使用独立的本地 Playwright 浏览器 session，路径由 Dashboard state home 和 profile scope 派生并受控；该浏览器 session 属于敏感运行数据，应用不声称 Classic 浏览器 session 本身已加密。测试时可以设置 `LMS_HOME` 指向独立的本地目录。fixture 模式不会触碰 live profile。不要提交或分享这些运行目录。

应用不会通过 MCP 或 renderer IPC 接收密码、Cookie、token 或 MFA 验证码。Classic 暴露的工具只有状态、用户驱动登录、课程、公告、作业、作业详情和课程资料列表，没有提交、上传或自动课件下载工具。外部链接只允许 CUHK(SZ) Blackboard HTTPS 域名。

## 来源与许可证

复制或打包源码时必须保留两个上游许可证文件：

- [Dashboard MIT 许可证](LICENSE)
- [bb-mcp 许可证](sidecar/bb-mcp/LICENSE)
- [第三方组件声明](THIRD_PARTY_NOTICES.md)
- [隐私说明](PRIVACY.md)
- [交付报告](docs/DELIVERY.md)

当前仓库提供本地开发源码，尚未交付签名 Windows 安装包。
