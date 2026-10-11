"""Offline M1/M2 tests for the Classic connector.

All HTML under ``test/fixtures/classic`` is synthetic DOM prepared for parser
coverage.  No Blackboard account, network request, credential or cookie is
used by these tests.
"""

from __future__ import annotations

import json
import asyncio
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace


HERE = Path(__file__).resolve()
ROOT = HERE.parents[2]
FIXTURES = ROOT / "test" / "fixtures" / "classic"
sys.path.insert(0, str(HERE.parent))

from classic_connector import (  # noqa: E402
    ClassicConnector,
    ConnectorConfig,
    ConnectorError,
    ManualAuthProvider,
    parse_announcements,
    parse_assignments,
    parse_courses,
    parse_courses_checked,
    parse_due,
    parse_files,
    safe_school_url,
)
from connector_runtime import ConnectorRuntime  # noqa: E402


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class ClassicParserTests(unittest.TestCase):
    def test_courses_are_stable_and_deduplicated_by_id(self) -> None:
        rows = parse_courses(read_fixture("courses.html"))
        self.assertEqual([row["id"] for row in rows], ["_123456_1", "_234567_1", "_345678_1"])
        self.assertTrue(all(set(row) == {"id", "name", "code", "url"} for row in rows))

    def test_empty_courses_are_distinct_from_unknown_content(self) -> None:
        self.assertEqual(parse_courses("<html><body><p>No courses enrolled.</p></body></html>"), [])
        with self.assertRaises(ConnectorError) as ctx:
            parse_courses_checked("<html><body><div id='redesigned-shell'>Hello</div></body></html>")
        self.assertEqual(ctx.exception.code, "COURSE_PARSE_CHANGED")

    def test_generic_content_not_available_is_not_empty_for_any_resource(self) -> None:
        source = "<html><body><p>Content not available</p></body></html>"
        parsers = (
            lambda: parse_courses_checked(source),
            lambda: parse_announcements(source, "_123456_1"),
            lambda: parse_assignments(source, "_123456_1"),
            lambda: parse_files(source, "_123456_1"),
        )
        for parser in parsers:
            with self.subTest(parser=parser):
                with self.assertRaises(ConnectorError) as ctx:
                    parser()
                self.assertEqual(ctx.exception.code, "COURSE_PARSE_CHANGED")

    def test_announcements_support_multilingual_and_missing_dates(self) -> None:
        rows = parse_announcements(read_fixture("course-_123456_1-announcements.html"), "_123456_1")
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["publishedAt"], "2026-10-02")
        self.assertIsNone(rows[1]["publishedAt"])
        self.assertEqual(rows[0]["unread"], True)
        self.assertIsNone(rows[1]["unread"])
        self.assertEqual(len({row["id"] for row in rows}), 3)

    def test_unknown_announcement_layout_is_explicit(self) -> None:
        with self.assertRaises(ConnectorError) as ctx:
            parse_announcements("<html><body><h3>Some redesigned heading</h3></body></html>", "_123456_1")
        self.assertEqual(ctx.exception.code, "COURSE_PARSE_CHANGED")
        id_only = "<div id='announcementList'><li><h3>公告一</h3><p>内容一</p></li><li><h3>公告二</h3><p>内容二</p></li></div>"
        self.assertEqual([item["title"] for item in parse_announcements(id_only, "_123456_1")], ["公告一", "公告二"])

    def test_assignment_due_date_rules(self) -> None:
        rows = parse_assignments(read_fixture("course-_123456_1-content.html"), "_123456_1")
        self.assertEqual(len(rows), 4)
        first = rows[0]
        self.assertEqual(first["dueAt"], "2026-10-20T23:59:00+08:00")
        self.assertIsNone(first["dueDateOnly"])
        self.assertEqual(first["dueEvidence"], "page-text")
        self.assertEqual(first["remoteSubmission"], "not-submitted")
        self.assertEqual(rows[1]["dueDateOnly"], "2026-11-05")
        self.assertIsNone(rows[1]["dueAt"])
        self.assertEqual(rows[2]["dueDateOnly"], "2026-10-28")
        self.assertEqual(rows[3]["dueDateOnly"], "2026-10-30")
        # The publication/upload dates do not become due dates.
        self.assertNotEqual(rows[0]["dueDateOnly"], "2026-09-01")

    def test_due_date_parser_handles_english_and_unknown_text(self) -> None:
        self.assertEqual(parse_due("Published: 2026-09-01")[0:2], (None, None))
        self.assertEqual(parse_due("Due date: TBA. Published: 2026-09-01"), (None, None, "unknown"))
        self.assertEqual(parse_due("Deadline: see Published: 2026-09-01"), (None, None, "unknown"))
        self.assertEqual(parse_due("Deadline: 20 Oct 2026 17:00")[0], "2026-10-20T17:00:00+08:00")
        self.assertEqual(parse_due("截止时间：2026年10月20日")[1], "2026-10-20")
        self.assertEqual(parse_due("Due: 2026-10-20 15:59 UTC")[0], "2026-10-20T23:59:00+08:00")
        nested = "<li class='contentItem'><h3><a href='/webapps/assessment/take/launch.jsp?course_id=_123456_1&content_id=_nested_1'>嵌套日期作业</a></h3><div><span>Due Date: </span><strong>2026-12-01 12:00</strong></div></li>"
        self.assertEqual(parse_assignments(nested, "_123456_1")[0]["dueAt"], "2026-12-01T12:00:00+08:00")

    def test_files_keep_publication_date_without_treating_it_as_ddl(self) -> None:
        rows = parse_files(read_fixture("course-_123456_1-content.html"), "_123456_1")
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["publishedAt"], "2026-09-01")
        self.assertTrue(all("dueAt" not in row for row in rows))

    def test_duplicate_assignment_titles_with_different_links_are_preserved(self) -> None:
        rows = parse_assignments(read_fixture("course-_123456_1-content.html"), "_123456_1")
        repeated = [row for row in rows if row["title"] == "重复标题作业"]
        self.assertEqual(len(repeated), 2)
        self.assertNotEqual(repeated[0]["url"], repeated[1]["url"])
        self.assertNotEqual(repeated[0]["id"], repeated[1]["id"])

    def test_malicious_url_and_fixture_path_are_rejected(self) -> None:
        with self.assertRaises(ConnectorError):
            safe_school_url("javascript:alert(1)")
        with self.assertRaises(ConnectorError):
            safe_school_url("https://evil.example.invalid/x")
        with self.assertRaises(ConnectorError):
            safe_school_url("https://bb.cuhk.edu.cn:bad/x")
        with self.assertRaises(ConnectorError):
            safe_school_url("https://bb.cuhk.edu.cn/../../outside")
        with self.assertRaises(ConnectorError):
            safe_school_url("https://bb.cuhk.edu.cn/%2e%2e/outside")

    def test_permission_page_is_not_an_empty_success(self) -> None:
        with self.assertRaises(ConnectorError) as ctx:
            parse_courses_checked(read_fixture("permission-denied.html"))
        self.assertEqual(ctx.exception.code, "FORBIDDEN")

    def test_manual_login_requires_positive_portal_evidence(self) -> None:
        connector = SimpleNamespace(config=ConnectorConfig(base_url="https://bb.cuhk.edu.cn"))

        class FakePage:
            def __init__(self, url: str, source: str) -> None:
                self.url = url
                self.source = source
                self.closed = False

            def goto(self, *_args: object, **_kwargs: object) -> None:
                return None

            def wait_for_timeout(self, _milliseconds: int) -> None:
                return None

            def content(self) -> str:
                return self.source

            def close(self) -> None:
                self.closed = True

        class FakeContext:
            def __init__(self, page: FakePage) -> None:
                self.page = page

            def new_page(self) -> FakePage:
                return self.page

        def logged_in(url: str, source: str) -> bool:
            page = FakePage(url, source)
            self.assertFalse(page.closed)
            result = ManualAuthProvider._logged_in(FakeContext(page), connector)
            self.assertTrue(page.closed)
            return result

        portal_url = "https://bb.cuhk.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_2_1"
        # The old URL-only check accepted this same-origin custom SSO path.
        self.assertFalse(
            logged_in(
                "https://bb.cuhk.edu.cn/auth/login",
                "<html><body><div id='globalNavPageNavArea'>login shell</div></body></html>",
            )
        )
        # A logged-in user with no courses still has positive Classic portal
        # navigation evidence and must be accepted.
        self.assertTrue(
            logged_in(
                portal_url,
                "<html><body><div id='globalNavPageNavArea'><div id='myCourses'>No courses enrolled.</div></div></body></html>",
            )
        )
        # The expected portal URL alone is not enough when its DOM is unknown.
        self.assertFalse(logged_in(portal_url, "<html><body><p>Unknown page</p></body></html>"))

    def test_manual_auth_accepts_visible_1_1_portal_and_same_origin_iframe(self) -> None:
        connector = SimpleNamespace(config=ConnectorConfig(base_url="https://bb.cuhk.edu.cn"))
        portal_url = "https://bb.cuhk.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1"

        class Frame:
            url = portal_url

            def content(self) -> str:
                return "<div id='myCourses'><a href='/webapps/portal/execute/tabs/tabAction?type=Course&id=_123456_1'>课程</a></div>"

        class Page:
            def __init__(self, url: str, source: str, frames: list[object] | None = None) -> None:
                self.url = url
                self.source = source
                self.frames = frames or []
                self.closed = False

            def is_closed(self) -> bool:
                return self.closed

            @property
            def main_frame(self) -> object:
                return self

            def content(self) -> str:
                return self.source

            def close(self) -> None:
                self.closed = True

        page = Page(
            "https://bb.cuhk.edu.cn/webapps/portal/frameset.jsp?tab_tab_group_id=_1_1&url=%2F",
            "<iframe src='https://bb.cuhk.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1'></iframe>",
        )
        page.frames = [page, Frame()]
        context = SimpleNamespace(pages=[page])
        probe = ManualAuthProvider._auth_probe(context, connector)
        self.assertTrue(probe["authenticated"])
        self.assertEqual(probe["courseLinkCount"], 1)
        self.assertEqual(probe["iframeCount"], 1)
        self.assertTrue(probe["marker"])

    def test_manual_auth_diagnostics_reject_generic_and_foreign_frame_shells(self) -> None:
        connector = SimpleNamespace(config=ConnectorConfig(base_url="https://bb.cuhk.edu.cn"))

        class Page:
            def __init__(self, url: str, source: str, frames: list[object] | None = None) -> None:
                self.url = url
                self.source = source
                self.frames = frames or []
                self.closed = False

            def is_closed(self) -> bool:
                return self.closed

            @property
            def main_frame(self) -> object:
                return self

            def content(self) -> str:
                return self.source

            def close(self) -> None:
                self.closed = True

        unknown = Page(
            "https://bb.cuhk.edu.cn/webapps/portal/execute/defaultTab",
            "<div id='globalNavPageNavArea'><div class='breadcrumbs'>匿名门户壳</div></div>",
        )
        unknown_probe = ManualAuthProvider._probe_page(unknown)
        self.assertFalse(unknown_probe["authenticated"])
        self.assertTrue(unknown_probe["portalCandidate"])
        self.assertFalse(unknown_probe["marker"])
        code, _ = ManualAuthProvider._auth_failure(unknown_probe)
        self.assertEqual(code, "AUTH_CHECK_UNRECOGNIZED")

        # Public defaultTab shells can expose generic navigation, manual links
        # containing Blackboard-looking ids, and a relogin anchor.  None of
        # those links are authenticated course launchers, and the relogin
        # action must win over generic shell markers.
        anonymous = Page(
            "https://bb.cuhk.edu.cn/webapps/portal/execute/defaultTab",
            read_fixture("anonymous-default-tab.html"),
        )
        anonymous_probe = ManualAuthProvider._probe_page(anonymous)
        self.assertFalse(anonymous_probe["authenticated"])
        self.assertEqual(anonymous_probe["courseLinkCount"], 0)
        self.assertTrue(anonymous_probe["loginAnchor"])
        code, _ = ManualAuthProvider._auth_failure(anonymous_probe)
        self.assertEqual(code, "AUTH_REQUIRED")

        # A protected portal may expose a logout control; that action is
        # positive evidence and must not be rejected as a login anchor.
        logout = Page(
            "https://bb.cuhk.edu.cn/webapps/portal/execute/defaultTab",
            "<div id='myCourses'><a href='/webapps/portal/execute/tabs/tabAction?type=Course&id=_123456_1'>课程</a><a href='/webapps/portal/execute/logout'>Log out</a></div>",
        )
        logout_probe = ManualAuthProvider._probe_page(logout)
        self.assertTrue(logout_probe["authenticated"])
        self.assertTrue(logout_probe["logoutAnchor"])
        self.assertFalse(logout_probe["loginAnchor"])

        class ForeignFrame:
            url = "https://bb.cuhk.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1"

            def content(self) -> str:
                return "<div id='myCourses'><a href='?type=Course&id=_123456_1'>课程</a></div>"

        foreign = Page("https://login.example.edu/signin", "<iframe></iframe>")
        foreign.frames = [foreign, ForeignFrame()]
        foreign_probe = ManualAuthProvider._probe_page(foreign)
        self.assertFalse(foreign_probe["authenticated"])
        self.assertIsNone(foreign_probe["origin"])
        self.assertFalse(foreign_probe["portalCandidate"])

        login = Page(
            "https://bb.cuhk.edu.cn/webapps/portal/execute/defaultTab",
            "<form action='/login'><input name='user_id'><input type='password' name='password'></form>",
        )
        login_probe = ManualAuthProvider._probe_page(login)
        self.assertTrue(login_probe["explicitLoginForm"])
        code, _ = ManualAuthProvider._auth_failure(login_probe)
        self.assertEqual(code, "AUTH_REQUIRED")

        public = ManualAuthProvider._public_auth_result({
            **unknown_probe,
            "origin": "https://bb.cuhk.edu.cn",
            "pathname": "/webapps/portal/execute/defaultTab",
            "portalTarget": "/webapps/portal/execute/defaultTab",
        })
        self.assertNotIn("?", str(public))
        self.assertNotIn("#", str(public))

    def test_preferred_portal_url_reuses_known_visible_tab_without_arbitrary_query(self) -> None:
        auth = ManualAuthProvider()
        page = SimpleNamespace(url="https://bb.cuhk.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1&account=should-not-be-kept")
        auth._page = page
        context = SimpleNamespace(pages=[page])
        connector = SimpleNamespace(config=ConnectorConfig(base_url="https://bb.cuhk.edu.cn"))
        target = auth.preferred_portal_url(context, connector)
        self.assertEqual(target, "https://bb.cuhk.edu.cn/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1")

    def test_manual_auth_discards_a_browser_context_closed_by_the_user(self) -> None:
        auth = ManualAuthProvider()

        class ClosedContext:
            def is_closed(self) -> bool:
                return True

        auth._ctx = ClosedContext()
        self.assertIsNone(auth.context())
        self.assertIsNone(auth._ctx)


