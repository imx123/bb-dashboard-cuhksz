"""CUHK(SZ) Blackboard Classic read-only MCP sidecar.

The sidecar deliberately keeps the browser integration and the pure HTML
parsers in one small module so fixture tests exercise the same conversion
functions used by the live reader.  Credentials are not part of this package;
interactive authorization is provided by :class:`ManualAuthProvider`.
"""

from .classic_connector import (
    ANNOUNCEMENT_KEYS,
    ASSIGNMENT_KEYS,
    COURSE_FILE_KEYS,
    COURSE_KEYS,
    SNAPSHOT_KEYS,
    Assignment,
    Announcement,
    ClassicConnector,
    ConnectorConfig,
    Course,
    CourseFile,
    ManualAuthProvider,
    Snapshot,
    parse_announcements,
    parse_assignments,
    parse_courses,
    parse_courses_checked,
    parse_files,
    safe_school_url,
)

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
    "Course",
    "CourseFile",
    "ManualAuthProvider",
    "Snapshot",
    "parse_announcements",
    "parse_assignments",
    "parse_courses",
    "parse_courses_checked",
    "parse_files",
    "safe_school_url",
]
