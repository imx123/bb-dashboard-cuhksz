# CUHK(SZ) Blackboard Classic Dashboard

> **Test environment (2026-10-10):** Windows build reported by `cmd /c ver` as `10.0.26300.9550`, AMD64; bundled Node `24.19.0`, npm `11.19.1`, bundled Python `3.12.14`, Electron `44.4.3`, and Playwright Chromium `153.0.8010.12`. The WMI/CIM edition caption was unavailable in the restricted test host, so no edition name is inferred here.
>
> **Current status:** the owner has completed the current runtime/session code changes and the current `npm.cmd run build` completed PASS. Final static review found no new business blocker. This round did not run tests, typecheck, the application, a browser probe or a real school login. The Python 21/21, Classic TypeScript 18/18, completion 5/5, stdio 8-tool, typecheck and no-flags Electron live/mock results are historical records from before these changes; they do not verify the current code. Current runtime and user-test status: `USER TEST PENDING / UNTESTED`. Real school authentication, real course comparison, and a Windows installer remain BLOCKED. See [delivery status](docs/DELIVERY.md) for the pending verification scope and historical evidence.

[中文说明](README.zh-CN.md)

This repository is a local, read-only development preview for CUHK Shenzhen's Blackboard Classic portal. It combines the Dashboard source from [CUHK-Blackboard-Dashboard](https://github.com/tayang-cc/CUHK-Blackboard-Dashboard) with the isolated Python sidecar from [bb-mcp](https://github.com/changshenhan/bb-mcp). The current upstream source heads, import paths, and license records are in [M0 baseline](docs/M0-baseline.md).

The Dashboard shows courses, announcements, assignments and course-file links. The connector does not submit work, upload files, or download courseware. Login and MFA happen only in a visible official Blackboard page controlled by the local user. This project is independent of CUHK, Blackboard, Anthology and the upstream projects.

## What is verified

- Previous fixture runs covered bounded, typed Classic snapshots, the Python stdio MCP sidecar, the Node provider and the real Electron main-process IPC path; those runs are historical until the current runtime is tested again.
- The owner ran `npm.cmd run build` after the current changes and it completed PASS. Typecheck and all test counts below remain historical records.

The offline fixture and login harness evidence are historical records from before the current runtime/session fixes. The current code now retains a user-owned Playwright context after `complete`, reuses the live authorization context for course reads, scopes per-course `AUTH_REQUIRED` results, preserves partial data across bounded snapshot timeouts, and uses same-origin iframe/read-budget handling. This round did not run those paths; runtime and user-test status remains `USER TEST PENDING / UNTESTED`. Browser startup and an `AUTH_REQUIRED` result do not authenticate a school account. The real school and installer boundaries remain in [the delivery status](docs/DELIVERY.md).

## Windows development setup

Use a fresh checkout and a supported Node 24 installation. Run these commands from the repository directory in CMD or PowerShell:

```bat
npm.cmd ci --no-audit --no-fund
node node_modules/electron/install.js
npm.cmd run build
```

Create the sidecar environment with an independent Python 3.10+ installation. Do not use a system Python 3.14 installation. Verify the interpreter before installing packages. In a Windows CMD window, set the browser path for that window only before installing Playwright:

```bat
py -3.12 -m venv sidecar\bb-mcp\.venv
sidecar\bb-mcp\.venv\Scripts\python.exe --version
set PLAYWRIGHT_BROWSERS_PATH=%CD%\.work\ms-playwright
sidecar\bb-mcp\.venv\Scripts\python.exe -m pip install -r sidecar\bb-mcp\requirements.txt
sidecar\bb-mcp\.venv\Scripts\python.exe -m playwright install chromium
```

In PowerShell, use `$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.work\ms-playwright'` for the current PowerShell process before the two install commands. This keeps browser resources in the project workspace without changing a global browser setting.

If the Python launcher does not provide the intended independent 3.12 interpreter, use another independently installed 3.10+ interpreter to create the same project-local `.venv`. Keep Playwright browser resources in the project or a temporary workspace directory.

For the CUHK(SZ) Dashboard, use the explicit Classic entry points:

```bat
Start-CUHK-Classic.cmd
```

The fixture-only demonstration is safe to run without an account:

```bat
Start-CUHK-Classic-Fixture.cmd
```

It reads only `test/fixtures/classic` and shows an offline label. `Open-CUHK.cmd` opens the built Dashboard directly; it does not perform the build step. The older `Start-CUHK.cmd`, `Check-CUHK.cmd` and `cuhk.cmd` paths belong to the inherited multi-school CLI flow and should not be used as evidence for the CUHK(SZ) Classic Dashboard.

## Tests

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

These commands are retained for reproducibility and user verification. In this round only the owner's current `npm.cmd run build` was run; tests, typecheck, the application, browser probes and the full suite were not run.

The previous full-suite record is kept as history rather than presented as a current run: 169 tests produced 158 PASS, 3 known baseline FAIL and 8 SKIP before the current runtime/session fixes. The current runtime has not been tested. Redirecting only the current process's `TEMP` and `TMP` into a writable workspace removes unrelated temporary-file EPERM errors for future targeted runs.

## Local manual acceptance

Manual verification is currently `USER TEST PENDING / UNTESTED`. The owner build is ready; close the fixture window, run `Start-CUHK-Classic.cmd`, and click the login control. Seeing a course page in the browser does not by itself prove that the Dashboard is authenticated. The application should report that the browser is open; complete the school login only in that visible official Blackboard page, then return to the Dashboard and click `我已登录，检查连接`. If the browser was closed, use `重新打开登录窗口`. An opened browser or an `AUTH_REQUIRED` result does not prove authentication. Enter the account, password and MFA only in the visible official Blackboard page. Do not paste credentials, cookies or verification codes into an issue, chat, terminal log or fixture.

After login, verify at least three different courses by their displayed name and course ID. For each course, compare a visible announcement, an assignment due field, and a course-file source link with the Blackboard page. Check that date-only deadlines stay date-only, unknown dates stay unknown, times display in `Asia/Shanghai`, and permission or partial-read errors remain visible. Close and restart the app, then verify that a local manual completion mark is scoped to the same account. Record the date, course IDs and observed result without recording private course text or credentials.

Manual acceptance must remain separate from fixture tests. A successful MCP handshake, a renderer screenshot, or a typecheck does not prove that a school login or a real course page works.

## Privacy and read-only boundary

The inherited multi-school flow stores its existing local configuration and encrypted authorization state under the configured local data directory. CUHK(SZ) Classic uses a separate local Playwright browser session under a controlled profile path derived from the Dashboard state home and profile scope; this browser session is sensitive runtime data, and the application does not claim that the Classic browser session itself is encrypted. Set `LMS_HOME` to an isolated local directory when testing. Fixture mode does not touch the live profile. Never commit or share either runtime directory.

The application does not accept passwords, cookies, tokens or MFA codes through MCP or renderer IPC. The exposed Classic tools are status, user-controlled login, courses, announcements, assignments, assignment details and course-file listing. There is no submit, upload or automatic courseware-download tool. External links are restricted to the CUHK Shenzhen Blackboard HTTPS origin.

## Source and licenses

Preserve both upstream license files when copying or packaging the source:

- [Dashboard MIT license](LICENSE)
- [bb-mcp license](sidecar/bb-mcp/LICENSE)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Privacy notice](PRIVACY.md)
- [Delivery report](docs/DELIVERY.md)

The source is provided for local development and review. No signed Windows installer is delivered by this repository at the current status.