class ClassicConnectorFixtureTests(unittest.TestCase):
    def _config(self, fixture_dir: Path) -> ConnectorConfig:
        return ConnectorConfig(
            base_url="https://bb.cuhk.edu.cn",
            user_data_dir=fixture_dir / "runtime-profile",
            retries=0,
            fixture_dir=fixture_dir,
        )

    def test_fixture_snapshot_is_structured_and_read_only(self) -> None:
        connector = ClassicConnector(self._config(FIXTURES))
        try:
            result = connector.snapshot()
        finally:
            connector.close()
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["timezone"], "Asia/Shanghai")
        self.assertEqual(len(result["courses"]), 3)
        self.assertGreaterEqual(len(result["announcements"]), 3)
        self.assertGreaterEqual(len(result["assignments"]), 5)
        self.assertGreaterEqual(len(result["files"]), 3)
        self.assertRegex(result["fetchedAt"], r"\+08:00$")
        self.assertEqual(set(result), {"state", "fetchedAt", "timezone", "courses", "announcements", "assignments", "files", "errors"})
        self.assertFalse((FIXTURES / "runtime-profile").exists())

    def test_missing_fixture_is_an_error_and_empty_page_is_success(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            temp_path = Path(temp)
            (temp_path / "courses.html").write_text("<html><body><p>No courses.</p></body></html>", encoding="utf-8")
            connector = ClassicConnector(self._config(temp_path))
            try:
                empty = connector.list_courses()
            finally:
                connector.close()
        self.assertEqual(empty["state"], "ok")
        self.assertEqual(empty["courses"], [])

        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            temp_path = Path(temp)
            connector = ClassicConnector(self._config(temp_path))
            try:
                failed = connector.list_courses()
            finally:
                connector.close()
        self.assertEqual(failed["state"], "error")
        self.assertEqual(failed["errors"][0]["code"], "FIXTURE_NOT_FOUND")

    def test_snapshot_retains_partial_course_failures(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            temp_path = Path(temp)
            for filename in ("courses.html", "course-_123456_1-announcements.html", "course-_123456_1-content.html"):
                shutil.copyfile(FIXTURES / filename, temp_path / filename)
            connector = ClassicConnector(self._config(temp_path))
            try:
                result = connector.snapshot()
            finally:
                connector.close()
        self.assertEqual(result["state"], "partial")
        self.assertTrue(result["assignments"])
        self.assertTrue(any(error["code"] == "FIXTURE_NOT_FOUND" for error in result["errors"]))

    def test_resource_input_errors_stay_in_structured_envelopes(self) -> None:
        connector = ClassicConnector(self._config(FIXTURES))
        try:
            bad_course = connector.announcements("../outside", courses={})
            bad_limit = connector.files("_123456_1", limit=0, courses={"_123456_1": {"id": "_123456_1"}})
            bad_snapshot = connector.snapshot(course_ids=["unsafe"])
            auth_state = connector._resource(
                "courses", [], errors=[{"scope": "auth", "code": "AUTH_REQUIRED", "message": "需要登录"}]
            )
            connector.list_courses = lambda: {
                "state": "auth-required",
                "courses": [],
                "errors": [{"scope": "auth", "code": "AUTH_REQUIRED", "message": "需要登录"}],
            }
            auth_resource = connector.announcements("_123456_1")
        finally:
            connector.close()
        self.assertEqual(bad_course["state"], "error")
        self.assertEqual(bad_course["errors"][0]["code"], "INVALID_INPUT")
        self.assertEqual(bad_limit["state"], "error")
        self.assertEqual(bad_limit["errors"][0]["code"], "INVALID_INPUT")
        self.assertEqual(bad_snapshot["state"], "partial")
        self.assertEqual(bad_snapshot["errors"][0]["code"], "INVALID_INPUT")
        self.assertEqual(auth_state["state"], "auth-required")
        self.assertEqual(auth_resource["state"], "auth-required")
        self.assertEqual(auth_resource["errors"][0]["code"], "AUTH_REQUIRED")


class ConnectorRuntimeTests(unittest.TestCase):
    def test_connector_and_close_stay_on_one_worker_thread(self) -> None:
        main_thread = threading.get_ident()
        seen: list[tuple[str, int]] = []

        class FakeConnector:
            def status(self) -> dict[str, object]:
                seen.append(("status", threading.get_ident()))
                return {"state": "ok", "authenticated": True}

            def close(self) -> None:
                seen.append(("close", threading.get_ident()))

        runtime = ConnectorRuntime(FakeConnector)  # type: ignore[arg-type]
        try:
            result = asyncio.run(runtime.call("status"))
            self.assertEqual(result["state"], "ok")
        finally:
            runtime.close_sync()
        self.assertEqual([name for name, _ in seen], ["status", "close"])
        self.assertNotEqual(seen[0][1], main_thread)
        self.assertEqual(seen[0][1], seen[1][1])


if __name__ == "__main__":
    unittest.main()
