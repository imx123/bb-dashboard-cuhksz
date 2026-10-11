"""Read-only Blackboard Learn Classic connector.

This module keeps the navigation strategy from changshenhan/bb-mcp at commit
1a2ea2625ea87f42e4597347813c44291e6c2553 (portal tab, course launcher,
``listContent`` content areas, announcement menu and assessment links), while
separating the page-to-data conversion into pure functions.  The pure
functions are intentionally dependency-free and are used by synthetic DOM
fixtures as well as the Playwright reader.

No login credentials are read here.  A manual AuthProvider opens the official
school page in a user-visible persistent browser profile and reports the next
step to the caller.  All connector operations are GET/DOM reads.  Submission
and download operations are not exposed by this sidecar.
"""

from __future__ import annotations

import atexit
import hashlib
import html as html_lib
import os
import re
import threading
import time
import read_diagnostics
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Protocol, Sequence
from urllib.parse import parse_qs, unquote, urljoin, urlsplit, urlunsplit


SCHOOL_ORIGIN = "https://bb.cuhk.edu.cn"
SCHOOL_HOST = "bb.cuhk.edu.cn"
PORTAL_TAB = "/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_2_1"
# Blackboard installations can assign the user's first visible portal tab a
# different stable group id.  Keep the small set of observed Classic entry
# URLs explicit; never construct a candidate from renderer/user input.
AUTH_PORTAL_CANDIDATES = (
    "/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1",
    PORTAL_TAB,
    "/webapps/portal/frameset.jsp?tab_tab_group_id=_1_1&url=%2F",
    "/webapps/portal/frameset.jsp?tab_tab_group_id=_2_1&url=%2F",
    "/webapps/portal/execute/defaultTab?tab_tab_group_id=_1_1",
    "/webapps/portal/execute/defaultTab?tab_tab_group_id=_2_1",
)
LAUNCHER = "/webapps/blackboard/execute/launcher?type=Course&id={course_id}&url="
READ_ONLY_TOOLS = (
    "classic_status",
    "classic_login",
    "classic_snapshot",
    "classic_list_courses",
    "classic_announcements",
    "classic_list_assignments",
    "classic_assignment_details",
    "classic_list_course_files",
)

ERROR_CODES = {
    "AUTH_REQUIRED",
    "AUTH_CHECK_UNRECOGNIZED",
    "SESSION_EXPIRED",
    "CONNECTOR_START_FAILED",
    "COURSE_PARSE_CHANGED",
    "PARTIAL_RESULTS",
    "TIMEOUT",
    "FORBIDDEN",
    "UNSAFE_URL",
    "INVALID_INPUT",
    "COURSE_NOT_FOUND",
    "FIXTURE_NOT_FOUND",
    "FIXTURE_PARSE_FAILED",
}

TIMEZONE_NAME = "Asia/Shanghai"
SHANGHAI = timezone(timedelta(hours=8), name="+08:00")


def _configure_playwright_browsers_path() -> None:
    """Use the project-local browser cache when the host supplied one exists.

    This only changes the child Python process environment.  An explicit
    ``PLAYWRIGHT_BROWSERS_PATH`` always wins, and installed deployments fall
    back to Playwright's normal cache when the project cache is absent.
    """

    if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        return
    module_root = Path(__file__).resolve().parents[2]
    candidates = (module_root / ".work" / "ms-playwright", Path.cwd() / ".work" / "ms-playwright")
    seen: set[Path] = set()
    for candidate in candidates:
        candidate = candidate.resolve()
        if candidate in seen:
            continue
        seen.add(candidate)
        if candidate.is_dir() and any(candidate.glob("chromium-*")):
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(candidate)
            return

COURSE_KEYS = ("id", "name", "code", "url")
ANNOUNCEMENT_KEYS = ("id", "courseId", "title", "body", "publishedAt", "url", "unread")
ASSIGNMENT_KEYS = (
    "id",
    "courseId",
    "title",
    "dueAt",
    "dueDateOnly",
    "dueEvidence",
    "url",
    "remoteSubmission",
    "summary",
    "attachments",
)
COURSE_FILE_KEYS = ("id", "courseId", "name", "url", "publishedAt")
SNAPSHOT_KEYS = (
    "state",
    "fetchedAt",
    "timezone",
    "courses",
    "announcements",
    "assignments",
    "files",
    "errors",
)


class ConnectorError(RuntimeError):
    """A safe, user-facing connector error with a stable code."""

    def __init__(self, code: str, message: str, *, scope: str = "connector") -> None:
        if code not in ERROR_CODES:
            code = "CONNECTOR_START_FAILED"
        # Error messages are intentionally short and never contain page text,
        # credentials, cookies, request headers or local profile paths.
        super().__init__(message[:240])
        self.code = code
        self.scope = scope


@dataclass(frozen=True)
class Course:
    id: str
    name: str
    code: str | None = None
    url: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "code": self.code, "url": self.url}


@dataclass(frozen=True)
class Announcement:
    id: str
    course_id: str
    title: str
    body: str
    published_at: str | None = None
    url: str | None = None
    unread: bool | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "courseId": self.course_id,
            "title": self.title,
            "body": self.body,
            "publishedAt": self.published_at,
            "url": self.url,
            "unread": self.unread,
        }


@dataclass(frozen=True)
class Assignment:
    id: str
    course_id: str
    title: str
    due_at: str | None = None
    due_date_only: str | None = None
    due_evidence: str = "unknown"
    url: str | None = None
    remote_submission: str = "unknown"
    summary: str | None = None
    attachments: tuple[dict[str, str | None], ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "courseId": self.course_id,
            "title": self.title,
            "dueAt": self.due_at,
            "dueDateOnly": self.due_date_only,
            "dueEvidence": self.due_evidence,
            "url": self.url,
            "remoteSubmission": self.remote_submission,
            "summary": self.summary,
            "attachments": [dict(a) for a in self.attachments],
        }


@dataclass(frozen=True)
class CourseFile:
    id: str
    course_id: str
    name: str
    url: str | None = None
    published_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "courseId": self.course_id,
            "name": self.name,
            "url": self.url,
            "publishedAt": self.published_at,
        }


@dataclass(frozen=True)
class Snapshot:
    state: str
    fetched_at: str
    courses: tuple[dict[str, Any], ...] = ()
    announcements: tuple[dict[str, Any], ...] = ()
    assignments: tuple[dict[str, Any], ...] = ()
    files: tuple[dict[str, Any], ...] = ()
    errors: tuple[dict[str, str], ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "fetchedAt": self.fetched_at,
            "timezone": TIMEZONE_NAME,
            "courses": [dict(x) for x in self.courses],
            "announcements": [dict(x) for x in self.announcements],
            "assignments": [dict(x) for x in self.assignments],
            "files": [dict(x) for x in self.files],
            "errors": [dict(x) for x in self.errors],
        }


@dataclass(frozen=True)
class _FetchedContent:
    """HTML gathered from a validated Classic course navigation.

    The boolean is navigation evidence, not a parser override for arbitrary
    HTML.  It is set only after the live reader has visited an allowlisted
    course launcher/content route (or the connector has selected a named
    offline fixture).  Resource parsers still reject login/permission pages
    and malformed resource rows.
    """

    html: str
    verified_course_page: bool = False
    errors: tuple[tuple[str, str], ...] = ()
    pages_read: int = 0


@dataclass(frozen=True)
class _SidebarEntry:
    kind: str
    url: str
    label: str = ""


@dataclass(frozen=True)
class _SidebarRead:
    entries: tuple[_SidebarEntry, ...] = ()
    recognized: bool = False
    errors: tuple[tuple[str, str], ...] = ()


def _scoped_content_errors(content: _FetchedContent | None, scope: str) -> list[dict[str, str]]:
    if content is None:
        return []
    return [{"scope": scope, "code": code, "message": message} for code, message in content.errors]


def now_iso() -> str:
    """Return an explicit +08:00 timestamp for the public contract."""

    return datetime.now(SHANGHAI).isoformat(timespec="seconds")


def _safe_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def _default_user_data_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "CUHKBlackboardDashboard" / "classic-profile"
    return Path.home() / ".cuhk-blackboard-dashboard" / "classic-profile"


@dataclass(frozen=True)
class ConnectorConfig:
    """Runtime configuration with safe defaults and bounded request limits."""

    base_url: str = SCHOOL_ORIGIN
    user_data_dir: Path = field(default_factory=_default_user_data_dir)
    timeout_ms: int = 45_000
    # A snapshot visits several pages per course.  Keep one bounded budget for
    # the whole read so a slow course produces a partial result instead of
    # making the MCP caller reset the live authorization context.
    snapshot_timeout_ms: int = 180_000
    retries: int = 2
    max_courses: int = 50
    max_announcements: int = 20
    max_assignments: int = 100
    max_files: int = 100
    max_content_areas: int = 12
    max_content_pages: int = 48
    max_folder_depth: int = 2
    fixture_dir: Path | None = None

    @classmethod
    def from_env(cls) -> "ConnectorConfig":
        base = safe_school_url(os.environ.get("BB_BASE_URL", SCHOOL_ORIGIN), allow_relative=False)
        raw_profile = os.environ.get("BB_USER_DATA_DIR")
        profile = Path(raw_profile).expanduser() if raw_profile else _default_user_data_dir()
        fixture = os.environ.get("BB_OFFLINE_FIXTURE")
        fixture_dir = Path(fixture).expanduser() if fixture else None
        return cls(
            base_url=base.rstrip("/"),
            user_data_dir=profile,
            timeout_ms=_safe_int_env("BB_TIMEOUT_MS", 45_000, 5_000, 120_000),
            snapshot_timeout_ms=_safe_int_env("BB_SNAPSHOT_TIMEOUT_MS", 180_000, 30_000, 600_000),
            retries=_safe_int_env("BB_RETRIES", 2, 0, 3),
            max_courses=_safe_int_env("BB_MAX_COURSES", 50, 1, 50),
            max_announcements=_safe_int_env("BB_MAX_ANNOUNCEMENTS", 20, 1, 50),
            max_assignments=_safe_int_env("BB_MAX_ASSIGNMENTS", 100, 1, 200),
            max_files=_safe_int_env("BB_MAX_FILES", 100, 1, 200),
            max_content_areas=_safe_int_env("BB_MAX_CONTENT_AREAS", 12, 1, 12),
            max_content_pages=_safe_int_env("BB_MAX_CONTENT_PAGES", 48, 1, 100),
            max_folder_depth=_safe_int_env("BB_MAX_FOLDER_DEPTH", 2, 0, 2),
            fixture_dir=fixture_dir,
        )


def safe_school_url(value: str, *, base_url: str = SCHOOL_ORIGIN, allow_relative: bool = True) -> str:
    """Validate a URL before it is displayed or visited.

    Only HTTPS URLs on the CUHK(SZ) Blackboard host are accepted.  Relative
    page links are resolved against that host.  Credentials, non-default ports,
    control characters and dangerous schemes are rejected.
    """

    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
        raise ConnectorError("UNSAFE_URL", "URL rejected by the school allowlist")
    raw = value.strip()
    if not allow_relative and not raw.lower().startswith("https://"):
        raise ConnectorError("UNSAFE_URL", "URL rejected by the school allowlist")
    target = urljoin(base_url.rstrip("/") + "/", raw) if allow_relative else raw
    parsed = urlsplit(target)
    if parsed.scheme.lower() != "https" or parsed.hostname is None:
        raise ConnectorError("UNSAFE_URL", "URL rejected by the school allowlist")
    host = parsed.hostname.rstrip(".").lower()
    if host != SCHOOL_HOST or parsed.username or parsed.password:
        raise ConnectorError("UNSAFE_URL", "URL rejected by the school allowlist")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ConnectorError("UNSAFE_URL", "URL rejected by the school allowlist") from exc
    if port not in (None, 443):
        raise ConnectorError("UNSAFE_URL", "URL rejected by the school allowlist")
    decoded_path = unquote(parsed.path).replace("\\", "/")
    if any(ord(c) < 32 for c in decoded_path) or any(part == ".." for part in decoded_path.split("/")):
        raise ConnectorError("UNSAFE_URL", "URL rejected by the school allowlist")
    # Fragments never need to be sent to the server and can carry script-like
    # data in untrusted DOM.  Dropping them keeps returned links canonical.
    normalized = urlunsplit(("https", SCHOOL_HOST, parsed.path or "/", parsed.query, ""))
    return normalized


def _safe_course_id(course_id: str) -> str:
    if not isinstance(course_id, str) or not re.fullmatch(r"_[0-9]+_1", course_id.strip()):
        raise ConnectorError("INVALID_INPUT", "courseId must be a Blackboard course identifier")
    return course_id.strip()


def _classic_course_link(href: str) -> str | None:
    """Return a course id only for known Blackboard Classic course routes.

    A bare ``?id=_123_1`` link is common in public help pages and is not
    evidence that the current user has an authenticated course portal.  Keep
    the auth probe narrower than the course parser: count only the portal
    course launcher and known Classic course/content routes.
    """

    raw = html_lib.unescape(unquote(str(href or "").strip()))
    if not raw:
        return None
    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc:
        if parsed.scheme.casefold() != "https" or (parsed.hostname or "").rstrip(".").casefold() != SCHOOL_HOST:
            return None
        try:
            if parsed.port not in (None, 443):
                return None
        except ValueError:
            return None
    path = parsed.path.rstrip("/").casefold() or "/"
    query = parse_qs(parsed.query, keep_blank_values=True)

    def valid(value: str | None) -> str | None:
        return value if value and re.fullmatch(r"_[0-9]+_1", value) else None

    def route_course_id(route: str, route_query: Mapping[str, list[str]]) -> str | None:
        if route == "/webapps/portal/execute/tabs/tabaction":
            if route_query.get("type", [""])[0].casefold() != "course":
                return None
            return valid(route_query.get("id", [""])[0]) or valid(route_query.get("course_id", [""])[0])
        if route == "/webapps/blackboard/execute/launcher":
            if route_query.get("type", [""])[0].casefold() != "course":
                return None
            return valid(route_query.get("id", [""])[0]) or valid(route_query.get("course_id", [""])[0])
        if route in {
            "/webapps/blackboard/execute/coursemain",
            "/webapps/blackboard/execute/modulepage/view",
            "/webapps/blackboard/content/listcontent.jsp",
        }:
            return valid(route_query.get("course_id", [""])[0])
        return None

    direct = route_course_id(path, query)
    if direct:
        return direct
    # Some Classic portal launchers put the course route in the allowlisted
    # ``url`` query value.  Inspect only that known nested route and its id.
    if path == "/webapps/portal/execute/tabs/tabaction":
        for nested in query.get("url", []):
            nested_parsed = urlsplit(html_lib.unescape(unquote(nested)))
            nested_path = nested_parsed.path.rstrip("/").casefold() or "/"
            nested_query = parse_qs(nested_parsed.query, keep_blank_values=True)
            nested_id = route_course_id(nested_path, nested_query)
            if nested_id:
                return nested_id
    return None


def _safe_limit(value: Any, default: int, maximum: int) -> int:
    if value is None:
        return default
    try:
        n = int(value)
    except (TypeError, ValueError) as exc:
        raise ConnectorError("INVALID_INPUT", "limit must be an integer") from exc
    if n < 1:
        raise ConnectorError("INVALID_INPUT", "limit must be positive")
    return min(n, maximum)


def _safe_or_none(url: str | None, *, base_url: str = SCHOOL_ORIGIN) -> str | None:
    if not url:
        return None
    try:
        return safe_school_url(url, base_url=base_url)
    except ConnectorError:
        return None


def _assert_page_school_url(page: Any, *, base_url: str = SCHOOL_ORIGIN) -> str:
    """Reject redirects that leave the configured school HTTPS origin."""

    try:
        return safe_school_url(page.url, base_url=base_url, allow_relative=False)
    except ConnectorError as exc:
        raise ConnectorError("UNSAFE_URL", "学校页面跳转超出 URL 白名单", scope="navigation") from exc


