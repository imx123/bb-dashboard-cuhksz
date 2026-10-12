# CUHK(SZ) Blackboard Classic Dashboard

> **测试环境（2026-10-10）：** `cmd /c ver` 报告 Windows build `10.0.26300.9550`、AMD64；使用 bundled Node `24.19.0`、npm `11.19.1`、bundled Python `3.12.14`、Electron `44.4.3` 和 Playwright Chromium `153.0.8010.12`。受限测试主机无法访问 WMI/CIM edition caption，因此不从注册表残留值推断系统版本名称。
>
> **当前状态（2026-10-11）：** 类型化 JSON API 重建已落在 `src/classic/`，最近一次 `npm.cmd run build` exit 0。用户反馈已能看到部分真实 Blackboard 数据；这是用户反馈，不是 agent 本轮运行时实测。公告图片 WebDAV 前缀修复和有界空日历页修复仍待用户验收。本轮没有运行测试、typecheck、应用、浏览器探针或学校 HTTP。会话启动仍由用户在可见的官方 Blackboard 页面手动完成；不宣称完整课程对照或 Windows 安装包已就绪。运行验收仍由用户在本机完成。

[English README](README.md)

这是一个面向香港中文大学（深圳）Blackboard Classic 的本地只读开发预览。重建后的 CUHK(SZ) 路径是 `src/classic/` 下的类型化固定学校 origin JSON API reader，由 Electron 主进程管理会话和资源边界。继承的 [CUHK-Blackboard-Dashboard](https://github.com/tayang-cc/CUHK-Blackboard-Dashboard) 源码和 [bb-mcp](https://github.com/changshenhan/bb-mcp) Python sidecar 仍保留作历史/公共 MCP 兼容源码；新 Classic 路径不会静默回退到它们。许可证文件仍保留在仓库中。

Dashboard 展示课程、公告、作业和课程资料链接。连接器不提交作业、不上传文件、不下载课件。登录和 MFA 只在用户自己操作的、可见的官方 Blackboard 页面中完成。本项目与 CUHK、Blackboard、Anthology 及两个上游项目均无官方合作关系。

## 已验证范围

- M0 schema 和 synthetic API fixture 已作为源码交付。重建 reader 保留有界分页、账号/代次核对、类型化提交证据、明确日历关联、受保护账号缓存和可见的 partial coverage；当前 build 已通过，仍待用户本机运行。
- 早期 fixture、sidecar、Electron 和 typecheck 结果均为历史记录。最近一次 build exit 0；不宣称当前 runtime 已通过。

离线 fixture 和登录 harness 属于旧 sidecar/provider 路径的历史记录。重建路径使用用户手动发起的 Electron session、单次有界 JSON snapshot 预算、固定学校 origin 的 GET/HEAD transport、受保护账号缓存和主进程 opaque resource。本轮没有运行这些路径，状态仍为 `USER TEST PENDING / UNTESTED`。看到登录窗口或得到 `AUTH_REQUIRED` 都不能当作学校身份认证成功。真人学校验收和安装包边界仍未完成。

## Windows 开发安装

使用干净工作区和受支持的 Node 24 安装。在 CMD 或 PowerShell 中进入仓库目录后运行：

```bat
npm.cmd ci --no-audit --no-fund
node node_modules/electron/install.js
npm.cmd run build
```

重建后的 Classic JSON API 路径只需要上面的 Node/Electron 依赖。会话由用户点击手动登录时创建，不复制或自动迁移旧 Playwright profile。下面的 Python 安装说明只用于保留的历史 sidecar/MCP 路径，不是重建 Classic reader 的依赖。

如需使用历史 sidecar，请创建独立的 Python 3.10+ 环境。不要使用系统 Python 3.14。安装后先检查解释器版本。在 Windows CMD 窗口中，安装 Playwright 前先为当前窗口设置浏览器目录：

```bat
py -3.12 -m venv sidecar\bb-mcp\.venv
sidecar\bb-mcp\.venv\Scripts\python.exe --version
set PLAYWRIGHT_BROWSERS_PATH=%CD%\.work\ms-playwright
sidecar\bb-mcp\.venv\Scripts\python.exe -m pip install -r sidecar\bb-mcp\requirements.txt
sidecar\bb-mcp\.venv\Scripts\python.exe -m playwright install chromium
```

如果使用 PowerShell，请在两个安装命令前执行 `$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.work\ms-playwright'`，只作用于当前 PowerShell 进程。这样浏览器资源保存在项目工作区，不会改动全局浏览器配置。

如果 Python launcher 没有目标独立 3.12，请使用另一个独立安装的 3.10+ 解释器创建同一路径的项目 venv。Playwright 浏览器资源应保存在项目目录或临时工作区，不要改全局浏览器配置。

`0.1.0` 默认打开 CUHK(SZ) Dashboard，打包后的桌面应用也使用此入口。在源码目录中执行以下命令会先构建再启动：

```bat
npm.cmd start
```

`npm.cmd run start:dashboard:fixture` 启动不需要学校账号的合成演示。原 Windows 启动脚本仍可使用：

```bat
Start-CUHK-Classic.cmd
```

不需要账号的离线演示：

```bat
Start-CUHK-Classic-Fixture.cmd
```

fixture 只读取 `src/classic/fixtures/synthetic-api.ts`，界面会显示离线标签。请使用上面的 Classic 启动脚本；原香港 CUHK 预设及旧启动入口已经移除。

## 测试命令

```bat
sidecar\bb-mcp\.venv\Scripts\python.exe -m unittest -v sidecar\bb-mcp\test_connector.py
sidecar\bb-mcp\.venv\Scripts\python.exe sidecar\bb-mcp\_mcp_selftest.py
node --import tsx --test test/classic-dashboard-ui.test.ts test/classic-api-rebuild-risks.test.ts
node --import tsx --test test/dashboard-completion.test.ts
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

以上命令保留用于复现和用户验证。最近一次记录的 `npm.cmd run build` 已 exit 0；本轮没有新增 build，也没有运行测试、typecheck、应用、浏览器探针和全套回归。真实运行仍待用户完成。

上一阶段全套测试记录会作为历史保留：当前 runtime/session 修复前共 169 项，158 PASS、3 个已知基线 FAIL、8 SKIP；当前 runtime 尚未测试。只把当前进程的 `TEMP`、`TMP` 指向可写工作区可以消除未来定向运行中的无关临时文件 EPERM。

## 本地人工验收

当前人工验证状态为 `USER TEST PENDING / UNTESTED`。owner build 已准备好；先运行 fixture 模式；进行学校检查时，关闭 fixture 窗口，运行 `Start-CUHK-Classic.cmd` 并点击登录。浏览器中看到课程页面本身不代表 Dashboard 已完成认证。应用应提示浏览器已打开；只在这个可见的官方 Blackboard 页面中完成学校登录，然后回到 Dashboard 点击“我已登录，检查连接”。如果浏览器被关闭，先点击“重新打开登录窗口”。浏览器打开或返回 `AUTH_REQUIRED` 都不代表身份认证成功。账号、密码和 MFA 只填写在可见的官方 Blackboard 页面中；不要把凭据、Cookie 或验证码粘贴到聊天、issue、终端日志或 fixture 中。

登录后至少核对 3 门不同课程的名称和课程 ID。每门课分别将一个公告、一项作业截止字段和一个资料来源链接与 Blackboard 页面对照。确认只有明确证据才显示截止时刻，只有日期的项目保持日期，未知日期保持未知，时间使用 `Asia/Shanghai`；权限拒绝和部分读取错误应继续显示。关闭并重新打开 Dashboard，验证本地手动完成标记只属于同一账号。记录日期、课程 ID 和观察结论，不记录私人课程正文或登录凭据。

人工验收与 fixture 测试必须分开。MCP handshake、renderer 截图或 typecheck 通过，都不能证明学校登录或真实课程页面可用。

## 隐私与只读边界

继承的多学校流程会把原有本地配置和加密授权状态写入配置的数据目录。重建后的 CUHK(SZ) Classic 路径使用手动登录流程创建的 Electron 持久 partition/session，不复制或静默复用旧 Playwright profile。session 和受保护缓存都是敏感运行数据。测试时可以设置 `LMS_HOME` 指向独立的本地目录。fixture 模式不会触碰 live profile。不要提交或分享运行数据、profile 或日志。

应用不会通过 MCP 或 renderer IPC 接收密码、Cookie、token 或 MFA 验证码。Classic 暴露的工具只有状态、用户驱动登录、课程、公告、作业、作业详情和课程资料列表，没有提交、上传或自动课件下载工具。外部链接只允许 CUHK(SZ) Blackboard HTTPS 域名。

## 来源与许可证

复制或打包源码时必须保留两个上游许可证文件：

- [Dashboard MIT 许可证](LICENSE)
- [bb-mcp 许可证](sidecar/bb-mcp/LICENSE)
- [第三方组件声明](THIRD_PARTY_NOTICES.md)

当前仓库提供本地开发源码，尚未交付签名 Windows 安装包。
