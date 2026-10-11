"""CUHK(SZ) Blackboard Classic read-only MCP sidecar.

The public MCP surface intentionally contains only read operations plus an
explicit, user-driven interactive login handshake.  There is no submission,
upload, or automatic credential tool.  Set ``BB_OFFLINE_FIXTURE`` to a
synthetic fixture directory to run the same stdio entry point without an
account or network access.
"""

from __future__ import annotations

from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from connector_runtime import ConnectorRuntime


mcp = FastMCP("bb-cuhk-classic")
runtime = ConnectorRuntime()


@mcp.tool()
async def classic_status() -> dict[str, Any]:
    """Report the current local Blackboard session state without exposing credentials."""

    return await runtime.call("status")


@mcp.tool()
async def classic_login(action: str = "begin") -> dict[str, Any]:
    """Start or complete the user-controlled official Blackboard login.

    ``action='begin'`` opens or reuses the visible persistent browser. The user
    completes login/MFA there before calling ``action='complete'``.
    No password, cookie, token, or credential file is accepted by this tool.
    """

    return await runtime.call("login", action)


@mcp.tool()
async def classic_snapshot(
    course_ids: Optional[list[str]] = None,
    include: Optional[list[str]] = None,
    limits: Optional[dict[str, int]] = None,
) -> dict[str, Any]:
    """Read one bounded Snapshot containing courses and selected resources."""

    return await runtime.call("snapshot", course_ids=course_ids, include=include, limits=limits)


@mcp.tool()
async def classic_list_courses() -> dict[str, Any]:
    """List courses visible to the authenticated user."""

    return await runtime.call("list_courses")


@mcp.tool()
async def classic_announcements(course_id: str, limit: int = 8) -> dict[str, Any]:
    """Read a course's announcements; unavailable dates remain null."""

    return await runtime.call("announcements", course_id, limit)


@mcp.tool()
async def classic_list_assignments(course_id: str, limit: int = 100) -> dict[str, Any]:
    """List assignment entries and evidence-backed due fields."""

    return await runtime.call("assignments", course_id, limit=limit)


@mcp.tool()
async def classic_assignment_details(
    course_id: str,
    keyword: str = "",
    limit: int = 100,
) -> dict[str, Any]:
    """Read assignment details with ``download`` permanently disabled."""

    return await runtime.call("assignments", course_id, keyword=keyword, details=True, limit=limit)


@mcp.tool()
async def classic_list_course_files(course_id: str, limit: int = 100) -> dict[str, Any]:
    """List course files and their page evidence; never downloads them."""

    return await runtime.call("files", course_id, limit)


def main() -> None:
    """Run the stdio MCP server and close the browser on process exit."""

    try:
        mcp.run()
    finally:
        runtime.close_sync()


if __name__ == "__main__":
    main()