def _clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = html_lib.unescape(value).replace("\u00a0", " ")
    value = re.sub(r"[ \t\f\v]+", " ", value)
    value = re.sub(r"\n[ \t]+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def _id(prefix: str, course_id: str, link: str | None, fallback: str) -> str:
    basis = link or fallback
    return f"{prefix}:{course_id}:{hashlib.sha256(basis.encode('utf-8')).hexdigest()[:20]}"


class _Node:
    __slots__ = ("tag", "attrs", "parent", "children", "parts", "_order")

    def __init__(self, tag: str, attrs: Mapping[str, str] | None = None, parent: "_Node | None" = None):
        self.tag = tag.lower()
        self.attrs = {str(k).lower(): str(v or "") for k, v in (attrs or {}).items()}
        self.parent = parent
        self.children: list[_Node] = []
        self.parts: list[str] = []
        self._order: list[str | _Node] = []

    def text(self) -> str:
        return _clean_text("".join(part if isinstance(part, str) else part.text() for part in self._order))

    def has_class(self, needle: str) -> bool:
        return needle.casefold() in self.attrs.get("class", "").casefold().split()

    def classes_contain(self, needle: str) -> bool:
        return needle.casefold() in self.attrs.get("class", "").casefold()

    def descendants(self, tag: str | None = None) -> Iterator["_Node"]:
        for child in self.children:
            if tag is None or child.tag == tag:
                yield child
            yield from child.descendants(tag)

    def ancestors(self) -> Iterator["_Node"]:
        p = self.parent
        while p is not None:
            yield p
            p = p.parent


class _DOMParser(HTMLParser):
    _VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    _BREAK = {"br", "div", "li", "p", "section", "article", "h1", "h2", "h3", "h4", "h5", "tr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("document")
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        parent = self.stack[-1]
        tag = tag.lower()
        if tag in self._BREAK:
            parent.parts.append("\n")
            parent._order.append("\n")
        node = _Node(tag, dict(attrs), parent)
        parent.children.append(node)
        parent._order.append(node)
        if tag not in self._VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag.lower() and tag.lower() not in self._VOID:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].parts.append(data)
        self.stack[-1]._order.append(data)


def _parse_dom(source: str) -> _Node:
    parser = _DOMParser()
    try:
        parser.feed(source or "")
        parser.close()
    except Exception as exc:
        raise ConnectorError("COURSE_PARSE_CHANGED", "Blackboard page could not be parsed") from exc
    return parser.root


def _anchors(node: _Node) -> Iterator[_Node]:
    yield from node.descendants("a")


def _anchor_href(anchor: _Node, *, base_url: str = SCHOOL_ORIGIN) -> str | None:
    return _safe_or_none(anchor.attrs.get("href"), base_url=base_url)


def parse_courses(source: str, *, base_url: str = SCHOOL_ORIGIN, limit: int = 50) -> list[dict[str, Any]]:
    """Parse the upstream portal course links into stable Course dictionaries."""

    root = _parse_dom(source)
    seen: set[str] = set()
    courses: list[dict[str, Any]] = []
    for anchor in _anchors(root):
        raw_href = anchor.attrs.get("href", "")
        decoded = unquote(raw_href)
        match = re.search(r"(?:^|[?&])id=(_[0-9]+_1)(?:&|$)", decoded)
        if not match:
            continue
        title = _clean_text(anchor.text())
        if not title:
            continue
        course_id = match.group(1)
        if course_id in seen:
            continue
        seen.add(course_id)
        courses.append(Course(course_id, title, url=_anchor_href(anchor, base_url=base_url)).as_dict())
        if len(courses) >= limit:
            break
    return courses


_EMPTY_PAGE_PATTERNS: Mapping[str, re.Pattern[str]] = {
    # An empty result is accepted only when the page names the resource whose
    # collection is empty.  Generic status text such as ``Content not
    # available`` is deliberately absent: it can mean a permission failure or
    # an unrecognised Blackboard skin just as easily as a real empty list.
    "courses": re.compile(
        r"\bno\s+(?:courses?|enrolled\s+courses?)\b|"
        r"\bcurrently\s+there\s+are\s+no\s+courses?\b|"
        r"暂无课程|没有(?:发布|可用)?课程",
        re.I,
    ),
    "announcements": re.compile(
        r"\bno\s+announcements?\b|"
        r"\bcurrently\s+there\s+are\s+no\s+announcements?\b|"
        r"暂无公告|没有(?:发布|可用)?公告",
        re.I,
    ),
    "assignments": re.compile(
        r"\bno\s+(?:assignments?|assignment\s+(?:items?|entries?)|content\s+items?)\b|"
        r"暂无(?:作业|内容)|没有(?:发布|可用)?(?:作业|内容)",
        re.I,
    ),
    "files": re.compile(
        r"\bno\s+(?:files?|file\s+links?|content\s+items?)\b|"
        r"暂无(?:资料|文件|内容)|没有(?:发布|可用)?(?:资料|文件|内容)",
        re.I,
    ),
}


def _explicit_empty_page(root: _Node, resource: str) -> bool:
    pattern = _EMPTY_PAGE_PATTERNS.get(resource)
    return bool(pattern and pattern.search(root.text()))


_CLASSIC_COURSE_SHELL_MARKERS = (
    "coursemain",
    "coursemainframe",
    "coursemenu",
    "coursemenu_palette",
    "coursemenupalette",
)
_CLASSIC_CONTENT_SHELL_MARKERS = (
    "content_listcontainer",
    "contentlistcontainer",
    "contentpanel",
    "contentwrapper",
    "contentarea",
    "contentlist",
    "listcontent",
)
_CLASSIC_COURSE_ROUTE_PATHS = {
    "/webapps/blackboard/execute/launcher",
    "/webapps/blackboard/execute/coursemain",
    "/webapps/blackboard/execute/modulepage/view",
    # A Classic launcher may land on the course's announcement page before
    # the menu frame is attached.  It is still a same-course document source;
    # the resource href allowlist below remains independent.
    "/webapps/blackboard/execute/announcement",
    "/webapps/blackboard/execute/announcementmanager",
    "/webapps/blackboard/content/listcontent.jsp",
    "/webapps/blackboard/content/contentwrapper.jsp",
}

# Classic skins use a small family of course-menu containers.  The menu text
# is configurable, so resource discovery is based on the allowlisted href
# routes and the actual menu container rather than English labels.
_CLASSIC_SIDEBAR_MARKERS = (
    "coursemenu",
    "coursemenucontents",
    "coursemenuitems",
    "coursemenucontainer",
    "coursemenu_palette",
    "coursemenupalette",
    "coursemenuframe",
)
_SIDEBAR_SKIP_LABELS = frozenset(
    {"tool", "tools", "help", "group", "groups", "discussion", "discussions", "工具", "帮助", "群组", "讨论"}
)
_SIDEBAR_SKIP_ROUTE_SEGMENTS = {
    "tool",
    "tools",
    "help",
    "group",
    "groups",
    "discussion",
    "discussions",
}
_CLASSIC_CONTENT_ENTRY_PATHS = {
    "/webapps/blackboard/content/listcontent.jsp",
    "/webapps/blackboard/content/contentwrapper.jsp",
}
_CLASSIC_ANNOUNCEMENT_ENTRY_PATHS = {
    "/webapps/blackboard/execute/announcement",
    "/webapps/blackboard/execute/announcementmanager",
}


def _node_identity(node: _Node) -> str:
    return re.sub(
        r"[^a-z0-9]",
        "",
        f"{node.attrs.get('id', '')} {node.attrs.get('class', '')}".casefold(),
    )


def _course_query_id(value: str) -> str | None:
    parsed = urlsplit(value)
    query = {key.casefold(): values for key, values in parse_qs(parsed.query, keep_blank_values=True).items()}
    keys = ["course_id", "courseid"]
    path = parsed.path.rstrip("/").casefold() or "/"
    if path in {
        "/webapps/blackboard/execute/launcher",
        "/webapps/blackboard/execute/coursemain",
        "/webapps/blackboard/execute/announcement",
        "/webapps/blackboard/execute/announcementmanager",
    }:
        keys.append("id")
    for key in keys:
        candidate = query.get(key, [""])[0]
        if re.fullmatch(r"_[0-9]+_1", candidate or ""):
            return candidate
    return None


def _course_query_matches(value: str, course_id: str) -> bool:
    parsed = urlsplit(value)
    query = {key.casefold(): values for key, values in parse_qs(parsed.query, keep_blank_values=True).items()}
    for key in ("course_id", "courseid"):
        values = query.get(key)
        if values and values[0] != course_id:
            return False
    # Some Classic launcher/frame routes use ``id`` for the course.  Only
    # treat an id as a course binding when it has Blackboard's course-id
    # shape; item/file ids remain governed by their own route checks.
    path = parsed.path.rstrip("/").casefold() or "/"
    if path in {
        "/webapps/blackboard/execute/launcher",
        "/webapps/blackboard/execute/coursemain",
        "/webapps/blackboard/execute/announcement",
        "/webapps/blackboard/execute/announcementmanager",
    }:
        id_values = query.get("id")
        if id_values and re.fullmatch(r"_\d+_1", id_values[0] or "") and id_values[0] != course_id:
            return False
    return True


def _is_skip_sidebar_entry(label: str, href: str) -> bool:
    clean_label = _clean_text(label)
    if clean_label.casefold() in _SIDEBAR_SKIP_LABELS:
        return True
    path_parts = [part.casefold() for part in urlsplit(href).path.split("/") if part]
    return any(part in _SIDEBAR_SKIP_ROUTE_SEGMENTS for part in path_parts)


def _raw_sidebar_supported_hint(raw_href: str) -> bool:
    low = html_lib.unescape(unquote(str(raw_href or ""))).casefold()
    return any(
        marker in low
        for marker in (
            "listcontent",
            "contentwrapper",
            "announcement",
            "bbcswebdav",
            "@xid",
            ".pdf",
            ".doc",
            ".xls",
            ".ppt",
            ".zip",
        )
    )


def _resolve_page_href(raw_href: str, source_url: str, *, base_url: str) -> str:
    """Resolve a DOM link against its owning page/frame before validation."""

    raw = html_lib.unescape(unquote(str(raw_href or "").strip()))
    if not raw or raw.startswith("#"):
        raise ConnectorError("UNSAFE_URL", "课程入口 URL 未通过安全校验")
    target = urljoin(source_url, raw)
    return safe_school_url(target, base_url=base_url, allow_relative=False)


def _absolutize_safe_hrefs(source: str, source_url: str, *, base_url: str) -> str:
    """Give parsers the same page/frame base used by sidebar traversal."""

    pattern = re.compile(r"(\bhref\s*=\s*)([\"'])(.*?)(\2)", re.I | re.S)

    def replace(match: re.Match[str]) -> str:
        raw = match.group(3)
        try:
            resolved = _resolve_page_href(raw, source_url, base_url=base_url)
        except ConnectorError:
            return match.group(0)
        return f"{match.group(1)}{match.group(2)}{html_lib.escape(resolved, quote=True)}{match.group(4)}"

    return pattern.sub(replace, source or "")


def _classic_sidebar_entry_kind(url: str, course_id: str) -> str | None:
    """Classify a real course-menu href without accepting arbitrary pages."""

    kind = _classic_sidebar_entry_kind_hint(url)
    if kind is None or not _course_query_matches(url, course_id):
        return None
    query_course = _course_query_id(url)
    if kind != "file" and query_course != course_id:
        return None
    return kind


def _classic_sidebar_entry_kind_hint(url: str) -> str | None:
    """Classify a supported resource route before applying course binding."""

    parsed = urlsplit(url)
    path = parsed.path.rstrip("/").casefold() or "/"
    if _is_file_href(url):
        # Blackboard file/blob links commonly omit course_id.  They are safe
        # here because the owning DOM was already proven to be this course's
        # sidebar.  A supplied id is checked by the caller.
        return "file"
    if path in _CLASSIC_CONTENT_ENTRY_PATHS:
        query_keys = {key.casefold() for key in parse_qs(parsed.query, keep_blank_values=True)}
        return "announcements" if "announcement" in query_keys else "content"
    if path in _CLASSIC_ANNOUNCEMENT_ENTRY_PATHS:
        return "announcements"
    return None


def _sidebar_roots(root: _Node) -> list[_Node]:
    """Return only explicit Classic menu/navigation containers."""

    roots: list[_Node] = []
    for node in root.descendants():
        identity = _node_identity(node)
        if any(marker.replace("_", "") in identity for marker in _CLASSIC_SIDEBAR_MARKERS):
            roots.append(node)
    if roots:
        # Do not scan every nested menu container twice.
        root_set = set(roots)
        return [node for node in roots if not any(parent in root_set for parent in node.ancestors())]
    # A few Classic skins omit the courseMenu id but retain a navigation
    # element.  Use it only when it contains a supported course href; callers
    # still classify every anchor with the course/origin allowlist.
    for node in root.descendants():
        identity = _node_identity(node)
        if node.tag not in {"nav", "ul", "ol", "div"}:
            continue
        if not any(token in identity for token in ("sidebar", "navigation", "navarea", "menu")):
            continue
        if any(_raw_sidebar_supported_hint(anchor.attrs.get("href", "")) for anchor in _anchors(node)):
            roots.append(node)
    root_set = set(roots)
    return [node for node in roots if not any(parent in root_set for parent in node.ancestors())]


def _content_navigation_roots(root: _Node) -> list[_Node]:
    """Find nested content-folder navigation without scanning arbitrary body links."""

    roots = [
        node
        for node in root.descendants()
        if any(
            marker.replace("_", "") in _node_identity(node)
            for marker in (
                "content_listContainer",
                "contentlistcontainer",
                "contentlist",
                "contentarea",
                "contentpanel",
                "contentwrapper",
            )
        )
    ]
    root_set = set(roots)
    return [node for node in roots if not any(parent in root_set for parent in node.ancestors())]


def _known_course_route(value: str | None, course_id: str) -> bool:
    """Recognize only allowlisted Classic routes for this course."""

    if not value:
        return False
    try:
        normalized = safe_school_url(value, base_url=SCHOOL_ORIGIN)
    except ConnectorError:
        return False
    parsed = urlsplit(normalized)
    path = parsed.path.rstrip("/").casefold() or "/"
    if path not in _CLASSIC_COURSE_ROUTE_PATHS:
        return False
    query = parse_qs(parsed.query, keep_blank_values=True)
    if path in {
        "/webapps/blackboard/execute/launcher",
        "/webapps/blackboard/execute/coursemain",
        "/webapps/blackboard/execute/announcement",
        "/webapps/blackboard/execute/announcementmanager",
    }:
        return _course_query_id(normalized) == course_id
    return any(query.get(key, [""])[0] == course_id for key in ("course_id", "courseid"))


def _source_has_sidebar_structure(source: str) -> bool:
    """Require an actual Classic menu/navigation container before inheritance."""

    try:
        return bool(_sidebar_roots(_parse_dom(source)))
    except ConnectorError:
        return False


def _source_has_current_course_route(
    source: str,
    course_id: str,
    *,
    source_url: str = SCHOOL_ORIGIN,
) -> bool:
    """Find a same-course route advertised by a shell document's DOM."""

    try:
        root = _parse_dom(source)
    except ConnectorError:
        return False
    for node in root.descendants():
        for attribute in ("href", "src", "action", "data-url", "data-href"):
            raw = html_lib.unescape(unquote(str(node.attrs.get(attribute, "") or "").strip()))
            if not raw:
                continue
            candidate = urljoin(source_url, raw)
            if _known_course_route(candidate, course_id):
                return True
    return False


def _document_has_login_marker(root: _Node) -> bool:
    """Reject a login response before it can look like an empty course page."""

    for node in root.descendants("input"):
        if node.attrs.get("type", "").casefold() == "password":
            return True
    for form in root.descendants("form"):
        identity = " ".join(form.attrs.get(key, "") for key in ("id", "class", "name", "action", "method")).casefold()
        parsed_form = urlsplit(form.attrs.get("action", ""))
        form_query = parse_qs(parsed_form.query, keep_blank_values=True)
        form_logout = "logout" in parsed_form.path.casefold() or form_query.get("action", [""])[0].casefold() == "logout"
        if not form_logout and re.search(r"login|authvalidate|sign.?in", identity):
            return True
    for anchor in _anchors(root):
        href = html_lib.unescape(unquote(anchor.attrs.get("href", "")))
        parsed = urlsplit(href)
        path = parsed.path.casefold()
        query = parse_qs(parsed.query, keep_blank_values=True)
        logout_action = "logout" in path or query.get("action", [""])[0].casefold() == "logout"
        login_action = "/webapps/login" in path or query.get("action", [""])[0].casefold() in {"login", "relogin"}
        if login_action and not logout_action:
            return True
    return False


def _document_has_course_route(root: _Node, course_id: str) -> bool:
    for node in root.descendants():
        for key in ("href", "action", "src", "data-url", "data-href"):
            if _known_course_route(node.attrs.get(key), course_id):
                return True
    return False


def _classic_course_structure(root: _Node) -> tuple[bool, bool, bool]:
    identities = {
        re.sub(r"[^a-z0-9]", "", f"{node.attrs.get('id', '')} {node.attrs.get('class', '')}".casefold())
        for node in root.descendants()
    }
    has_course_shell = any(any(marker.replace("_", "") in identity for marker in _CLASSIC_COURSE_SHELL_MARKERS) for identity in identities)
    has_content_shell = any(any(marker.replace("_", "") in identity for marker in _CLASSIC_CONTENT_SHELL_MARKERS) for identity in identities)
    has_content_item = any("contentitem" in identity for identity in identities)
    return has_course_shell, has_content_shell, has_content_item


def _has_classic_course_content_evidence(root: _Node, course_id: str) -> bool:
    """Require recognizable Classic course structure before accepting empty data.

    A valid content page may contain no assignment or file anchors.  The
    structural check is deliberately narrower than generic ``div``/text
    matching: course/content shell markers must be present, and contextual
    markers need a known route for the requested course.  Login/permission
    pages never satisfy this evidence.
    """

    if _document_has_login_marker(root):
        return False
    has_course_shell, has_content_shell, has_content_item = _classic_course_structure(root)
    has_route = _document_has_course_route(root, course_id)
    return bool(has_route and (has_course_shell or has_content_shell or has_content_item))


def _resource_page_allows_empty(root: _Node, course_id: str, *, verified_page: bool) -> bool:
    return bool(verified_page and not _document_has_login_marker(root)) or _has_classic_course_content_evidence(root, course_id)


def _verified_live_course_page(page_url: str | None, root: _Node, course_id: str) -> bool:
    """Combine a known course route with recognizable Classic DOM structure."""

    if not _known_course_route(page_url, course_id) or _document_has_login_marker(root):
        return False
    has_course_shell, has_content_shell, has_content_item = _classic_course_structure(root)
    return bool(has_course_shell or has_content_shell or has_content_item)


def _verified_fixture_course_page(source: str, course_id: str) -> bool:
    try:
        return _has_classic_course_content_evidence(_parse_dom(source), course_id)
    except ConnectorError:
        return False


def _has_recognized_course_resource(root: _Node) -> bool:
    """Recognize a resource page only from known Classic resource anchors."""

    for anchor in _anchors(root):
        raw_href = anchor.attrs.get("href", "")
        if _is_assignment_href(raw_href) and _clean_text(anchor.text()):
            return True
        if _is_file_href(raw_href):
            return True
    return False


def _has_valid_content_page_evidence(root: _Node, page_url: str | None, course_id: str) -> bool:
    return bool(
        _verified_live_course_page(page_url, root, course_id)
        or _has_recognized_course_resource(root)
        or _explicit_empty_page(root, "announcements")
        or _explicit_empty_page(root, "assignments")
        or _explicit_empty_page(root, "files")
    )


def _raise_if_auth_page(root: _Node, scope: str) -> None:
    text = root.text().casefold()
    if re.search(
        r"session\s+(?:has\s+)?expired|session\s+timed\s*out|session\s+timeout|"
        r"会话\s*(?:已|已经)?\s*过期|登录\s*(?:已|已经)?\s*过期|会话\s*超时|登录\s*超时",
        text,
    ):
        raise ConnectorError("SESSION_EXPIRED", "Blackboard 登录会话已过期，请重新登录", scope=scope)
    if _document_has_login_marker(root):
        raise ConnectorError("AUTH_REQUIRED", "Blackboard 登录页面仍在等待完成", scope=scope)


def _raise_if_forbidden(root: _Node, scope: str) -> None:
    text = root.text().casefold()
    if re.search(r"access\s+denied|permission\s+denied|not\s+authorized|无权|没有权限|权限不足", text):
        raise ConnectorError("FORBIDDEN", "当前账号无权读取此课程内容", scope=scope)


def parse_courses_checked(source: str, *, base_url: str = SCHOOL_ORIGIN, limit: int = 50) -> list[dict[str, Any]]:
    """Parse courses, rejecting an unrecognised portal layout explicitly."""

    root = _parse_dom(source)
    _raise_if_auth_page(root, "courses")
    _raise_if_forbidden(root, "courses")
    result = parse_courses(source, base_url=base_url, limit=limit)
    if not result and not _explicit_empty_page(root, "courses"):
        raise ConnectorError("COURSE_PARSE_CHANGED", "课程页面布局无法识别", scope="courses")
    return result


def _first_heading(block: _Node) -> _Node | None:
    for tag in ("h1", "h2", "h3", "h4", "h5"):
        for node in block.descendants(tag):
            return node
    for anchor in _anchors(block):
        if _clean_text(anchor.text()):
            return anchor
    return None


def _block_candidates(root: _Node, marker: str) -> list[_Node]:
    marker = marker.casefold()
    # ``announcementList``/``announcementsList`` are containers.  Prefer the
    # singular block classes used by Classic skins so a list is not collapsed
    # into one giant announcement.
    nodes = [
        n
        for n in root.descendants()
        if any(
            token == marker or token.startswith(marker + "item")
            for token in n.attrs.get("class", "").casefold().split()
        )
    ]
    if not nodes:
        containers = [n for n in root.descendants() if marker in n.attrs.get("id", "").casefold()]
        for container in containers:
            item_nodes = [
                item
                for item in container.descendants("li")
                if _first_heading(item) is not None
            ]
            nodes.extend(item_nodes or [container])
    selected: list[_Node] = []
    node_set = set(nodes)
    for node in nodes:
        if any(parent in node_set for parent in node.ancestors()):
            continue
        selected.append(node)
    return selected


_ISO_DATE = re.compile(
    r"(?P<y>20\d{2})[-/.](?P<m>\d{1,2})[-/.](?P<d>\d{1,2})"
    r"(?:[ T,]+(?P<h>\d{1,2})(?::(?P<mi>\d{2}))?(?::(?P<s>\d{2}))?\s*(?P<ampm>a\.?m\.?|p\.?m\.?)?)?",
    re.I,
)
_CN_DATE = re.compile(
    r"(?P<y>20\d{2})年\s*(?P<m>\d{1,2})月\s*(?P<d>\d{1,2})日?"
    r"(?:\s*(?P<h>\d{1,2})\s*(?:点|时)(?:(?P<mi>\d{1,2})\s*分?)?)?",
    re.I,
)
_EN_DATE = re.compile(
    r"(?:(?P<m>[A-Za-z]{3,9})\s+(?P<d>\d{1,2})(?:st|nd|rd|th)?[,]?\s+(?P<y>20\d{2})|"
    r"(?P<d2>\d{1,2})(?:st|nd|rd|th)?\s+(?P<m2>[A-Za-z]{3,9})\s+(?P<y2>20\d{2}))"
    r"(?:[, ]+(?P<h>\d{1,2})(?::(?P<mi>\d{2}))?\s*(?P<ampm>a\.?m\.?|p\.?m\.?)?)?",
    re.I,
)
_MONTHS = {name.lower(): i for i, name in enumerate(("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"), 1)}
_MONTHS.update({name[:3].lower(): i for name, i in list(_MONTHS.items()) if len(name) > 3})


def _format_date_match(match: re.Match[str], *, english: bool = False) -> tuple[str | None, str | None]:
    groups = match.groupdict()
    try:
        year = int(groups.get("y") or groups.get("y2") or 0)
        month_raw = groups.get("m") or groups.get("m2")
        month = int(month_raw) if month_raw and month_raw.isdigit() else _MONTHS.get((month_raw or "").lower(), 0)
        day = int(groups.get("d") or groups.get("d2") or 0)
        if not (year and month and day):
            return None, None
        hour_raw = groups.get("h")
        minute_raw = groups.get("mi")
        second_raw = groups.get("s")
        if hour_raw is None:
            return f"{year:04d}-{month:02d}-{day:02d}", f"{year:04d}-{month:02d}-{day:02d}"
        hour = int(hour_raw)
        minute = int(minute_raw or 0)
        second = int(second_raw or 0)
        ampm = (groups.get("ampm") or "").replace(".", "").lower()
        if ampm:
            if hour == 12:
                hour = 0
            if ampm == "pm":
                hour += 12
        dt = datetime(year, month, day, hour, minute, second, tzinfo=SHANGHAI)
        return dt.isoformat(timespec="seconds"), None
    except (TypeError, ValueError):
        return None, None


def _date_candidates(text: str) -> Iterator[tuple[int, int, str | None, str | None]]:
    for pattern, is_english in ((_ISO_DATE, False), (_CN_DATE, False), (_EN_DATE, True)):
        for match in pattern.finditer(text):
            at, end = match.span()
            at_value, date_only = _format_date_match(match, english=is_english)
            if at_value and date_only is None:
                # Blackboard skins may label an exact page time as UTC/GMT or
                # with a numeric offset.  Convert that evidence to the public
                # Asia/Shanghai contract; an unlabeled time remains local.
                zone = re.match(r"\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})\b", text[end : end + 12], re.I)
                if zone:
                    label = zone.group(1).upper()
                    if label in {"UTC", "GMT", "Z"}:
                        source_zone = timezone.utc
                    else:
                        sign = 1 if label[0] == "+" else -1
                        digits = label[1:].replace(":", "")
                        source_zone = timezone(sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:])))
                    at_value = datetime.fromisoformat(at_value).replace(tzinfo=source_zone).astimezone(SHANGHAI).isoformat(timespec="seconds")
            if at_value:
                yield at, end, at_value, date_only


