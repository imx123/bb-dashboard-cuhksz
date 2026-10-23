# CUHK(SZ) Blackboard Dashboard

> **测试环境：** Windows x64，系统 build `10.0.26300.9550`，Electron `44.4.3`。Windows `0.1.0` 安装包和应用已通过本机用户测试。**macOS 版本未测试。**

[English README](README.md)

这是一个给香港中文大学（深圳）学生用的桌面应用，把 Blackboard 的课程、作业、公告和资料放在一起，方便查看。

## 下载和安装

到 [Releases 页面](https://github.com/imx123/bb-dashboard-cuhksz/releases/latest)下载 **`bb-dashboard-cuhksz-0.1.0-x64.exe`**。双击运行，允许管理员权限，再选择安装位置即可。使用安装包不需要另外安装 Node.js 或 Python。

本次提供 Windows x64 安装包。macOS 版本未测试，本次没有提供 macOS 安装包。Windows 安装包目前没有数字签名。

## 第一次登录

1. 打开软件，首次使用会提示登录。
2. 点击 **登录 / 重新授权**，在软件打开的学校官方页面完成登录和必要的验证。
3. 回到 Dashboard，点击 **我已登录，检查连接**。
4. 确认登录成功后，软件会刷新 Blackboard 数据。

密码和验证码只填写在学校官方登录页面。无需复制 Cookie，也无需向本项目提供账号信息。

## 能做什么

- 查看课程列表，并打开对应的 Blackboard 页面。
- 阅读公告，显示支持的图片和附件。
- 查看作业、截止时间、详情和可获取的提交记录。有提交记录的作业会归为已完成，也可以自行勾选本地完成标记。
- 按课程名称筛选作业、公告和资料，每条内容都有醒目的课程标识。
- 查看未来 7、14 或 30 天的截止安排。
- 刷新后保存一份本地数据。下次无法恢复登录时，可以显示上次缓存，并标明原来的同步时间。

软件只读取 Blackboard 数据。提交作业、上传文件仍在 Blackboard 上完成。学校没有提供截止时间，或某项内容读取失败时，软件会显示相应提示，不会猜一个结果。

## 登录、缓存与卸载

第一次确认登录成功后，软件会在本机保留浏览器会话。以后打开时先检查现有会话，必要时尝试学校的 SSO；学校要求密码或 MFA 时，再显示登录窗口。

缓存是上次保存的副本，可能比 Blackboard 上的内容旧。登录后刷新即可获取最新数据。查看缓存时不能修改本地标记。

正常卸载 Windows 应用会清除默认内置浏览器的登录状态，并重置首次使用记录。直接覆盖安装新版会保留登录状态。课程缓存、本地完成标记和诊断日志会保留；自定义数据目录及其他 Windows 用户的数据不会自动清理。

## 遇到问题怎么办

登录或刷新失败时，先点击 **登录 / 重新授权**，完成学校登录后再检查连接。只有部分课程内容缺失时，可以打开对应来源链接，与 Blackboard 页面核对。

侧栏有 **打开诊断日志目录** 和 **复制日志位置**。日志每次都会写入本机的 `logs` 目录。分享日志或截图前先检查是否包含私人信息；不要分享密码、验证码或浏览器 profile。

安全漏洞请通过[本仓库的私密报告入口](https://github.com/imx123/bb-dashboard-cuhksz/security/advisories/new)反馈；如果入口未启用，先联系[维护者 imx123](https://github.com/imx123)约定私密渠道。不要在公开 Issue 中提交漏洞利用细节、账号凭据或学生数据。

## 从源码运行

准备 Node.js 24，在项目目录执行：

```sh
npm ci
node node_modules/electron/install.js
npm start
```

`npm start` 会先构建，再打开深圳 Dashboard。Windows 也可以使用 `Start-CUHK-Classic.cmd`。想先看看界面、不登录学校账号，可以运行合成数据演示：

```sh
npm run start:dashboard:fixture
```

常用开发命令：

```sh
npm run typecheck
npm test
npm run pack:app:win
```

最后一条命令需要在 Windows 上运行，会把 x64 安装包输出到 `release/`。源码运行使用 `.cuhk-data`，安装版使用自己的用户数据目录；需要指定其他位置时，可设置 `CUHK_LMS_HOME`。

当前 Dashboard 使用 TypeScript 数据连接器和 Electron 浏览器，不需要 Python。仓库保留的 Python MCP 组件是独立功能。

## 来源与许可证

项目基于 [lms-cli](https://github.com/zs-andy/lms-cli)、[CUHK-Blackboard-Dashboard](https://github.com/tayang-cc/CUHK-Blackboard-Dashboard) 和 [bb-mcp](https://github.com/changshenhan/bb-mcp) 开发。许可证与第三方说明见 [LICENSE](LICENSE)、[bb-mcp 许可证](sidecar/bb-mcp/LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

这是独立学生项目，不是 CUHK(SZ) 或 Blackboard 官方产品。
