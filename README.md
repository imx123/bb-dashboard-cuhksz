# CUHK(SZ) Blackboard Classic Dashboard

> **Test environment (2026-10-10):** Windows build reported by `cmd /c ver` as `10.0.26300.9550`, AMD64; bundled Node `24.19.0`, npm `11.19.1`, bundled Python `3.12.14`, Electron `44.4.3`, and Playwright Chromium `153.0.8010.12`. The WMI/CIM edition caption was unavailable in the restricted test host, so no edition name is inferred here.
>
> **Current status (2026-10-11):** the typed JSON API rebuild is implemented under `src/classic/`, and the latest `npm.cmd run build` completed with exit 0. The user has reported that partial real Blackboard data is visible; that is user-reported and not an agent-run runtime result. The announcement-image WebDAV-prefix and bounded empty-calendar-page fixes remain pending user validation. This turn did not run tests, typecheck, the application, a browser probe or school HTTP. Session startup remains manual in a visible official Blackboard page; no complete course comparison or Windows installer readiness is claimed. Runtime validation remains user-owned.

[中文说明](README.zh-CN.md)

This repository is a local, read-only development preview for CUHK Shenzhen's Blackboard Classic portal. The rebuilt CUHK(SZ) path is a typed, fixed-origin JSON API reader under `src/classic/`, with an Electron-owned session and main-process resource boundary. The inherited Dashboard source from [CUHK-Blackboard-Dashboard](https://github.com/tayang-cc/CUHK-Blackboard-Dashboard) and the isolated Python [bb-mcp](https://github.com/changshenhan/bb-mcp) sidecar remain in the tree for historical/public MCP compatibility; the new Classic route does not silently fall back to them. License files remain in the repository.

The Dashboard shows courses, announcements, assignments and course-file links. The connector does not submit work, upload files, or download courseware. Login and MFA happen only in a visible official Blackboard page controlled by the local user. This project is independent of CUHK, Blackboard, Anthology and the upstream projects.

## What is verified

- M0 schemas and synthetic API fixtures are source-level artifacts. The rebuilt reader keeps bounded pagination, account/generation checks, typed submission evidence, explicit calendar association, protected cache scope and visible partial coverage; the latest recorded build passed, and user runtime validation remains pending.
- Earlier fixture, sidecar, Electron and typecheck results are historical records. The latest build exited 0; no current runtime result is claimed.

The offline fixture and login harness evidence belong to the former sidecar/provider route. The rebuilt path uses the manually initiated Electron session, a single bounded JSON snapshot budget, fixed-origin GET/HEAD transport, protected account-scoped cache and opaque main-process resources. This round did not run those paths; runtime and user-test status remains `USER TEST PENDING / UNTESTED`. A visible login window or an `AUTH_REQUIRED` result does not authenticate a school account. Complete school comparison and installer acceptance remain pending.

## Windows development setup

Use a fresh checkout and a supported Node 24 installation. Run these commands from the repository directory in CMD or PowerShell:

```bat
npm.cmd ci --no-audit --no-fund
node node_modules/electron/install.js
npm.cmd run build
```

The rebuilt Classic JSON API route needs the Node/Electron dependencies above. Its session is created by the visible manual login action and does not copy or auto-migrate the former Playwright profile. The Python instructions below are only for the retained historical sidecar/MCP path; they are not required by the rebuilt Classic reader.

For the historical sidecar, create an independent Python 3.10+ environment. Do not use a system Python 3.14 installation. Verify the interpreter before installing packages. In a Windows CMD window, set the browser path for that window only before installing Playwright:

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

It reads only the synthetic source fixture in `src/classic/fixtures/synthetic-api.ts` and shows an offline label. `Open-CUHK.cmd` opens the built Dashboard directly; it does not perform the build step. The older `Start-CUHK.cmd`, `Check-CUHK.cmd` and `cuhk.cmd` paths belong to the inherited multi-school CLI flow and should not be used as evidence for the CUHK(SZ) Classic Dashboard.

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

These commands are retained for reproducibility and user verification. The latest recorded `npm.cmd run build` exited 0; tests, typecheck, the application, browser probes and the full suite were not run. Runtime and school-account acceptance remain USER TEST PENDING.

The previous full-suite record is kept as history rather than presented as a current run: 169 tests produced 158 PASS, 3 known baseline FAIL and 8 SKIP before the current runtime/session fixes. The current runtime has not been tested. Redirecting only the current process's `TEMP` and `TMP` into a writable workspace removes unrelated temporary-file EPERM errors for future targeted runs.

## Local manual acceptance

Manual verification is currently `USER TEST PENDING / UNTESTED`. The owner build is ready; close the fixture window, run `Start-CUHK-Classic.cmd`, and click the login control. Seeing a course page in the browser does not by itself prove that the Dashboard is authenticated. The application should report that the browser is open; complete the school login only in that visible official Blackboard page, then return to the Dashboard and click `我已登录，检查连接`. If the browser was closed, use `重新打开登录窗口`. An opened browser or an `AUTH_REQUIRED` result does not prove authentication. Enter the account, password and MFA only in the visible official Blackboard page. Do not paste credentials, cookies or verification codes into an issue, chat, terminal log or fixture.

After login, verify at least three different courses by their displayed name and course ID. For each course, compare a visible announcement, an assignment due field, and a course-file source link with the Blackboard page. Check that date-only deadlines stay date-only, unknown dates stay unknown, times display in `Asia/Shanghai`, and permission or partial-read errors remain visible. Close and restart the app, then verify that a local manual completion mark is scoped to the same account. Record the date, course IDs and observed result without recording private course text or credentials.

Manual acceptance must remain separate from fixture tests. A successful MCP handshake, a renderer screenshot, or a typecheck does not prove that a school login or a real course page works.

## Privacy and read-only boundary

The inherited multi-school flow stores its existing local configuration and encrypted authorization state under the configured local data directory. The rebuilt CUHK(SZ) Classic route uses an Electron-owned persistent partition/session created by the manual login flow; it does not copy or silently reuse the former Playwright profile. The session and protected cache are sensitive runtime data. Set `LMS_HOME` to an isolated local directory when testing. Fixture mode does not touch the live profile. Never commit or share runtime data, profiles or logs.

The application does not accept passwords, cookies, tokens or MFA codes through MCP or renderer IPC. The exposed Classic tools are status, user-controlled login, courses, announcements, assignments, assignment details and course-file listing. There is no submit, upload or automatic courseware-download tool. External links are restricted to the CUHK Shenzhen Blackboard HTTPS origin.

## Source and licenses

Preserve both upstream license files when copying or packaging the source:

- [Dashboard MIT license](LICENSE)
- [bb-mcp license](sidecar/bb-mcp/LICENSE)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

The source is provided for local development and review. No signed Windows installer is delivered by this repository at the current status.