def _first_date(text: str) -> tuple[str | None, str | None]:
    candidate = min(_date_candidates(text), default=None, key=lambda x: x[0])
    if candidate is None:
        return None, None
    return candidate[2], candidate[3]


_DUE_MARKER = re.compile(
    r"(?:due\s*(?:date|on|by)?|deadline|submission\s*(?:deadline|due(?:\s+date)?)|截止(?:日期|时间|于)?|提交截止|交作业截止)",
    re.I,
)

_DUE_FIELD_BOUNDARY = re.compile(
    r"(?:\b(?:published|posted|created|uploaded|upload(?:ed)?\s+date|updated|last\s+updated|available\s+from|"
    r"submission\s+(?:date|time|status)|submitted(?:\s+(?:date|time|at))?)\b|"
    r"(?:发布(?:于|日期)?|上传日期|更新时间|创建日期|公布日期|提交(?:日期|时间|状态)|已提交))\s*[:：]",
    re.I,
)

_DUE_PLACEHOLDER = re.compile(
    r"^\s*(?:[:：\-–—]\s*)?(?:"
    r"tba|tbd|pending|unknown|n/?a|none|no\s+due(?:\s+date)?|no\s+deadline|"
    r"to\s+be\s+(?:announced|confirmed|determined)|"
    r"not\s+(?:available|announced|specified|set)|"
    r"see(?:\s+[^\s:：,;]+)?|refer(?:\s+to)?|"
    r"待定|待确认|待公布|未公布|另行通知|见[^\s:：,;]*|暂无|无(?:日期|截止(?:日期|时间)?)?"
    r")(?:\s|[.,;:：()（）\-–—]|$)",
    re.I,
)
_EXPLICIT_NO_DUE = re.compile(
    r"\bno\s+(?:due(?:\s+date)?|deadline)|"
    r"无(?:截止日期|截止时间|截止|DDL)",
    re.I,
)
_STANDALONE_NO_DUE = re.compile(
    r"\bno\s+(?:due(?:\s+date)?|deadline)\b|无(?:截止日期|截止时间|截止|DDL)",
    re.I,
)


def parse_due(text: str) -> tuple[str | None, str | None, str]:
    """Return dueAt, dueDateOnly and evidence without treating publish dates as DDL."""

    normalized = _clean_text(text)
    no_due_spans = tuple(match.span() for match in _STANDALONE_NO_DUE.finditer(normalized))
    for marker in _DUE_MARKER.finditer(normalized):
        # ``No due date`` / ``无截止日期`` contains the same words as a due
        # marker.  Do not let dates in that phrase's following description
        # become a deadline; a separate later Due field remains eligible.
        if any(start <= marker.start() < end for start, end in no_due_spans):
            continue
        tail = normalized[marker.end() : marker.end() + 220]
        # A Due/Deadline marker owns only its field.  Stop before publication,
        # upload, or other metadata fields so a later date cannot become a
        # fabricated deadline.  Placeholders such as TBA and "see ..." also
        # explicitly block dates that happen to follow them.
        boundary = _DUE_FIELD_BOUNDARY.search(tail)
        due_field = tail[: boundary.start()] if boundary else tail
        if _DUE_PLACEHOLDER.match(due_field):
            continue
        date = min(_date_candidates(due_field), default=None, key=lambda x: x[0])
        if date is None:
            continue
        at_value, date_only = date[2], date[3]
        if date_only is not None:
            return None, date_only, "page-text"
        return at_value, None, "page-text"
    return None, None, "unknown"


def _explicit_no_due(text: str) -> bool:
    """Recognize only an explicit no-due value for the current due field."""

    normalized = _clean_text(text)
    bound_no_due = False
    for marker in _DUE_MARKER.finditer(normalized):
        tail = normalized[marker.end() : marker.end() + 220]
        boundary = _DUE_FIELD_BOUNDARY.search(tail)
        due_field = tail[: boundary.start()] if boundary else tail
        stripped_field = due_field.strip(" :：-–—.,;()（）")
        # Generic placeholders (None, Unknown, N/A, TBA, ...) are unknown
        # evidence.  They must not clear a list value.  Only an explicit
        # no-due phrase bound to this marker can clear it.
        if _EXPLICIT_NO_DUE.fullmatch(stripped_field):
            bound_no_due = True

    # A standalone "No due date" / "No deadline" label has no text after a
    # due marker for the loop above to inspect.  A valid due field wins over
    # any unrelated later phrase; otherwise the explicit phrase is enough to
    # clear the list value.  Generic "None" in later metadata is ignored.
    due_at, due_only, _ = parse_due(normalized)
    has_due_value = due_at is not None or due_only is not None
    if has_due_value:
        return False
    return bound_no_due or bool(_STANDALONE_NO_DUE.search(normalized))


def _assignment_parent(anchor: _Node) -> _Node:
    for parent in anchor.ancestors():
        if parent.tag == "li" or parent.classes_contain("contentitem"):
            return parent
    return anchor


def _is_assignment_href(href: str) -> bool:
    lower = href.lower()
    return "uploadassignment" in lower or "/webapps/assessment/" in lower or "upload.jsp" in lower


ASMT_PAT = re.compile(r"assignment|homework|quiz|project|作业|实验报告", re.I)


def parse_announcements(
    source: str,
    course_id: str,
    *,
    base_url: str = SCHOOL_ORIGIN,
    limit: int = 20,
) -> list[dict[str, Any]]:
    root = _parse_dom(source)
    _raise_if_forbidden(root, f"course:{course_id}:announcements")
    blocks = _block_candidates(root, "announcement")
    if not blocks:
        # Upstream falls back to h3 when the Classic skin omits announcement
        # classes.  Require an announcement marker somewhere on the page so a
        # redesigned arbitrary content page cannot become a false success.
        blocks = []
        has_marker = any(
            "announcement" in (node.attrs.get("id", "") + " " + node.attrs.get("class", "")).casefold()
            for node in root.descendants()
        )
        if has_marker:
            for heading in root.descendants("h3"):
                for parent in heading.ancestors():
                    if parent.tag in {"li", "div"}:
                        blocks.append(parent)
                        break
    if not blocks and not _explicit_empty_page(root, "announcements"):
        raise ConnectorError("COURSE_PARSE_CHANGED", "公告页面布局无法识别", scope=f"course:{course_id}:announcements")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block in blocks:
        text = _clean_text(block.text())
        if not text:
            continue
        heading = _first_heading(block)
        title = _clean_text(heading.text()) if heading else text.splitlines()[0][:200]
        if not title:
            continue
        link = None
        for anchor in _anchors(block):
            if _clean_text(anchor.text()) == title or link is None:
                link = _anchor_href(anchor, base_url=base_url)
            if link:
                break
        # Preserve body text but remove the title prefix to avoid duplicating it.
        body = text[len(title) :].strip(" \n:：") if text.startswith(title) else text
        published, _ = _first_date(text)
        classes = block.attrs.get("class", "").casefold()
        unread: bool | None = True if "unread" in classes else False if re.search(r"\bread\b", classes) else None
        item_id = _id("announcement", course_id, link, title + "\n" + body)
        if item_id in seen:
            continue
        seen.add(item_id)
        out.append(Announcement(item_id, course_id, title, body, published, link, unread).as_dict())
        if len(out) >= limit:
            break
    return out


