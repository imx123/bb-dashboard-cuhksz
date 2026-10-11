"""MCP stdio handshake and structuredContent fixture self-test.

This starts the actual ``server.py`` process.  It does not contact Blackboard:
``BB_OFFLINE_FIXTURE`` points to synthetic DOM fixtures in this repository.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


HERE = Path(__file__).resolve().parent
SERVER = HERE / "server.py"
FIXTURE_DIR = HERE.parents[1] / "test" / "fixtures" / "classic"
EXPECTED_TOOLS = [
    "classic_status",
    "classic_login",
    "classic_snapshot",
    "classic_list_courses",
    "classic_announcements",
    "classic_list_assignments",
    "classic_assignment_details",
    "classic_list_course_files",
]


def _result_payload(result):
    structured = getattr(result, "structuredContent", None)
    if structured:
        return structured, "structuredContent"
    for item in getattr(result, "content", []) or []:
        text = getattr(item, "text", None)
        if text:
            try:
                return json.loads(text), "text-json"
            except json.JSONDecodeError:
                continue
    raise AssertionError("MCP result contained neither structuredContent nor JSON text")


async def main() -> None:
    env = dict(os.environ)
    env["BB_OFFLINE_FIXTURE"] = str(FIXTURE_DIR)
    env["BB_BASE_URL"] = "https://bb.cuhk.edu.cn"
    params = StdioServerParameters(command=sys.executable, args=[str(SERVER)], env=env)
    names: list[str] = []
    channel = ""
    course_id = ""
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = [tool.name for tool in tools.tools]
            assert names == EXPECTED_TOOLS, f"unexpected read-only tool surface: {names}"
            result = await session.call_tool("classic_snapshot", arguments={"include": ["announcements", "assignments", "files"]})
            payload, channel = _result_payload(result)
            assert payload["state"] == "ok", payload
            assert payload["timezone"] == "Asia/Shanghai", payload
            assert len(payload["courses"]) == 3, payload
            assert payload["assignments"], payload
            assert payload["files"], payload
            course_id = payload["courses"][0]["id"]
            for name, key in (
                ("classic_list_courses", "courses"),
                ("classic_announcements", "announcements"),
                ("classic_list_assignments", "assignments"),
                ("classic_assignment_details", "assignments"),
                ("classic_list_course_files", "files"),
            ):
                args = {} if name == "classic_list_courses" else {"course_id": course_id}
                check, _ = _result_payload(await session.call_tool(name, arguments=args))
                assert key in check and "errors" in check, (name, check)
    # These prints happen only after both stdio context managers have exited;
    # reaching them proves the MCP child transport closed cleanly.
    print("handshake ok, read-only tools:", names)
    print("fixture classic_snapshot ok via", channel)
    print("fixture resource calls ok for", course_id)
    print("stdio cleanup ok")


if __name__ == "__main__":
    asyncio.run(main())
