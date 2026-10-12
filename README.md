# CUHK(SZ) Blackboard Dashboard

> **Tested on:** Windows x64, build `10.0.26300.9550`, Electron `44.4.3`. The Windows `0.1.0` installer and app have passed local user testing. **macOS has not been tested.**

[中文说明](README.zh-CN.md)

A desktop app for CUHK-Shenzhen students who want their Blackboard courses, assignments, announcements and files in one place.

## Download and install

Download **`bb-dashboard-cuhksz-0.1.0-x64.exe`** from [Releases](https://github.com/imx123/bb-dashboard-cuhksz/releases/latest). Run it, approve the administrator prompt, and choose an installation folder. You do not need to install Node.js or Python to use the Windows installer.

This release provides a Windows x64 installer. macOS has not been tested and no macOS installer is included in this release. The Windows installer is not digitally signed.

## First login

1. Open the app. On first use, it asks you to log in.
2. Click **登录 / 重新授权**. Sign in through the official school page in the app's browser and complete any school verification.
3. Return to the Dashboard and click **我已登录，检查连接**.
4. Once your login is confirmed, the app refreshes your Blackboard data.

Enter your password and verification codes only on the official school login page. You do not need to copy cookies or send account details to this project.

## What you can do

- Browse your courses and open their Blackboard pages.
- Read announcements, including supported images and attachments.
- See assignments, due dates, details and available submission records. Assignments with a submission record appear as completed; you can also keep your own local completion marks.
- Find assignments, announcements and course files by course name. Each item shows which course it belongs to.
- View upcoming deadlines over the next 7, 14 or 30 days.
- Refresh data and keep a local copy. If your session cannot be restored later, the app can show your last saved data with its original sync time.

The app reads Blackboard data. Submit assignments and upload work on Blackboard itself. If Blackboard does not provide a due date or a resource cannot be read, the app shows that instead of guessing.

## Login, cache and uninstall

After your first successful login, the app keeps the browser session locally. On later launches, it checks that session and tries the school's SSO flow if needed. When the school requires a password or MFA, it opens the login window for you.

The cache is a saved copy, so it may be older than Blackboard. Refresh after logging in to get current data. Cache viewing is read-only.

A normal Windows uninstall clears the default embedded-browser session and resets first-use setup. Installing an update over the existing app keeps the session. Course caches, local completion marks and diagnostic logs are retained. Custom data folders and other Windows users' data are not removed automatically.

## Troubleshooting

If login or refresh fails, try **登录 / 重新授权** and check the connection again. If only some course data is missing, use its source link to check Blackboard directly.

The sidebar has **打开诊断日志目录** and **复制日志位置**. Logs are saved locally in the app's `logs` folder. Before sharing a log or screenshot, check it for private information; never share your password, verification codes or browser profile.

## Run from source

Use Node.js 24 and run these commands from the project folder:

```sh
npm ci
node node_modules/electron/install.js
npm start
```

`npm start` builds and opens the CUHK(SZ) Dashboard. On Windows, `Start-CUHK-Classic.cmd` is also available. To explore the app with sample data and no school account:

```sh
npm run start:dashboard:fixture
```

Useful development commands:

```sh
npm run typecheck
npm test
npm run pack:app:win
```

The last command builds the Windows x64 installer and requires Windows. It writes the installer to `release/`. Source runs use `.cuhk-data`; installed apps use their own user data folder. You can select a custom data folder with `CUHK_LMS_HOME`.

The main Dashboard uses the TypeScript connector and Electron browser. Python is not required for it; the retained Python MCP component is separate.

## Credits and license

This project builds on [lms-cli](https://github.com/zs-andy/lms-cli), [CUHK-Blackboard-Dashboard](https://github.com/tayang-cc/CUHK-Blackboard-Dashboard) and [bb-mcp](https://github.com/changshenhan/bb-mcp). See [LICENSE](LICENSE), [bb-mcp's license](sidecar/bb-mcp/LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

This is an independent student project, not an official CUHK(SZ) or Blackboard product.