def parse_assignments(
    source: str,
    course_id: str,
    *,
    base_url: str = SCHOOL_ORIGIN,
    limit: int = 100,
    verified_page: bool = False,
) -> list[dict[str, Any]]:
    root = _parse_dom(source)
    _raise_if_forbidden(root, f"course:{course_id}:assignments")
    _raise_if_auth_page(root, f"course:{course_id}:assignments")
    candidates: list[tuple[_Node, _Node]] = []
    malformed_assignment = False
    for anchor in _anchors(root):
        raw_href = anchor.attrs.get("href", "")
        title = _clean_text(anchor.text())
        is_assignment = _is_assignment_href(raw_href) or bool(ASMT_PAT.search(title))
        if _is_file_href(raw_href) or not is_assignment:
            continue
        if not title:
            # A known assignment URL without its required title is a malformed
            # row, not proof that the course has no assignments.
            if _is_assignment_href(raw_href):
                malformed_assignment = True
            continue
        candidates.append((_assignment_parent(anchor), anchor))
    if malformed_assignment:
        raise ConnectorError("COURSE_PARSE_CHANGED", "作业条目缺少必要标题，未将不完整结果当成空列表", scope=f"course:{course_id}:assignments")
    if not candidates and not _explicit_empty_page(root, "assignments") and not _resource_page_allows_empty(root, course_id, verified_page=verified_page):
        raise ConnectorError("COURSE_PARSE_CHANGED", "作业页面布局无法识别", scope=f"course:{course_id}:assignments")
    out: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for block, anchor in candidates:
        title = _clean_text(anchor.text())
        link = _anchor_href(anchor, base_url=base_url)
        if link and not _course_query_matches(link, course_id):
            continue
        if link and link in seen_urls:
            continue
        if link:
            seen_urls.add(link)
        text = _clean_text(block.text())
        due_at, due_only, evidence = parse_due(text)
        remote: str = "unknown"
        low = text.casefold()
        if re.search(r"not\s+submitted|未提交|尚未提交", low):
            remote = "not-submitted"
        elif re.search(r"submitted|已提交|提交成功", low):
            remote = "submitted"
        attachments: list[dict[str, str | None]] = []
        for attachment in _anchors(block):
            if attachment is anchor:
                continue
            attachment_url = _anchor_href(attachment, base_url=base_url)
            attachment_name = _clean_text(attachment.text())
            if attachment_name and attachment_url:
                attachments.append({"name": attachment_name, "url": attachment_url})
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        summary = " ｜ ".join(lines[:6])[:500] if lines else None
        out.append(
            Assignment(
                _id("assignment", course_id, link, title + "\n" + text),
                course_id,
                title,
                due_at,
                due_only,
                evidence,
                link,
                remote,
                summary,
                tuple(attachments),
            ).as_dict()
        )
        if len(out) >= limit:
            break
    return out


def _assignment_detail_url(value: str, *, base_url: str) -> str:
    """Normalize a same-school assignment href before GET navigation."""

    # The list supplies the detail route.  Keep only the technical URL
    # boundary here: reject empty, non-HTTPS, foreign-origin and dangerous
    # scheme inputs without guessing Blackboard's detail route or query shape.
    return safe_school_url(value, base_url=base_url, allow_relative=False)


def _assignment_detail_node(root: _Node) -> _Node | None:
    candidates = []
    for node in root.descendants():
        identity = _node_identity(node)
        if any(token in identity for token in ("assignment", "assessment", "contentitem", "contentpanel", "contentwrapper", "description")):
            text = _clean_text(node.text())
            if text:
                candidates.append((len(text), node))
    return max(candidates, key=lambda pair: pair[0])[1] if candidates else None


def _parse_assignment_detail(
    source: str,
    course_id: str,
    item: Mapping[str, Any],
    *,
    base_url: str,
) -> dict[str, Any]:
    detail_url = _assignment_detail_url(str(item.get("url") or ""), base_url=base_url)
    root = _parse_dom(source)
    scope = f"course:{course_id}:assignment:{str(item.get('id') or 'unknown')}:detail"
    _raise_if_forbidden(root, scope)
    _raise_if_auth_page(root, scope)
    block = _assignment_detail_node(root)
    text = _clean_text(block.text() if block is not None else root.text())
    if not text or (block is None and not re.search(r"assignment|assessment|submission|homework|quiz|project|截止|作业|测验|项目|due|deadline", text, re.I)):
        raise ConnectorError("COURSE_PARSE_CHANGED", "作业详情页面布局无法识别", scope=scope)
    merged = dict(item)
    due_at, due_only, due_evidence = parse_due(text)
    if _explicit_no_due(text):
        merged["dueAt"] = None
        merged["dueDateOnly"] = None
        merged["dueEvidence"] = "unknown"
    elif due_at is not None or due_only is not None:
        merged["dueAt"] = due_at
        merged["dueDateOnly"] = due_only
        merged["dueEvidence"] = due_evidence
    if text:
        merged["summary"] = text[:100000]
    attachments: list[dict[str, str | None]] = []
    attachment_root = block or root
    for anchor in _anchors(attachment_root):
        raw_href = anchor.attrs.get("href", "")
        if not _is_attachment_href(raw_href):
            continue
        try:
            attachment_url = _resolve_page_href(raw_href, detail_url, base_url=base_url)
        except ConnectorError:
            continue
        attachment_name = _clean_text(anchor.text()) or unquote(urlsplit(attachment_url).path.rsplit("/", 1)[-1]) or "file"
        if not any(existing["url"] == attachment_url for existing in attachments):
            attachments.append({"name": attachment_name, "url": attachment_url})
    if attachments:
        merged["attachments"] = attachments
    return merged


FILE_EXTS = (
    ".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".zip", ".rar", ".7z",
    ".ipynb", ".py", ".java", ".c", ".cpp", ".txt", ".md", ".png", ".jpg", ".jpeg", ".mp4",
)


def _is_file_href(href: str) -> bool:
    path = href.split("?", 1)[0].lower()
    return path.endswith(FILE_EXTS) or "@xid" in href.casefold() or "bbcswebdav" in href.casefold()


def _is_attachment_href(href: str) -> bool:
    """Recognize Blackboard's same-origin attachment endpoint as a file link."""

    if _is_file_href(href):
        return True
    parsed = urlsplit(href)
    path = parsed.path.casefold()
    query = {key.casefold() for key in parse_qs(parsed.query, keep_blank_values=True)}
    return (
        path in {
            "/webapps/blackboard/content/file",
            "/webapps/blackboard/execute/content/file",
        }
        and bool({"content_id", "file_id", "attachment_id"} & query)
    )


def parse_files(
    source: str,
    course_id: str,
    *,
    base_url: str = SCHOOL_ORIGIN,
    limit: int = 100,
    verified_page: bool = False,
) -> list[dict[str, Any]]:
    root = _parse_dom(source)
    _raise_if_forbidden(root, f"course:{course_id}:files")
    _raise_if_auth_page(root, f"course:{course_id}:files")
    file_candidates = [anchor for anchor in _anchors(root) if _is_file_href(anchor.attrs.get("href", ""))]
    if not file_candidates and not _explicit_empty_page(root, "files") and not _resource_page_allows_empty(root, course_id, verified_page=verified_page):
        raise ConnectorError("COURSE_PARSE_CHANGED", "课程资料页面布局无法识别", scope=f"course:{course_id}:files")
    out: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for anchor in file_candidates:
        link = _anchor_href(anchor, base_url=base_url)
        if link and not _course_query_matches(link, course_id):
            continue
        if not link or link in seen_urls:
            continue
        seen_urls.add(link)
        name = _clean_text(anchor.text())
        if not name:
            path_name = urlsplit(link).path.rsplit("/", 1)[-1]
            name = unquote(path_name) or "file"
        parent = next((p for p in anchor.ancestors() if p.tag == "li"), anchor)
        published, _ = _first_date(parent.text())
        out.append(CourseFile(_id("file", course_id, link, name), course_id, name, link, published).as_dict())
        if len(out) >= limit:
            break
    if file_candidates and not out:
        raise ConnectorError("COURSE_PARSE_CHANGED", "课程资料包含无法安全解析的文件链接", scope=f"course:{course_id}:files")
    return out


class AuthProvider(Protocol):
    """Replaceable authorization interface used by the connector."""

    def status(self, connector: "ClassicConnector") -> dict[str, Any]: ...

    def login(self, connector: "ClassicConnector", action: str) -> dict[str, Any]: ...

    def close(self) -> None: ...


