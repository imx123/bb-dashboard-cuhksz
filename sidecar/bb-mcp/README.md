# CUHK(SZ) Blackboard Classic read-only MCP

> Test environment: Windows 11, Python 3.12.14, MCP Python SDK 1.30.0, Playwright 1.63.0. The
> live school account and Windows installer remain user-local acceptance steps.

[English](#english) · [中文](#中文) · [contract](../../docs/classic-contract.md)

## English

This sidecar adapts the read navigation from the MIT licensed
[changshenhan/bb-mcp](https://github.com/changshenhan/bb-mcp) Classic connector. It
returns stable JSON/ MCP structured content for courses, announcements,
assignments and course files. The implementation is read-only: submission,
upload and automatic download tools are deliberately absent.

The live implementation keeps the upstream portal tab, course launcher,
`listContent`, announcement menu and assessment-link navigation. Page conversion
is performed by pure functions in `classic_connector.py`, so synthetic DOM
fixtures test the same conversion path used by Playwright.

The tested direct dependency versions are `mcp==1.30.0` and
`playwright==1.63.0`; the complete tested environment is recorded in
`requirements.lock`.
When running from this checkout, the connector automatically uses
`.work/ms-playwright` when that project-local Chromium cache exists. An
explicit `PLAYWRIGHT_BROWSERS_PATH` still takes precedence.

### MCP tools

The stdio entry point exposes exactly these tools:

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `classic_status` | none | Check offline mode or local session |
| `classic_login` | `action=begin\|complete` | User-controlled official browser login |
| `classic_snapshot` | optional `course_ids`, `include`, `limits` | One bounded read snapshot |
| `classic_list_courses` | none | List visible courses |
| `classic_announcements` | `course_id`, optional `limit` | Read announcements |
| `classic_list_assignments` | `course_id`, optional `limit` | Read assignments and due evidence |
| `classic_assignment_details` | `course_id`, optional `keyword`, `limit` | Read details; download is always disabled |
| `classic_list_course_files` | `course_id`, optional `limit` | List files; never downloads |

The result envelope carries `state`, `fetchedAt`, `timezone`, a resource array
and `errors`. `state=ok` with an empty array means a confirmed empty page;
unknown layouts and request failures return an explicit error code. A course
failure leaves results from other courses and uses `state=partial`.

### Install and run

Use an isolated project virtual environment. Do not place a credential file in
this repository and do not use the system Python.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe server.py
```

The Python executable and `server.py` path are passed by the MCP client through
stdio. The sidecar does not create or read `cred.json`.

### Manual authorization

Set `BB_USER_DATA_DIR` to a writable local user-data directory when needed. The
default is a per-user application-data directory. `classic_login(action="begin")`
opens `https://bb.cuhk.edu.cn/` in a visible persistent Playwright context. The
user completes the official login and any MFA in that window, then calls
`classic_login(action="complete")`. The connector only checks whether the portal
is reachable; it never receives a password, Cookie, token or验证码.

`BB_BASE_URL` is restricted to `https://bb.cuhk.edu.cn`; external hosts,
non-HTTPS schemes, embedded credentials and non-default ports are rejected.
All browser calls use one serial queue. On stdio shutdown, browser context and
Playwright are closed.

### Offline fixture mode

Set `BB_OFFLINE_FIXTURE` to `test/fixtures/classic` and run the same `server.py`
entry point. This mode reads only synthetic HTML fixtures and does not contact
Blackboard or require an account. The fixture files are explicitly marked
synthetic and cannot be used to claim real course or school validation.

### Self-tests

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s . -p "test_*.py" -v
.\.venv\Scripts\python.exe _mcp_selftest.py
.\.venv\Scripts\python.exe _browser_cleanup_selftest.py
```

`_mcp_selftest.py` starts the actual stdio process, performs MCP initialize and
tool listing, calls `classic_snapshot` in fixture mode, and verifies the
structured result (with JSON text fallback for SDK versions that do not expose
structured content). It also exits the stdio context normally, exercising the
server `finally` cleanup path.
`_browser_cleanup_selftest.py` separately starts local Chromium on `about:blank`
with a temporary profile and verifies `connector.close()` closes the page; it
never contacts Blackboard. Run `playwright install chromium` in the sidecar
environment first; if the browser executable is absent, record this check as
blocked rather than treating stdio cleanup as browser cleanup.

The live M1 course comparison and M2 three-course comparison are
`BLOCKED: REQUIRES LOCAL USER TEST` until the user performs the official login
and checks the pages on their own Windows machine.

## 中文

本 Sidecar 复用上游 Classic 的实际导航路线，但只保留课程、公告、作业、资料的只读
读取和手动授权步骤。没有自动提交、上传或下载工具；作业详情固定按 `download=false`
处理。页面解析函数位于 `classic_connector.py`，由 synthetic DOM fixture 与 Playwright
共用。

### 安装与运行

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe server.py
```

连接器不创建、不读取 `cred.json`。`classic_login(action="begin")` 只打开
`https://bb.cuhk.edu.cn/` 官方可见浏览器，用户自己完成登录和 MFA，再调用
`action="complete"` 验证 portal。不会向 MCP、仓库或聊天发送密码、Cookie、验证码或
token。profile 由 `BB_USER_DATA_DIR` 配置，默认位于用户自己的应用数据目录。

### 离线模式与测试

把 `BB_OFFLINE_FIXTURE` 指向 `test/fixtures/classic` 后，仍通过相同 stdio MCP 入口返回
synthetic DOM 解析结果，不接触学校账号。运行上面的 unittest 和 `_mcp_selftest.py`
即可验证纯解析、partial/error 区分、DDL 证据规则、恶意 URL 拒绝以及实际 MCP 握手与
structuredContent 序列化。

DDL 只有日期时返回 `dueDateOnly: YYYY-MM-DD`，不补 `23:59`；有明确时刻时才返回带
`+08:00` 的 `dueAt`。普通课件发布时间不作为 DDL；不确定时保留 `null`/`unknown`。
同标题不同来源链接不合并。未知布局返回 `COURSE_PARSE_CHANGED`，不会假装成功空数据。

## License

保留上游 MIT 许可证和版权声明，见 [LICENSE](LICENSE)。