class ManualAuthProvider:
    """Official, user-visible login flow with no credential file.

    ``begin`` opens or reuses the school page in a persistent profile and
    returns.  The user completes any SSO/MFA steps in that browser.
    ``complete`` verifies the same context and keeps it available for reads.
    The profile location is configured through ``BB_USER_DATA_DIR`` and is
    never returned in tool results.
    """

    def __init__(self) -> None:
        self._pw: Any = None
        self._ctx: Any = None
        self._page: Any = None

    def _discard_closed_context(self) -> None:
        """Forget a browser that the user closed outside Playwright."""

        context = self._ctx
        if context is None:
            return
        try:
            closed = bool(context.is_closed())
        except AttributeError:
            # Lightweight test contexts need not implement Playwright's
            # BrowserContext.is_closed(); retain them until an operation says
            # otherwise.
            return
        except Exception:
            closed = True
        if not closed:
            return
        self._ctx = None
        self._page = None
        if self._pw is not None:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None

    def _on_context_closed(self, context: Any) -> None:
        if context is self._ctx:
            self._ctx = None
            self._page = None

    def _ensure_browser(self, connector: "ClassicConnector") -> Any:
        self._discard_closed_context()
        if self._ctx is not None:
            return self._ctx
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise ConnectorError("CONNECTOR_START_FAILED", "Playwright is not installed") from exc
        _configure_playwright_browsers_path()
        connector.config.user_data_dir.mkdir(parents=True, exist_ok=True)
        if self._pw is not None:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None
        self._pw = sync_playwright().start()
        try:
            self._ctx = self._pw.chromium.launch_persistent_context(
                str(connector.config.user_data_dir),
                headless=False,
                accept_downloads=False,
                viewport={"width": 1440, "height": 900},
                locale="zh-CN",
                timeout=connector.config.timeout_ms,
            )
            try:
                self._ctx.on("close", self._on_context_closed)
            except Exception:
                pass
            self._ctx.set_default_timeout(connector.config.timeout_ms)
        except Exception as exc:
            self.close()
            code = "TIMEOUT" if exc.__class__.__name__.casefold().endswith("timeouterror") else "CONNECTOR_START_FAILED"
            message = "启动本地登录浏览器超时" if code == "TIMEOUT" else "无法启动本地授权浏览器"
            raise ConnectorError(code, message, scope="browser-launch") from exc
        return self._ctx

    @staticmethod
    def _safe_origin_path(page_url: Any) -> tuple[str | None, str | None]:
        """Return only the allowlisted origin and pathname for diagnostics."""

        if not isinstance(page_url, str) or not page_url:
            return None, None
        parsed = urlsplit(page_url)
        try:
            port = parsed.port
        except ValueError:
            return None, None
        if (
            parsed.scheme.casefold() != "https"
            or (parsed.hostname or "").rstrip(".").casefold() != SCHOOL_HOST
            or port not in (None, 443)
            or parsed.username
            or parsed.password
        ):
            return None, None
        return SCHOOL_ORIGIN, parsed.path or "/"

    @staticmethod
    def _portal_candidate(page_url: Any) -> bool:
        """Match only known Classic entry paths and explicit tab groups."""

        origin, pathname = ManualAuthProvider._safe_origin_path(page_url)
        if origin is None or pathname is None:
            return False
        path = pathname.rstrip("/").casefold() or "/"
        parsed = urlsplit(str(page_url))
        query = parse_qs(parsed.query, keep_blank_values=True)
        group = query.get("tab_tab_group_id", [""])[0]
        if path in {
            "/webapps/portal/execute/tabs/tabaction",
            "/webapps/portal/frameset.jsp",
        }:
            return group in {"_1_1", "_2_1"}
        if path == "/webapps/portal/execute/defaulttab":
            # Some Classic deployments omit tab_tab_group_id on the default
            # tab.  Its DOM still has to provide strong authenticated proof.
            return not group or group in {"_1_1", "_2_1"}
        # A visible course/Classic page can be the page the user completed
        # login on.  Keep this list narrow; arbitrary same-origin pages are not
        # authentication evidence.
        return bool(
            re.match(r"^/webapps/blackboard/(?:execute|content)(?:/|$)", path)
            or re.match(r"^/webapps/assessment/(?:[^/]+/)?", path)
        )

    @staticmethod
    def _classic_path(page_url: Any) -> bool:
        origin, pathname = ManualAuthProvider._safe_origin_path(page_url)
        if origin is None or pathname is None:
            return False
        return ManualAuthProvider._portal_candidate(page_url)

    @staticmethod
    def _document_evidence(source: str) -> dict[str, Any]:
        """Extract bounded auth markers without returning page text."""

        evidence = {
            "marker": False,
            "courseLinkCount": 0,
            "explicitLoginForm": False,
            "iframeCount": 0,
            "loginAnchor": False,
            "logoutAnchor": False,
            "sessionExpired": False,
        }
        try:
            root = _parse_dom(source)
        except ConnectorError:
            return evidence
        evidence["iframeCount"] = sum(1 for node in root.descendants("iframe"))
        page_text = _clean_text(root.text())[:20_000].casefold()
        evidence["sessionExpired"] = bool(re.search(
            r"session\s+(?:has\s+)?expired|session\s+timed\s*out|session\s+timeout|"
            r"会话\s*(?:已|已经)?\s*过期|登录\s*(?:已|已经)?\s*过期|会话\s*超时|登录\s*超时",
            page_text,
            re.I,
        ))
        strong_markers = (
            "mycourses",
            "mystartpage",
            "coursemenu",
            "coursemenu_palette",
            "coursemenupalette",
        )
        generic_markers = ("globalnavpagenavarea", "globalnavigation", "globalnav", "breadcrumbs", "portalpage")
        for node in root.descendants():
            identity = re.sub(
                r"[^a-z0-9]",
                "",
                f"{node.attrs.get('id', '')} {node.attrs.get('class', '')}".casefold(),
            )
            if any(marker in identity for marker in strong_markers):
                evidence["marker"] = True
            # Keep generic layout markers local to this probe.  They are not
            # authentication evidence on their own, but are useful while
            # diagnosing an anonymous or redesigned shell.
            if any(marker in identity for marker in generic_markers):
                evidence["genericMarker"] = True
            if node.tag == "form":
                form_identity = " ".join(
                    node.attrs.get(key, "") for key in ("id", "class", "name", "action", "method")
                ).casefold()
                inputs = list(node.descendants("input"))
                has_password = any(
                    item.attrs.get("type", "").casefold() == "password"
                    or re.search(r"pass(?:word|wd)?", " ".join(item.attrs.get(key, "") for key in ("id", "name", "autocomplete")).casefold())
                    for item in inputs
                )
                has_user = any(
                    re.search(r"(?:user|login|student|j_username|user_id)", " ".join(item.attrs.get(key, "") for key in ("id", "name", "autocomplete", "placeholder")).casefold())
                    for item in inputs
                )
                if has_password and (has_user or len(inputs) <= 6) or re.search(r"login|authvalidate|customlogin|sign.?in", form_identity):
                    evidence["explicitLoginForm"] = True
            elif node.tag == "input" and node.attrs.get("type", "").casefold() == "password":
                evidence["explicitLoginForm"] = True
        course_ids: set[str] = set()
        for anchor in _anchors(root):
            href = html_lib.unescape(unquote(anchor.attrs.get("href", "")))
            course_id = _classic_course_link(href)
            if course_id:
                course_ids.add(course_id)
            parsed_href = urlsplit(href)
            low_path = parsed_href.path.casefold()
            low_query = parsed_href.query.casefold()
            low_href = href.casefold()
            low_text = _clean_text(anchor.text()).casefold()
            logout_action = (
                "logout" in low_path
                or re.search(r"(?:^|[?&])action=logout(?:&|$)", low_query) is not None
                or "logout" in low_text
            )
            login_action = (
                "/webapps/login" in low_path
                or re.search(r"(?:^|[?&])action=(?:re)?login(?:&|$)", low_query) is not None
                or ("sign in" in low_text and not logout_action)
                or ("登录" in low_text and not logout_action)
            )
            if logout_action:
                evidence["logoutAnchor"] = True
                evidence["marker"] = True
            if login_action and not logout_action:
                evidence["loginAnchor"] = True
        evidence["courseLinkCount"] = min(len(course_ids), 200)
        return evidence

    @staticmethod
    def _probe_page(page: Any, *, phase: str = "current-page", portal_target: str | None = None) -> dict[str, Any]:
        """Probe one page and same-school frames, keeping only safe metadata."""

        page_url = getattr(page, "url", "") or ""
        origin, pathname = ManualAuthProvider._safe_origin_path(page_url)
        top_origin, top_pathname = origin, pathname
        documents: list[tuple[Any, str]] = []
        try:
            documents.append((page_url, page.content()))
        except Exception:
            pass
        frames = getattr(page, "frames", None)
        frame_list = list(frames) if isinstance(frames, (list, tuple)) else []
        iframe_count = max(0, len(frame_list) - 1)
        if frame_list and not documents:
            iframe_count = max(iframe_count, 0)
        main_frame = getattr(page, "main_frame", None)
        for index, frame in enumerate(frame_list):
            if frame is main_frame or (main_frame is None and index == 0):
                continue
            frame_url = getattr(frame, "url", "") or ""
            frame_origin, _ = ManualAuthProvider._safe_origin_path(frame_url)
            if frame_origin is None:
                continue
            try:
                documents.append((frame_url, frame.content()))
            except Exception:
                continue
        combined = {
            "marker": False,
            "courseLinkCount": 0,
            "explicitLoginForm": False,
            "iframeCount": iframe_count,
            "loginAnchor": False,
            "logoutAnchor": False,
            "sessionExpired": False,
        }
        for document_url, source in documents:
            evidence = ManualAuthProvider._document_evidence(source)
            combined["marker"] = bool(combined["marker"] or evidence["marker"])
            combined["courseLinkCount"] = min(200, int(combined["courseLinkCount"]) + int(evidence["courseLinkCount"]))
            combined["explicitLoginForm"] = bool(combined["explicitLoginForm"] or evidence["explicitLoginForm"])
            combined["loginAnchor"] = bool(combined["loginAnchor"] or evidence.get("loginAnchor"))
            combined["logoutAnchor"] = bool(combined["logoutAnchor"] or evidence.get("logoutAnchor"))
            combined["sessionExpired"] = bool(combined["sessionExpired"] or evidence.get("sessionExpired"))
            combined["iframeCount"] = max(int(combined["iframeCount"]), int(evidence["iframeCount"]))
        # A same-school iframe can contribute Classic DOM evidence only when
        # the top-level page itself is the allowlisted school origin.  Never
        # turn a foreign SSO frame inside an arbitrary page into auth success.
        origin, pathname = top_origin, top_pathname
        portal_candidate = ManualAuthProvider._portal_candidate(page_url)
        combined.update({
            "phase": phase,
            "origin": origin,
            "pathname": pathname,
            "portalCandidate": bool(portal_candidate),
            "portalTarget": urlsplit(portal_target).path if portal_target else None,
        })
        combined["authenticated"] = bool(
            origin == SCHOOL_ORIGIN
            and portal_candidate
            and (combined["marker"] or int(combined["courseLinkCount"]) > 0)
            and not combined["explicitLoginForm"]
            and not combined["loginAnchor"]
            and not combined["sessionExpired"]
        )
        return combined

    @staticmethod
    def _public_auth_result(probe: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "phase": probe.get("phase", "current-page"),
            "origin": probe.get("origin"),
            "pathname": probe.get("pathname"),
            "portalTarget": probe.get("portalTarget"),
            "portalCandidate": bool(probe.get("portalCandidate")),
            "courseLinkCount": int(probe.get("courseLinkCount", 0)),
            "marker": bool(probe.get("marker")),
            "iframeCount": int(probe.get("iframeCount", 0)),
            "explicitLoginForm": bool(probe.get("explicitLoginForm")),
            "sessionExpired": bool(probe.get("sessionExpired")),
        }

    @staticmethod
    def _probe_score(probe: Mapping[str, Any]) -> int:
        return (
            (8 if probe.get("explicitLoginForm") else 0)
            + (7 if probe.get("loginAnchor") else 0)
            + (6 if probe.get("sessionExpired") else 0)
            + (4 if probe.get("portalCandidate") else 0)
            + (3 if probe.get("marker") else 0)
            + min(3, int(probe.get("courseLinkCount", 0)))
            + (1 if probe.get("origin") == SCHOOL_ORIGIN else 0)
        )

    @staticmethod
    def _empty_auth_probe(*, phase: str = "current-page") -> dict[str, Any]:
        """Return a safe negative probe without starting another browser."""

        return {
            "origin": None,
            "pathname": None,
            "phase": phase,
            "portalTarget": None,
            "portalCandidate": False,
            "courseLinkCount": 0,
            "marker": False,
            "iframeCount": 0,
            "explicitLoginForm": False,
            "loginAnchor": False,
            "logoutAnchor": False,
            "sessionExpired": False,
            "authenticated": False,
        }

    @staticmethod
    def _wait_for_auth_page(page: Any, timeout_ms: int) -> None:
        try:
            page.wait_for_load_state("domcontentloaded", timeout=min(timeout_ms, 5_000))
        except Exception:
            pass
        try:
            page.wait_for_function(
                """() => {
                    const selectors = [
                        '#globalNavPageNavArea', '#globalNavigation', '#myCourses',
                        '#courseMenu', '.courseMenuPalette', '.breadcrumbs',
                        'input[type="password"]', 'form[action*="login" i]',
                        'form[action*="authValidate" i]',
                        'a[href*="/webapps/login" i]',
                        'a[href*="action=relogin" i]'
                    ];
                    const marker = selectors.some(selector => document.querySelector(selector));
                    const course = [...document.querySelectorAll('a[href]')].some(anchor => /(?:^|[?&])id=_[0-9]+_1(?:&|$)/i.test(anchor.getAttribute('href') || ''));
                    return marker || course;
                }""",
                timeout=min(timeout_ms, 2_500),
            )
        except Exception:
            pass

    @staticmethod
    def _auth_failure(probe: Mapping[str, Any]) -> tuple[str, str]:
        details = ManualAuthProvider._public_auth_result(probe)
        summary = (
            f"origin={details['origin'] or 'unknown'}; pathname={details['pathname'] or 'unknown'}; "
            f"portalCandidate={str(details['portalCandidate']).lower()}; "
            f"courseLinks={details['courseLinkCount']}; marker={str(details['marker']).lower()}; "
            f"iframeCount={details['iframeCount']}; loginForm={str(details['explicitLoginForm']).lower()}; "
            f"sessionExpired={str(details['sessionExpired']).lower()}"
        )
        if probe.get("errorCode") == "TIMEOUT":
            return "TIMEOUT", f"检查官方 Blackboard 门户超时，请保持登录窗口打开后重试（{summary}）"
        if probe.get("sessionExpired"):
            return "SESSION_EXPIRED", f"官方 Blackboard 会话已过期，请重新完成登录（{summary}）"
        if details["explicitLoginForm"]:
            return "AUTH_REQUIRED", f"官方登录表单仍在等待完成（{summary}）"
        if probe.get("loginAnchor"):
            return "AUTH_REQUIRED", f"官方登录入口仍在等待完成（{summary}）"
        return "AUTH_CHECK_UNRECOGNIZED", f"认证页面未识别，请保持在 Blackboard Classic 页面后重试（{summary}）"

    @staticmethod
    def _has_authenticated_portal_evidence(page_url: str, source: str) -> bool:
        origin, _ = ManualAuthProvider._safe_origin_path(page_url)
        evidence = ManualAuthProvider._document_evidence(source)
        return bool(
            origin == SCHOOL_ORIGIN
            and ManualAuthProvider._portal_candidate(page_url)
            and (evidence["marker"] or evidence["courseLinkCount"] > 0)
            and not evidence["explicitLoginForm"]
            and not evidence.get("loginAnchor")
            and not evidence.get("sessionExpired")
        )

    @staticmethod
    def _auth_probe(
        ctx: Any,
        connector: "ClassicConnector",
        preferred_page: Any | None = None,
    ) -> dict[str, Any]:
        pages_value = getattr(ctx, "pages", ())
        pages = list(pages_value) if isinstance(pages_value, (list, tuple)) else []
        if preferred_page is not None and preferred_page not in pages:
            pages.insert(0, preferred_page)
        elif preferred_page is not None:
            pages.remove(preferred_page)
            pages.insert(0, preferred_page)
        open_pages: list[Any] = []
        for page in pages:
            try:
                if not page.is_closed():
                    open_pages.append(page)
            except AttributeError:
                open_pages.append(page)
            except Exception:
                continue
        best: dict[str, Any] | None = None
        for page in open_pages:
            probe = ManualAuthProvider._probe_page(page, phase="current-page")
            if best is None or ManualAuthProvider._probe_score(probe) > ManualAuthProvider._probe_score(best):
                best = probe
            if probe.get("authenticated"):
                return probe
        page = None
        timed_out = False
        deadline = time.monotonic() + min(max(connector.config.timeout_ms, 5_000), 12_000) / 1000
        try:
            page = ctx.new_page()
            for candidate in AUTH_PORTAL_CANDIDATES:
                remaining_ms = int(max(0, (deadline - time.monotonic()) * 1000))
                if remaining_ms <= 0:
                    break
                target = safe_school_url(candidate, base_url=connector.config.base_url)
                try:
                    page.goto(target, timeout=remaining_ms, wait_until="domcontentloaded")
                    remaining_ms = int(max(0, (deadline - time.monotonic()) * 1000))
                    if remaining_ms:
                        ManualAuthProvider._wait_for_auth_page(page, remaining_ms)
                except Exception as exc:
                    timed_out = timed_out or exc.__class__.__name__.casefold().endswith("timeouterror")
                probe = ManualAuthProvider._probe_page(page, phase="candidate", portal_target=target)
                if best is None or ManualAuthProvider._probe_score(probe) > ManualAuthProvider._probe_score(best):
                    best = probe
                if probe.get("authenticated"):
                    return probe
        finally:
            if page is not None:
                try:
                    page.close()
                except Exception:
                    pass
        if best is None:
            best = {
                "origin": None,
                "pathname": None,
                "phase": "candidate",
                "portalTarget": None,
                "portalCandidate": False,
                "courseLinkCount": 0,
                "marker": False,
                "iframeCount": 0,
                "explicitLoginForm": False,
                "sessionExpired": False,
                "authenticated": False,
            }
        if timed_out:
            best["errorCode"] = "TIMEOUT"
        return best

    def _check_auth(self, ctx: Any, connector: "ClassicConnector") -> dict[str, Any]:
        return self._auth_probe(ctx, connector, preferred_page=self._page)

    @staticmethod
    def _logged_in(ctx: Any, connector: "ClassicConnector") -> bool:
        return bool(ManualAuthProvider._auth_probe(ctx, connector).get("authenticated"))

    @staticmethod
    def _canonical_portal_url(page_url: Any, *, base_url: str) -> str | None:
        origin, pathname = ManualAuthProvider._safe_origin_path(page_url)
        if origin is None or pathname is None:
            return None
        path = pathname.rstrip("/").casefold() or "/"
        parsed = urlsplit(str(page_url))
        group = parse_qs(parsed.query, keep_blank_values=True).get("tab_tab_group_id", [""])[0]
        if group not in {"_1_1", "_2_1"}:
            return None
        if path == "/webapps/portal/execute/tabs/tabaction":
            return safe_school_url(f"/webapps/portal/execute/tabs/tabAction?tab_tab_group_id={group}", base_url=base_url)
        if path == "/webapps/portal/frameset.jsp":
            return safe_school_url(f"/webapps/portal/frameset.jsp?tab_tab_group_id={group}&url=%2F", base_url=base_url)
        if path == "/webapps/portal/execute/defaulttab":
            return safe_school_url(f"/webapps/portal/execute/defaultTab?tab_tab_group_id={group}", base_url=base_url)
        return None

    def preferred_portal_url(self, ctx: Any, connector: "ClassicConnector") -> str:
        pages_value = getattr(ctx, "pages", ())
        pages = list(pages_value) if isinstance(pages_value, (list, tuple)) else []
        if self._page is not None:
            pages = [self._page, *[page for page in pages if page is not self._page]]
        for page in pages:
            candidate = self._canonical_portal_url(getattr(page, "url", ""), base_url=connector.config.base_url)
            if candidate:
                return candidate
        return safe_school_url(AUTH_PORTAL_CANDIDATES[0], base_url=connector.config.base_url)

    def status(self, connector: "ClassicConnector") -> dict[str, Any]:
        if connector.fixture_mode:
            return {"state": "ok", "mode": "fixture", "authenticated": True, "next": None, "errors": []}
        try:
            existing = self.context()
            probe = self._check_auth(existing, connector) if existing is not None else self._empty_auth_probe()
        except ConnectorError:
            raise
        except TimeoutError as exc:
            raise ConnectorError("TIMEOUT", "Blackboard 状态检查超时", scope="status") from exc
        except Exception as exc:
            raise ConnectorError("CONNECTOR_START_FAILED", "无法检查 Blackboard 会话", scope="status") from exc
        valid = bool(probe.get("authenticated"))
        code, message = self._auth_failure(probe) if not valid else ("", "")
        next_step = (
            "保持官方 Blackboard 窗口打开后重试 classic_login(action='complete')"
            if code in {"AUTH_REQUIRED", "SESSION_EXPIRED"}
            else "保持官方 Blackboard 窗口打开后重试 classic_status"
        )
        return {
            "state": "ok" if valid else ("auth-required" if code in {"AUTH_REQUIRED", "SESSION_EXPIRED"} else "error"),
            "mode": "live",
            "authenticated": bool(valid),
            "next": None if valid else next_step,
            "authResult": self._public_auth_result(probe),
            "errors": [] if valid else [{"scope": "auth", "code": code, "message": message}],
        }

    def login(self, connector: "ClassicConnector", action: str) -> dict[str, Any]:
        if connector.fixture_mode:
            return {"state": "ok", "mode": "fixture", "authenticated": True, "next": None, "errors": []}
        if action not in {"begin", "complete"}:
            raise ConnectorError("INVALID_INPUT", "action must be begin or complete")
        if action == "begin":
            context = self._ensure_browser(connector)
            page = self._page
            page_closed = page is None
            if page is not None:
                try:
                    page_closed = bool(page.is_closed())
                except Exception:
                    page_closed = True
            if page_closed:
                page = None
                pages_value = getattr(context, "pages", ())
                pages = list(pages_value) if isinstance(pages_value, (list, tuple)) else []
                for candidate in pages:
                    try:
                        if candidate.is_closed():
                            continue
                    except Exception:
                        continue
                    page = candidate
                    break
                if page is None:
                    page = context.new_page()
                self._page = page
            try:
                page.bring_to_front()
            except Exception:
                pass
            target = safe_school_url("/", base_url=connector.config.base_url)
            page.goto(target, timeout=connector.config.timeout_ms, wait_until="domcontentloaded")
            return {
                "state": "auth-required",
                "mode": "live",
                "authenticated": False,
                "next": "在已打开的官方 Blackboard 窗口完成登录/MFA，然后调用 classic_login(action='complete')",
                "errors": [],
            }
        context = self.context()
        probe = self._check_auth(context, connector) if context is not None else self._empty_auth_probe()
        valid = bool(probe.get("authenticated"))
        if not valid:
            code, message = self._auth_failure(probe)
            next_step = (
                "保持官方 Blackboard 窗口打开后重试 classic_login(action='complete')"
                if code in {"AUTH_REQUIRED", "SESSION_EXPIRED"}
                else "当前 Blackboard 会话未能确认；保持窗口打开后重试 classic_login(action='complete')"
            )
            return {
                "state": "auth-required" if code in {"AUTH_REQUIRED", "SESSION_EXPIRED"} else "error",
                "mode": "live",
                "authenticated": False,
                "next": next_step,
                "authResult": self._public_auth_result(probe),
                "errors": [{"scope": "auth", "code": code, "message": message}],
            }
        return {"state": "ok", "mode": "live", "authenticated": True, "next": None, "authResult": self._public_auth_result(probe), "errors": []}

    def context(self) -> Any | None:
        self._discard_closed_context()
        return self._ctx

    def close(self) -> None:
        if self._page is not None:
            try:
                self._page.close()
            except Exception:
                pass
            self._page = None
        if self._ctx is not None:
            try:
                self._ctx.close()
            except Exception:
                pass
            self._ctx = None
        if self._pw is not None:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None


class _FixtureRepository:
    def __init__(self, root: Path):
        self.root = root.resolve()
        if not self.root.exists() or not self.root.is_dir():
            raise ConnectorError("FIXTURE_NOT_FOUND", "离线 fixture 目录不存在")

    def read(self, name: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            raise ConnectorError("FIXTURE_NOT_FOUND", "离线 fixture 文件名无效")
        target = (self.root / name).resolve()
        try:
            target.relative_to(self.root)
        except ValueError as exc:
            raise ConnectorError("FIXTURE_NOT_FOUND", "离线 fixture 路径越界") from exc
        if target.suffix.lower() not in {".html", ".json"} or not target.is_file():
            raise ConnectorError("FIXTURE_NOT_FOUND", "离线 fixture 文件不存在")
        try:
            return target.read_text(encoding="utf-8")
        except OSError as exc:
            raise ConnectorError("FIXTURE_PARSE_FAILED", "离线 fixture 无法读取") from exc

    @staticmethod
    def course_file(course_id: str, kind: str) -> str:
        if kind not in {"announcements", "content"}:
            raise ConnectorError("INVALID_INPUT", "fixture 类型无效")
        return f"course-{course_id}-{kind}.html"


class ClassicConnector:
    """Serial, read-only Classic connector used by the MCP server."""

    def __init__(self, config: ConnectorConfig | None = None, auth: AuthProvider | None = None):
        self.config = config or ConnectorConfig.from_env()
        self.fixture_mode = self.config.fixture_dir is not None
        self.fixture = _FixtureRepository(self.config.fixture_dir) if self.config.fixture_dir else None
        self.auth = auth or ManualAuthProvider()
        self._lock = threading.RLock()
        self._closed = False
        atexit.register(self.close)

    @contextmanager
    def _serial(self) -> Iterator[None]:
        with self._lock:
            if self._closed:
                raise ConnectorError("CONNECTOR_START_FAILED", "连接器已关闭")
            yield

    def _temporary_context(self, *, headless: bool) -> Any:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise ConnectorError("CONNECTOR_START_FAILED", "Playwright is not installed") from exc
        _configure_playwright_browsers_path()
        self.config.user_data_dir.mkdir(parents=True, exist_ok=True)
        pw = sync_playwright().start()
        try:
            ctx = pw.chromium.launch_persistent_context(
                str(self.config.user_data_dir),
                headless=headless,
                accept_downloads=False,
                viewport={"width": 1440, "height": 900},
                locale="zh-CN",
                timeout=self.config.timeout_ms,
            )
            ctx.set_default_timeout(self.config.timeout_ms)
            # Keep the driver object attached so close can stop it safely.
            setattr(ctx, "_bb_mcp_pw", pw)
            return ctx
        except Exception as exc:
            try:
                pw.stop()
            except Exception:
                pass
            code = "TIMEOUT" if exc.__class__.__name__.casefold().endswith("timeouterror") else "CONNECTOR_START_FAILED"
            message = "启动本地浏览器超时" if code == "TIMEOUT" else "无法启动本地浏览器"
            raise ConnectorError(code, message, scope="browser-launch") from exc

    @staticmethod
    def _close_temporary_context(ctx: Any) -> None:
        try:
            ctx.close()
        finally:
            pw = getattr(ctx, "_bb_mcp_pw", None)
            if pw is not None:
                try:
                    pw.stop()
                except Exception:
                    pass

    def _with_retry(self, operation: Callable[[], Any], *, scope: str) -> Any:
        last: Exception | None = None
        for attempt in range(self.config.retries + 1):
            try:
                return operation()
            except ConnectorError:
                raise
            except TimeoutError as exc:
                last = exc
                if attempt >= self.config.retries:
                    raise ConnectorError("TIMEOUT", "Blackboard 请求超时", scope=scope) from exc
            except Exception as exc:
                last = exc
                if attempt >= self.config.retries:
                    code = "TIMEOUT" if exc.__class__.__name__.casefold().endswith("timeouterror") else "CONNECTOR_START_FAILED"
                    message = "Blackboard 请求超时" if code == "TIMEOUT" else "Blackboard 页面读取失败"
                    raise ConnectorError(code, message, scope=scope) from exc
            time.sleep(0.15 * (attempt + 1))
        raise ConnectorError("CONNECTOR_START_FAILED", "Blackboard 页面读取失败", scope=scope) from last

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                self.auth.close()
            except Exception:
                pass

    def status(self) -> dict[str, Any]:
        with self._serial():
            return self._with_retry(lambda: self.auth.status(self), scope="status")

    def login(self, action: str = "begin") -> dict[str, Any]:
        with self._serial():
            return self._with_retry(lambda: self.auth.login(self, action), scope="auth")

    def _fixture_courses(self) -> list[dict[str, Any]]:
        assert self.fixture is not None
        try:
            return parse_courses_checked(self.fixture.read("courses.html"), base_url=self.config.base_url, limit=self.config.max_courses)
        except ConnectorError:
            raise
        except Exception as exc:
            raise ConnectorError("COURSE_PARSE_CHANGED", "课程页面布局无法识别", scope="courses") from exc

    def _live_context(self) -> tuple[Any, bool]:
        auth_context = self.auth.context() if isinstance(self.auth, ManualAuthProvider) else None
        if isinstance(self.auth, ManualAuthProvider) and auth_context is None:
            raise ConnectorError("AUTH_REQUIRED", "请先点击登录并在官方 Blackboard 页面完成登录", scope="auth")
        ctx = auth_context or self._temporary_context(headless=True)
        own = ctx is not auth_context
        try:
            if isinstance(self.auth, ManualAuthProvider):
                state = self.auth._check_auth(ctx, self)
            else:
                state = self.auth.status(self)
        except Exception:
            if own:
                self._close_temporary_context(ctx)
            raise
        if not state.get("authenticated"):
            if own:
                self._close_temporary_context(ctx)
            if isinstance(self.auth, ManualAuthProvider):
                code, message = self.auth._auth_failure(state)
                raise ConnectorError(code, message, scope="auth")
            raise ConnectorError("AUTH_REQUIRED", "需要用户在官方 Blackboard 页面完成登录", scope="auth")
        read_diagnostics.attach(ctx)
        return ctx, own

    def list_courses(self, *, deadline: float | None = None) -> dict[str, Any]:
        with self._serial():
            try:
                if self.fixture_mode:
                    courses = self._fixture_courses()
                else:
                    def operation() -> list[dict[str, Any]]:
                        ctx, own = self._live_context()
                        page = ctx.new_page()
                        try:
                            target = (
                                self.auth.preferred_portal_url(ctx, self)
                                if isinstance(self.auth, ManualAuthProvider)
                                else safe_school_url(PORTAL_TAB, base_url=self.config.base_url)
                            )
                            page.goto(target, timeout=self._remaining_timeout_ms(deadline, "courses"), wait_until="domcontentloaded")
                            if isinstance(self.auth, ManualAuthProvider):
                                self.auth._wait_for_auth_page(page, self._remaining_timeout_ms(deadline, "courses"))
                            _assert_page_school_url(page, base_url=self.config.base_url)
                            self._wait_dynamic(page, deadline=deadline, scope="courses")
                            page_html = self._page_source(page)
                            result = parse_courses_checked(page_html, base_url=self.config.base_url, limit=self.config.max_courses)
                            return result
                        finally:
                            page.close()
                            if own:
                                self._close_temporary_context(ctx)
                    courses = self._with_retry(operation, scope="courses")
                return self._resource("courses", courses)
            except ConnectorError as exc:
                return self._resource("courses", [], errors=[self._error(exc, "courses")])

    @staticmethod
    def _state_for_errors(errors: Sequence[Mapping[str, str]], *, has_values: bool) -> str:
        if not errors:
            return "ok"
        if has_values:
            return "partial"
        codes = {str(error.get("code", "")) for error in errors}
        if codes and codes <= {"AUTH_REQUIRED", "SESSION_EXPIRED"}:
            return "auth-required"
        return "error"

    def _resource(self, key: str, values: Sequence[dict[str, Any]], *, errors: Sequence[dict[str, str]] = ()) -> dict[str, Any]:
        return {
            "state": self._state_for_errors(errors, has_values=bool(values)),
            "fetchedAt": now_iso(),
            "timezone": TIMEZONE_NAME,
            key: [dict(v) for v in values],
            "errors": [dict(e) for e in errors],
        }

    def _course_map(self) -> dict[str, dict[str, Any]]:
        payload = self.list_courses()
        if not payload.get("courses") and payload.get("errors"):
            first = payload["errors"][0]
            code = str(first.get("code") or "CONNECTOR_START_FAILED")
            if code not in ERROR_CODES:
                code = "CONNECTOR_START_FAILED"
            raise ConnectorError(code, str(first.get("message") or "课程列表读取失败"), scope="courses")
        return {item["id"]: item for item in payload.get("courses", [])}

    def _fixture_course_html(self, course_id: str, kind: str) -> str:
        assert self.fixture is not None
        return self.fixture.read(self.fixture.course_file(course_id, kind))

    def _remaining_timeout_ms(self, deadline: float | None, scope: str) -> int:
        if deadline is None:
            return self.config.timeout_ms
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            raise ConnectorError("TIMEOUT", "Blackboard 快照达到本次读取时间上限", scope=scope)
        return min(self.config.timeout_ms, remaining)

    def _wait_dynamic(self, page: Any, *, deadline: float | None, scope: str) -> None:
        """Give Classic's asynchronous modules a short bounded settle window."""

        try:
            page.wait_for_load_state(
                "networkidle",
                timeout=min(3_000, self._remaining_timeout_ms(deadline, scope)),
            )
        except ConnectorError:
            raise
        except Exception:
            # Blackboard may keep analytics requests open; DOM content remains
            # usable after the bounded wait expires.
            pass
        page.wait_for_timeout(min(700, self._remaining_timeout_ms(deadline, scope)))

    def _page_source(self, page: Any) -> str:
        """Read top-level Classic HTML plus same-origin course frames only."""

        if read_diagnostics.enabled():
            try:
                read_diagnostics.inspect_page(page, page.content())
            except Exception:
                pass

        sources: list[str] = []
        try:
            sources.append(page.content())
        except Exception:
            pass
        frames = getattr(page, "frames", ())
        frame_list = list(frames) if isinstance(frames, (list, tuple)) else []
        main_frame = getattr(page, "main_frame", None)
        for index, frame in enumerate(frame_list):
            if frame is main_frame or (main_frame is None and index == 0):
                continue
            frame_url = getattr(frame, "url", "") or ""
            try:
                safe_school_url(frame_url, base_url=self.config.base_url, allow_relative=False)
                source = frame.content()
            except Exception:
                continue
            if source:
                if read_diagnostics.enabled():
                    try:
                        read_diagnostics.inspect_page(frame, source, context=page.context, frame=True)
                    except Exception:
                        pass
                sources.append(source)
        return "\n".join(sources)

    def _page_documents(
        self,
        page: Any,
        *,
        course_id: str | None = None,
        course_main_only: bool = False,
        stats: dict[str, int] | None = None,
    ) -> list[tuple[str, str]]:
        """Read top-level and same-origin frame HTML with URL provenance."""

        documents: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        page_context_trusted = [
            bool(
                course_main_only
                and course_id
                and _known_course_route(getattr(page, "url", ""), course_id)
            )
        ]

        def count(reason: str) -> None:
            if stats is not None:
                stats[reason] = stats.get(reason, 0) + 1

        def trusted_parent(frame: Any, normalized: str) -> bool:
            parent = getattr(frame, "parent_frame", None)
            visited: set[int] = set()
            main_frame = getattr(page, "main_frame", None)
            parent_trusted = False
            for _ in range(8):
                if parent is None or id(parent) in visited:
                    break
                visited.add(id(parent))
                try:
                    parent_url = safe_school_url(
                        str(getattr(parent, "url", "") or ""),
                        base_url=self.config.base_url,
                        allow_relative=False,
                    )
                except ConnectorError:
                    # Do not walk through an external or detached ancestor to
                    # reach a trusted course page above it.
                    return False
                if course_id and not _course_query_matches(parent_url, course_id):
                    return False
                if course_id and _known_course_route(parent_url, course_id):
                    parent_trusted = True
                    break
                if page_context_trusted[0] and (main_frame is None or parent is main_frame):
                    parent_trusted = True
                    break
                parent = getattr(parent, "parent_frame", None)
            if not parent_trusted:
                return False
            # Bind only a frame that the trusted parent actually declared. A
            # same-origin frame URL by itself is insufficient evidence.
            declared_parent = getattr(frame, "parent_frame", None)
            if declared_parent is None:
                return False
            try:
                parent_source = declared_parent.content()
                parent_root = _parse_dom(parent_source)
                parent_url = getattr(declared_parent, "url", "") or ""
                target_path = urlsplit(normalized).path.casefold()
                for node in parent_root.descendants():
                    if node.tag not in {"iframe", "frame"}:
                        continue
                    raw_src = html_lib.unescape(unquote(str(
                        node.attrs.get("src")
                        or node.attrs.get("data-src")
                        or node.attrs.get("data-url")
                        or node.attrs.get("data-href")
                        or ""
                    ).strip()))
                    if not raw_src:
                        continue
                    try:
                        declared_url = safe_school_url(
                            urljoin(parent_url, raw_src),
                            base_url=self.config.base_url,
                            allow_relative=False,
                        )
                    except ConnectorError:
                        continue
                    if course_id and not _course_query_matches(declared_url, course_id):
                        continue
                    if declared_url == normalized or urlsplit(declared_url).path.casefold() == target_path:
                        return True
            except Exception:
                return False
            return False

        def accepted_course_document(normalized: str, source: str, owner: Any) -> bool:
            if not (course_main_only and course_id):
                return True
            if _known_course_route(normalized, course_id):
                return True
            # A foreign explicit course binding must never inherit the current
            # page's trust merely because it contains a menu-shaped element.
            if not _course_query_matches(normalized, course_id):
                count("foreign-course-document")
                return False
            if not _source_has_sidebar_structure(source):
                count("unrecognized-frame-document")
                return False
            if owner is None:
                # A redirect may remove the query from the visible URL while
                # leaving a current-course shell link in the document.
                if _source_has_current_course_route(source, course_id, source_url=normalized):
                    page_context_trusted[0] = True
                    return True
                count("unbound-top-document")
                return False
            if trusted_parent(owner, normalized):
                count("inherited-course-frame")
                return True
            count("undeclared-course-frame")
            count("unbound-frame-document")
            return False

        def add(document_url: Any, read: Callable[[], str], *, owner: Any = None) -> None:
            try:
                normalized = safe_school_url(
                    str(document_url or ""),
                    base_url=self.config.base_url,
                    allow_relative=False,
                )
                if course_main_only and course_id and not _course_query_matches(normalized, course_id):
                    count("foreign-course-document")
                    return
                if (
                    course_main_only
                    and course_id
                    and owner is not None
                    and not _known_course_route(normalized, course_id)
                    and not trusted_parent(owner, normalized)
                ):
                    count("unbound-frame-document")
                    return
                source = read()
            except Exception:
                count("document-read-failed")
                return
            if not source:
                count("empty-document")
                return
            if not accepted_course_document(normalized, source, owner):
                return
            key = (normalized, hashlib.sha256(source.encode("utf-8", "ignore")).hexdigest()[:16])
            if key not in seen:
                seen.add(key)
                documents.append((normalized, source))

        add(getattr(page, "url", ""), page.content)
        frames = getattr(page, "frames", ())
        frame_list = list(frames) if isinstance(frames, (list, tuple)) else []
        main_frame = getattr(page, "main_frame", None)
        for index, frame in enumerate(frame_list):
            if frame is main_frame or (main_frame is None and index == 0):
                continue
            frame_url = getattr(frame, "url", "") or ""
            add(frame_url, frame.content, owner=frame)
        return documents

    def _read_sidebar(
        self,
        page: Any,
        course_id: str,
        *,
        deadline: float | None = None,
        scope: str | None = None,
    ) -> _SidebarRead:
        """Read supported entries from the actual Classic course sidebar.

        Classic can attach its menu iframe after the launcher document has
        reached ``domcontentloaded``.  Re-read only the validated page/frame
        documents a few times, with the caller's snapshot deadline, and keep
        the unknown-layout result distinct from a recognized empty menu.
        """

        errors: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        max_attempts = 6
        read_scope = scope or f"course:{course_id}:sidebar"

        def add_error(error: tuple[str, str]) -> None:
            if error not in errors:
                errors.append(error)

        for attempt in range(1, max_attempts + 1):
            entries: list[_SidebarEntry] = []
            recognized = False
            stats: dict[str, int] = {}
            # Check the current same-origin page before route filtering can
            # turn a login redirect into a generic unknown menu.  Frames are
            # checked only after _page_documents proves their course binding.
            try:
                safe_school_url(
                    str(getattr(page, "url", "") or ""),
                    base_url=self.config.base_url,
                    allow_relative=False,
                )
                root = _parse_dom(page.content())
                _raise_if_auth_page(root, read_scope)
                _raise_if_forbidden(root, read_scope)
            except ConnectorError:
                raise
            except Exception:
                pass
            documents = self._page_documents(
                page,
                course_id=course_id,
                course_main_only=True,
                stats=stats,
            )
            roots_seen = 0
            menu_candidates = 0
            supported_candidates = 0
            filtered: dict[str, int] = dict(stats)
            for source_url, source in documents:
                try:
                    root = _parse_dom(source)
                    # Authentication/permission pages must keep their own
                    # actionable error instead of becoming a parse-change
                    # report merely because they have no course menu.
                    _raise_if_auth_page(root, read_scope)
                    _raise_if_forbidden(root, read_scope)
                except ConnectorError:
                    raise
                except Exception:
                    filtered["document-parse"] = filtered.get("document-parse", 0) + 1
                    continue
                roots = _sidebar_roots(root)
                if not roots:
                    continue
                recognized = True
                roots_seen += len(roots)
                for container in roots:
                    anchors = list(_anchors(container))
                    menu_candidates += len(anchors)
                    for anchor in anchors:
                        raw_href = anchor.attrs.get("href", "")
                        label = _clean_text(anchor.text())
                        if _is_skip_sidebar_entry(label, raw_href):
                            filtered["skip-label-or-route"] = filtered.get("skip-label-or-route", 0) + 1
                            continue
                        try:
                            resolved = _resolve_page_href(raw_href, source_url, base_url=self.config.base_url)
                        except ConnectorError:
                            if _raw_sidebar_supported_hint(raw_href):
                                add_error(("UNSAFE_URL", "课程侧栏入口 URL 未通过安全校验"))
                                filtered["unsafe-href"] = filtered.get("unsafe-href", 0) + 1
                            else:
                                filtered["unsafe-href"] = filtered.get("unsafe-href", 0) + 1
                            continue
                        if _is_skip_sidebar_entry(label, resolved):
                            filtered["skip-label-or-route"] = filtered.get("skip-label-or-route", 0) + 1
                            continue
                        kind_hint = _classic_sidebar_entry_kind_hint(resolved)
                        if kind_hint is None:
                            filtered["unsupported-route"] = filtered.get("unsupported-route", 0) + 1
                            continue
                        supported_candidates += 1
                        if not _course_query_matches(resolved, course_id):
                            add_error((
                                "COURSE_PARSE_CHANGED",
                                "课程侧栏资源入口指向其他课程，已跳过该入口",
                            ))
                            filtered["foreign-course"] = filtered.get("foreign-course", 0) + 1
                            continue
                        if kind_hint in {"content", "announcements"} and _course_query_id(resolved) is None:
                            add_error((
                                "COURSE_PARSE_CHANGED",
                                "课程侧栏资源入口缺少当前课程绑定，未读取该入口",
                            ))
                            filtered["missing-course-id"] = filtered.get("missing-course-id", 0) + 1
                            continue
                        kind = _classic_sidebar_entry_kind(resolved, course_id)
                        if kind is None:
                            filtered["course-binding"] = filtered.get("course-binding", 0) + 1
                            continue
                        key = (kind, resolved)
                        if key in seen:
                            filtered["duplicate"] = filtered.get("duplicate", 0) + 1
                            continue
                        seen.add(key)
                        entries.append(_SidebarEntry(kind, resolved, label))

            if recognized and menu_candidates > 0:
                return _SidebarRead(tuple(entries), True, tuple(errors))
            if attempt >= max_attempts:
                if not recognized or menu_candidates == 0:
                    frame_list = list(getattr(page, "frames", ()) or ())
                    reason_text = ",".join(
                        f"{key}={value}"
                        for key, value in sorted(filtered.items())
                        if value
                    ) or "none"
                    add_error((
                        "COURSE_PARSE_CHANGED",
                        "课程侧栏布局无法识别（frames=%d, documents=%d, menuRoots=%d, menuCandidates=%d, filtered=%s）"
                        % (len(frame_list), len(documents), roots_seen, menu_candidates, reason_text[:180]),
                    ))
                    if read_diagnostics.enabled():
                        read_diagnostics.emit_sidebar_observation(
                            frame_count=len(frame_list),
                            document_count=len(documents),
                            menu_roots=roots_seen,
                            menu_candidates=menu_candidates,
                            supported_candidates=supported_candidates,
                            accepted=len(entries),
                            filtered=filtered,
                            paths=[
                                getattr(page, "url", ""),
                                *[getattr(frame, "url", "") for frame in frame_list],
                            ],
                            attempts=attempt,
                        )
                return _SidebarRead(tuple(entries), False, tuple(errors))
            wait_ms = min(350, self._remaining_timeout_ms(deadline, read_scope))
            try:
                page.wait_for_timeout(wait_ms)
            except ConnectorError:
                raise
            except Exception:
                # A detached page/frame is handled by the next bounded scan;
                # the caller's deadline remains authoritative.
                pass
        return _SidebarRead((), False, tuple(errors))

    @staticmethod
    def _sidebar_file_markup(entries: Sequence[_SidebarEntry]) -> str:
        direct_files = [entry for entry in entries if entry.kind == "file"]
        if not direct_files:
            return ""
        parts = ["<div id=\"content_listContainer\">"]
        for entry in direct_files:
            name = entry.label or unquote(urlsplit(entry.url).path.rsplit("/", 1)[-1]) or "file"
            parts.append(
                '<a href="%s">%s</a>'
                % (html_lib.escape(entry.url, quote=True), html_lib.escape(name))
            )
        parts.append("</div>")
        return "".join(parts)

    def _read_assignment_details(
        self,
        course_id: str,
        values: Sequence[dict[str, Any]],
        *,
        deadline: float | None,
        content_pages: int,
        scope: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        """Read assignment detail pages with GET navigation and keep list rows on error."""

        result = [dict(value) for value in values]
        errors: list[dict[str, str]] = []
        if self.fixture_mode or not result:
            return result, errors
        ctx, own = self._live_context()
        page = None
        pages_read = content_pages
        try:
            page = ctx.new_page()
            for index, item in enumerate(result):
                detail_scope = f"{scope}:detail:{str(item.get('id') or index)[:120]}"
                if pages_read >= self.config.max_content_pages:
                    errors.append({"scope": detail_scope, "code": "PARTIAL_RESULTS", "message": "作业详情达到本次读取页数上限，已保留列表数据"})
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    errors.append({"scope": detail_scope, "code": "TIMEOUT", "message": "作业详情达到本次读取时间上限，已保留列表数据"})
                    break
                try:
                    target = _assignment_detail_url(str(item.get("url") or ""), base_url=self.config.base_url)
                    # Normalize before consuming the shared navigation budget:
                    # rejected links are never navigations. Every accepted
                    # target consumes one slot before goto, including failed
                    # requests and failed page parsing.
                    pages_read += 1
                    page.goto(
                        target,
                        timeout=self._remaining_timeout_ms(deadline, detail_scope),
                        wait_until="domcontentloaded",
                    )
                    self._wait_dynamic(page, deadline=deadline, scope=detail_scope)
                    # Keep the final landing URL only as the base for relative
                    # attachment links.  Do not impose a second Blackboard
                    # route/query shape on a page selected by the course.
                    final_target = _assert_page_school_url(page, base_url=self.config.base_url)
                    detail_source = self._page_source(page)
                    detail_item = dict(item)
                    detail_item["url"] = final_target
                    result[index] = _parse_assignment_detail(
                        detail_source,
                        course_id,
                        detail_item,
                        base_url=self.config.base_url,
                    )
                except ConnectorError as exc:
                    errors.append({"scope": detail_scope, "code": exc.code, "message": str(exc)})
                    if exc.code == "TIMEOUT" and deadline is not None and time.monotonic() >= deadline:
                        break
                except Exception as exc:
                    code = "TIMEOUT" if exc.__class__.__name__.casefold().endswith("timeouterror") else "COURSE_PARSE_CHANGED"
                    message = "作业详情读取超时，已保留列表数据" if code == "TIMEOUT" else "作业详情页面布局无法识别，已保留列表数据"
                    errors.append({"scope": detail_scope, "code": code, "message": message})
                    if code == "TIMEOUT":
                        break
        finally:
            if page is not None:
                try:
                    page.close()
                except Exception:
                    pass
            if own:
                self._close_temporary_context(ctx)
        return result, errors

    def _live_course_page(self, ctx: Any, course_id: str, *, content: bool, deadline: float | None = None, scope: str | None = None) -> Any:
        page = ctx.new_page()
        target = safe_school_url(LAUNCHER.format(course_id=course_id), base_url=self.config.base_url)
        read_scope = scope or f"course:{course_id}:content"
        page.goto(target, timeout=self._remaining_timeout_ms(deadline, read_scope), wait_until="domcontentloaded")
        self._wait_dynamic(page, deadline=deadline, scope=read_scope)
        _assert_page_school_url(page, base_url=self.config.base_url)
        if content:
            sidebar = self._read_sidebar(page, course_id, deadline=deadline, scope=read_scope)
            target_content = next((entry.url for entry in sidebar.entries if entry.kind == "content"), None)
            if target_content:
                page.goto(target_content, timeout=self._remaining_timeout_ms(deadline, read_scope), wait_until="domcontentloaded")
                self._wait_dynamic(page, deadline=deadline, scope=read_scope)
                _assert_page_school_url(page, base_url=self.config.base_url)
        return page

    def _live_content_source(
        self,
        ctx: Any,
        course_id: str,
        *,
        deadline: float | None = None,
        budget_errors: list[dict[str, str]] | None = None,
        scope: str | None = None,
    ) -> _FetchedContent:
        """Collect the course sidebar's content tree and bounded child folders.

        Blackboard permits arbitrary links in a course page.  Only hrefs
        found inside the validated course-menu containers become roots; child
        folders are then limited to recognized content-navigation containers.
        """

        page = ctx.new_page()
        read_scope = scope or f"course:{course_id}:content"

        def record_error(code: str, message: str) -> None:
            error = {"scope": read_scope, "code": code, "message": message}
            if budget_errors is None:
                raise ConnectorError(code, message, scope=read_scope)
            if not any(item.get("scope") == read_scope and item.get("code") == code for item in budget_errors):
                budget_errors.append(error)

        chunks: list[str] = []
        verified_course_page = False
        content_errors: list[tuple[str, str]] = []
        pages_read = 0
        try:
            launcher = safe_school_url(LAUNCHER.format(course_id=course_id), base_url=self.config.base_url)
            page.goto(launcher, timeout=self._remaining_timeout_ms(deadline, read_scope), wait_until="domcontentloaded")
            self._wait_dynamic(page, deadline=deadline, scope=read_scope)
            _assert_page_school_url(page, base_url=self.config.base_url)
            sidebar = self._read_sidebar(page, course_id, deadline=deadline, scope=read_scope)
            content_errors.extend(sidebar.errors)
            if not sidebar.recognized:
                content_errors.append(("COURSE_PARSE_CHANGED", "课程侧栏布局无法识别，未读取课程资源"))
                return _FetchedContent("", False, tuple(dict.fromkeys(content_errors)), pages_read=pages_read)

            # A recognized menu with no content entry is a valid empty result.
            # Direct sidebar files are converted into a tiny parser input so
            # they remain visible without navigating a download URL.
            direct_files = self._sidebar_file_markup(sidebar.entries)
            if direct_files:
                chunks.append(direct_files)
                verified_course_page = True
            areas = []
            for entry in sidebar.entries:
                if entry.kind == "content" and entry.url not in areas:
                    areas.append(entry.url)
            if len(areas) > self.config.max_content_areas:
                record_error("PARTIAL_RESULTS", "课程内容入口达到本次读取上限，已保留此前成功内容")
                areas = areas[: self.config.max_content_areas]
            if not areas:
                return _FetchedContent("\n".join(chunks), True, tuple(dict.fromkeys(content_errors)), pages_read=pages_read)

            seen: set[str] = set()
            queue: list[tuple[str, int]] = [(href, 0) for href in areas]
            while queue:
                if len(seen) >= self.config.max_content_pages:
                    record_error("PARTIAL_RESULTS", "课程内容页达到本次读取上限，已保留此前成功内容")
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    record_error("TIMEOUT", "Blackboard 快照达到本次读取时间上限，已保留此前成功内容")
                    break
                href, depth = queue.pop(0)
                if href in seen:
                    continue
                seen.add(href)
                # Consume the shared course page budget before navigation so
                # failed requests and parse failures cannot be retried past
                # the 48-page cap.  Only safe, deduplicated queued hrefs reach
                # this point, so skipped links never consume a slot.
                pages_read += 1
                try:
                    page.goto(href, timeout=self._remaining_timeout_ms(deadline, read_scope), wait_until="domcontentloaded")
                    self._wait_dynamic(page, deadline=deadline, scope=read_scope)
                    _assert_page_school_url(page, base_url=self.config.base_url)
                    source = self._page_source(page)
                except ConnectorError as exc:
                    if chunks and exc.code in {"TIMEOUT", "PARTIAL_RESULTS"}:
                        record_error(exc.code, str(exc))
                        break
                    raise
                except Exception as exc:
                    if exc.__class__.__name__.casefold().endswith("timeouterror"):
                        if chunks:
                            record_error("TIMEOUT", "Blackboard 快照达到本次读取时间上限，已保留此前成功内容")
                            break
                        raise ConnectorError("TIMEOUT", "Blackboard 请求超时", scope=read_scope) from exc
                    continue
                documents = self._page_documents(page, course_id=course_id, course_main_only=True)
                documents = [
                    (document_url, _absolutize_safe_hrefs(document, document_url, base_url=self.config.base_url))
                    for document_url, document in documents
                ]
                if documents:
                    source = "\n".join(document for _, document in documents)
                chunks.append(source)
                try:
                    page_root = _parse_dom(source)
                    page_evidence = any(
                        _has_valid_content_page_evidence(document_root, document_url, course_id)
                        for document_url, document in documents
                        for document_root in (_parse_dom(document),)
                    ) if documents else _has_valid_content_page_evidence(page_root, page.url, course_id)
                    if page_evidence:
                        verified_course_page = True
                    else:
                        content_error = ("COURSE_PARSE_CHANGED", "课程内容页布局无法识别，已保留其他成功页面")
                        if content_error not in content_errors:
                            content_errors.append(content_error)
                except ConnectorError:
                    page_root = None
                    content_error = ("COURSE_PARSE_CHANGED", "课程内容页无法解析，已保留其他成功页面")
                    if content_error not in content_errors:
                        content_errors.append(content_error)
                if depth >= self.config.max_folder_depth:
                    continue
                try:
                    for document_url, document in documents or [(page.url, source)]:
                        root = _parse_dom(document)
                        nav_roots = _content_navigation_roots(root)
                        for nav_root in nav_roots:
                            for anchor in _anchors(nav_root):
                                raw_child = anchor.attrs.get("href", "")
                                try:
                                    child = _resolve_page_href(raw_child, document_url, base_url=self.config.base_url)
                                except ConnectorError:
                                    continue
                                if (
                                    _classic_sidebar_entry_kind(child, course_id) == "content"
                                    and child not in seen
                                    and all(child != queued[0] for queued in queue)
                                ):
                                    queue.append((child, depth + 1))
                except ConnectorError:
                    continue
            return _FetchedContent(
                "\n".join(chunks),
                verified_course_page,
                tuple(dict.fromkeys(content_errors)),
                pages_read=pages_read,
            )
        finally:
            page.close()

    def _fetch_kind(
        self,
        course_id: str,
        kind: str,
        *,
        deadline: float | None = None,
        budget_errors: list[dict[str, str]] | None = None,
        scope: str | None = None,
    ) -> str | _FetchedContent:
        if self.fixture_mode:
            if kind == "content":
                source = self._fixture_course_html(course_id, kind)
                return _FetchedContent(source, _verified_fixture_course_page(source, course_id))
            return self._fixture_course_html(course_id, kind)
        ctx, own = self._live_context()
        page = None
        read_scope = scope or f"course:{course_id}:{kind}"
        try:
            if kind == "announcements":
                page = ctx.new_page()
                page.goto(safe_school_url(LAUNCHER.format(course_id=course_id), base_url=self.config.base_url), timeout=self._remaining_timeout_ms(deadline, read_scope), wait_until="domcontentloaded")
                self._wait_dynamic(page, deadline=deadline, scope=read_scope)
                _assert_page_school_url(page, base_url=self.config.base_url)
                sidebar = self._read_sidebar(page, course_id, deadline=deadline, scope=read_scope)
                errors = list(sidebar.errors)
                if not sidebar.recognized:
                    errors.append(("COURSE_PARSE_CHANGED", "课程侧栏布局无法识别，未读取公告"))
                    return _FetchedContent("", False, tuple(dict.fromkeys(errors)))
                targets = []
                for entry in sidebar.entries:
                    if entry.kind == "announcements" and entry.url not in targets:
                        targets.append(entry.url)
                if not targets:
                    return _FetchedContent("", True, tuple(dict.fromkeys(errors)))
                chunks: list[str] = []
                pages_read = 0
                for target in targets[: self.config.max_content_areas]:
                    if deadline is not None and time.monotonic() >= deadline:
                        errors.append(("TIMEOUT", "Blackboard 快照达到本次读取时间上限，已保留此前成功内容"))
                        break
                    try:
                        page.goto(target, timeout=self._remaining_timeout_ms(deadline, read_scope), wait_until="domcontentloaded")
                        self._wait_dynamic(page, deadline=deadline, scope=read_scope)
                        _assert_page_school_url(page, base_url=self.config.base_url)
                        documents = self._page_documents(page, course_id=course_id)
                        documents = [
                            (document_url, _absolutize_safe_hrefs(document, document_url, base_url=self.config.base_url))
                            for document_url, document in documents
                        ]
                        chunks.append("\n".join(document for _, document in documents) if documents else self._page_source(page))
                        pages_read += 1
                    except ConnectorError as exc:
                        if exc.code in {"TIMEOUT", "PARTIAL_RESULTS"}:
                            errors.append((exc.code, str(exc)))
                            break
                        raise
                    except Exception as exc:
                        if exc.__class__.__name__.casefold().endswith("timeouterror"):
                            errors.append(("TIMEOUT", "Blackboard 请求超时，已保留此前成功内容"))
                            break
                        errors.append(("COURSE_PARSE_CHANGED", "公告入口页面无法读取，已保留其他成功页面"))
                if len(targets) > self.config.max_content_areas:
                    errors.append(("PARTIAL_RESULTS", "公告入口达到本次读取上限，已保留此前成功内容"))
                return _FetchedContent("\n".join(chunks), bool(chunks), tuple(dict.fromkeys(errors)), pages_read=pages_read)
            else:
                # `_live_content_source` owns and closes its page while
                # preserving all bounded content-area HTML for both the
                # assignment and file parsers.
                return self._live_content_source(ctx, course_id, deadline=deadline, budget_errors=budget_errors, scope=read_scope)
            return self._page_source(page)
        finally:
            if page is not None:
                page.close()
            if own:
                self._close_temporary_context(ctx)

    def _ensure_course(self, course_id: str, courses: Mapping[str, dict[str, Any]] | None = None) -> dict[str, Any]:
        course_id = _safe_course_id(course_id)
        known = courses if courses is not None else self._course_map()
        course = known.get(course_id)
        if course is None:
            raise ConnectorError("COURSE_NOT_FOUND", "课程不在当前用户可访问列表中", scope=f"course:{course_id}")
        return course

    def announcements(
        self,
        course_id: str,
        limit: int = 8,
        *,
        courses: Mapping[str, dict[str, Any]] | None = None,
        deadline: float | None = None,
    ) -> dict[str, Any]:
        with self._serial():
            normalized_id: str | None = None
            content: _FetchedContent | None = None
            budget_errors: list[dict[str, str]] = []
            try:
                normalized_id = _safe_course_id(course_id)
                self._ensure_course(normalized_id, courses)
                limit = _safe_limit(limit, 8, self.config.max_announcements)
                scope = f"course:{normalized_id}:announcements"
                source = self._with_retry(
                    lambda: self._fetch_kind(normalized_id, "announcements", deadline=deadline, scope=scope),
                    scope=scope,
                )
                if isinstance(source, _FetchedContent):
                    content = source
                    resource_errors = _scoped_content_errors(content, scope)
                    if not content.html:
                        return self._resource("announcements", [], errors=resource_errors)
                    values = parse_announcements(content.html, normalized_id, base_url=self.config.base_url, limit=limit)
                    return self._resource("announcements", values, errors=resource_errors)
                values = parse_announcements(source, normalized_id, base_url=self.config.base_url, limit=limit)
                return self._resource("announcements", values)
            except ConnectorError as exc:
                scope = f"course:{normalized_id}:announcements" if normalized_id else "announcements"
                errors = _scoped_content_errors(content, scope)
                current = self._error(exc, scope)
                if not any(item.get("code") == current.get("code") and item.get("scope") == current.get("scope") for item in errors):
                    errors.append(current)
                return self._resource("announcements", [], errors=errors)

    def assignments(
        self,
        course_id: str,
        *,
        keyword: str = "",
        details: bool = False,
        limit: int = 100,
        courses: Mapping[str, dict[str, Any]] | None = None,
        deadline: float | None = None,
        content_cache: dict[str, tuple[_FetchedContent, str | None]] | None = None,
    ) -> dict[str, Any]:
        with self._serial():
            normalized_id: str | None = None
            content: _FetchedContent | None = None
            budget_errors: list[dict[str, str]] = []
            detail_errors: list[dict[str, str]] = []
            try:
                normalized_id = _safe_course_id(course_id)
                self._ensure_course(normalized_id, courses)
                limit = _safe_limit(limit, 100, self.config.max_assignments)
                scope = f"course:{normalized_id}:assignments"
                cached = content_cache.get(normalized_id) if content_cache is not None else None
                if cached is not None:
                    content, budget_code = cached
                    if budget_code:
                        budget_errors.append({"scope": scope, "code": budget_code, "message": "Blackboard 内容读取达到本次上限，已保留此前成功内容"})
                else:
                    content = self._with_retry(
                        lambda: self._fetch_kind(normalized_id, "content", deadline=deadline, budget_errors=budget_errors, scope=scope),
                        scope=scope,
                    )
                    if not isinstance(content, _FetchedContent):
                        content = _FetchedContent(content, self.fixture_mode)
                    if content_cache is not None:
                        content_cache[normalized_id] = (content, next((str(item.get("code")) for item in budget_errors if item.get("code")), None))
                values = parse_assignments(content.html, normalized_id, base_url=self.config.base_url, limit=limit, verified_page=content.verified_course_page)
                read_diagnostics.emit("parsed-assignments", count=len(values))
                if keyword:
                    needle = keyword.casefold()
                    values = [item for item in values if needle in str(item.get("title", "")).casefold()]
                if details:
                    try:
                        values, detail_errors = self._read_assignment_details(
                            normalized_id,
                            values,
                            deadline=deadline,
                            content_pages=content.pages_read,
                            scope=scope,
                        )
                    except ConnectorError as exc:
                        detail_errors.append(self._error(exc, f"{scope}:detail"))
                # Details are read with GET navigation only; no download or
                # submit argument is exposed by this path.
                resource_errors = _scoped_content_errors(content, scope) + budget_errors + detail_errors
                return self._resource("assignments", values, errors=resource_errors)
            except ConnectorError as exc:
                scope = f"course:{normalized_id}:assignments" if normalized_id else "assignments"
                errors = _scoped_content_errors(content, scope) + budget_errors + detail_errors
                current = self._error(exc, scope)
                if not any(item.get("scope") == current["scope"] and item.get("code") == current["code"] for item in errors):
                    errors.append(current)
                return self._resource("assignments", [], errors=errors)

    def files(
        self,
        course_id: str,
        limit: int = 100,
        *,
        courses: Mapping[str, dict[str, Any]] | None = None,
        deadline: float | None = None,
        content_cache: dict[str, tuple[_FetchedContent, str | None]] | None = None,
    ) -> dict[str, Any]:
        with self._serial():
            normalized_id: str | None = None
            content: _FetchedContent | None = None
            budget_errors: list[dict[str, str]] = []
            try:
                normalized_id = _safe_course_id(course_id)
                self._ensure_course(normalized_id, courses)
                limit = _safe_limit(limit, 100, self.config.max_files)
                scope = f"course:{normalized_id}:files"
                cached = content_cache.get(normalized_id) if content_cache is not None else None
                if cached is not None:
                    content, budget_code = cached
                    if budget_code:
                        budget_errors.append({"scope": scope, "code": budget_code, "message": "Blackboard 内容读取达到本次上限，已保留此前成功内容"})
                else:
                    content = self._with_retry(
                        lambda: self._fetch_kind(normalized_id, "content", deadline=deadline, budget_errors=budget_errors, scope=scope),
                        scope=scope,
                    )
                    if not isinstance(content, _FetchedContent):
                        content = _FetchedContent(content, self.fixture_mode)
                    if content_cache is not None:
                        content_cache[normalized_id] = (content, next((str(item.get("code")) for item in budget_errors if item.get("code")), None))
                values = parse_files(content.html, normalized_id, base_url=self.config.base_url, limit=limit, verified_page=content.verified_course_page)
                read_diagnostics.emit("parsed-files", count=len(values))
                resource_errors = _scoped_content_errors(content, scope) + budget_errors
                return self._resource("files", values, errors=resource_errors)
            except ConnectorError as exc:
                scope = f"course:{normalized_id}:files" if normalized_id else "files"
                errors = _scoped_content_errors(content, scope) + budget_errors
                current = self._error(exc, scope)
                if not any(item.get("scope") == current["scope"] and item.get("code") == current["code"] for item in errors):
                    errors.append(current)
                return self._resource("files", [], errors=errors)

    @staticmethod
    def _error(exc: ConnectorError, scope: str | None = None) -> dict[str, str]:
        return {"scope": scope or exc.scope, "code": exc.code, "message": str(exc)}

    def snapshot(
        self,
        course_ids: Sequence[str] | None = None,
        include: Sequence[str] | None = None,
        limits: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Return one bounded read-only snapshot for the Electron client."""

        with self._serial():
            deadline = time.monotonic() + max(30_000, self.config.snapshot_timeout_ms) / 1000
            try:
                course_result = self.list_courses(deadline=deadline)
            except ConnectorError as exc:
                return Snapshot("error", now_iso(), errors=(self._error(exc, "courses"),)).as_dict()
            courses = list(course_result.get("courses", []))
            course_map = {course["id"]: course for course in courses}
            errors: list[dict[str, str]] = list(course_result.get("errors", []))
            if time.monotonic() >= deadline:
                errors.append({
                    "scope": "courses",
                    "code": "TIMEOUT",
                    "message": "Blackboard 快照达到本次读取时间上限，已保留课程列表",
                })
                return Snapshot(
                    self._state_for_errors(errors, has_values=bool(courses)),
                    now_iso(),
                    tuple(courses),
                    errors=tuple(errors),
                ).as_dict()
            try:
                wanted = {_safe_course_id(cid) for cid in course_ids} if course_ids else {c["id"] for c in courses}
            except ConnectorError as exc:
                errors.append(self._error(exc, "snapshot:course_ids"))
                return Snapshot(
                    self._state_for_errors(errors, has_values=bool(courses)),
                    now_iso(),
                    tuple(courses),
                    errors=tuple(errors),
                ).as_dict()
            selected = [c for c in courses if c["id"] in wanted]
            # An explicit unknown course is an error; this prevents a typo from
            # being reported as an empty successful snapshot.
            if course_ids:
                known = {c["id"] for c in courses}
                for cid in wanted - known:
                    errors.append({"scope": f"course:{cid}", "code": "COURSE_NOT_FOUND", "message": "课程不在当前用户可访问列表中"})
            requested = {str(x) for x in (include or ("announcements", "assignments", "files"))}
            invalid = requested - {"announcements", "assignments", "files"}
            if invalid:
                errors.append({"scope": "snapshot", "code": "INVALID_INPUT", "message": "include contains an unsupported resource"})
                requested -= invalid
            announcements: list[dict[str, Any]] = []
            assignments: list[dict[str, Any]] = []
            files: list[dict[str, Any]] = []
            # Assignments and files consume the same bounded Classic content
            # tree for a course; do not navigate it twice in one snapshot.
            content_cache: dict[str, tuple[_FetchedContent, str | None]] = {}
            timed_out_scopes: set[str] = set()

            def within_snapshot_budget(scope: str) -> bool:
                if time.monotonic() < deadline:
                    return True
                if scope not in timed_out_scopes:
                    timed_out_scopes.add(scope)
                    errors.append({
                        "scope": scope,
                        "code": "TIMEOUT",
                        "message": "Blackboard 快照达到本次读取时间上限，已保留此前成功内容",
                    })
                return False

            if limits is None:
                limit_map: Mapping[str, Any] = {}
            elif isinstance(limits, Mapping):
                limit_map = limits
            else:
                errors.append({"scope": "snapshot:limits", "code": "INVALID_INPUT", "message": "limits must be an object"})
                limit_map = {}
            for course in selected:
                cid = course["id"]
                if "announcements" in requested:
                    scope = f"course:{cid}:announcements"
                    if within_snapshot_budget(scope):
                        try:
                            resource_limit = _safe_limit(limit_map.get("announcements"), 8, self.config.max_announcements)
                            result = self.announcements(cid, resource_limit, courses=course_map, deadline=deadline)
                            announcements.extend(result.get("announcements", []))
                            errors.extend(result.get("errors", []))
                        except ConnectorError as exc:
                            errors.append(self._error(exc, scope))
                if "assignments" in requested:
                    scope = f"course:{cid}:assignments"
                    if within_snapshot_budget(scope):
                        try:
                            resource_limit = _safe_limit(limit_map.get("assignments"), 100, self.config.max_assignments)
                            result = self.assignments(
                                cid,
                                limit=resource_limit,
                                details=True,
                                courses=course_map,
                                deadline=deadline,
                                content_cache=content_cache,
                            )
                            assignments.extend(result.get("assignments", []))
                            errors.extend(result.get("errors", []))
                        except ConnectorError as exc:
                            errors.append(self._error(exc, scope))
                if "files" in requested:
                    scope = f"course:{cid}:files"
                    if within_snapshot_budget(scope):
                        try:
                            resource_limit = _safe_limit(limit_map.get("files"), 100, self.config.max_files)
                            result = self.files(cid, resource_limit, courses=course_map, deadline=deadline, content_cache=content_cache)
                            files.extend(result.get("files", []))
                            errors.extend(result.get("errors", []))
                        except ConnectorError as exc:
                            errors.append(self._error(exc, scope))
            state = self._state_for_errors(errors, has_values=bool(courses or announcements or assignments or files))
            return Snapshot(
                state,
                now_iso(),
                tuple(courses),
                tuple(announcements),
                tuple(assignments),
                tuple(files),
                tuple(errors),
            ).as_dict()


__all__ = [
    "ANNOUNCEMENT_KEYS",
    "ASSIGNMENT_KEYS",
    "COURSE_FILE_KEYS",
    "COURSE_KEYS",
    "SNAPSHOT_KEYS",
    "Assignment",
    "Announcement",
    "ClassicConnector",
    "ConnectorConfig",
    "ConnectorError",
    "Course",
    "CourseFile",
    "ManualAuthProvider",
    "Snapshot",
    "now_iso",
    "parse_announcements",
    "parse_assignments",
    "parse_courses",
    "parse_courses_checked",
    "parse_due",
    "parse_files",
    "safe_school_url",
]
