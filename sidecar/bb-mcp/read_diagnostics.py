"""Opt-in, bounded read diagnostics; never log URLs, headers or page text."""
from __future__ import annotations

import json
import hashlib
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

_attached: set[int] = set()
_probed: set[tuple[int, str]] = set()
_records = 0
_json_records = 0
_FIELD_NAMES = {"results", "items", "data", "courses", "courseId", "contentId", "assignments", "announcements", "files", "attachments", "title", "name", "body", "description", "dueDate", "dueAt", "availability", "available", "gradable", "grade", "grades", "submission", "submissions", "status", "url", "href", "downloadUrl", "fileName", "mimeType", "paging", "total", "count", "id"}
_READ_PATHS = {
    "/webapps/blackboard/content/listContent.jsp",
    "/webapps/blackboard/execute/announcement",
    "/webapps/portal/execute/tabs/tabAction",
}
_SAFE_ROUTE_PATHS = {path.casefold() for path in _READ_PATHS} | {
    "/webapps/blackboard/execute/launcher",
    "/webapps/blackboard/execute/coursemain",
    "/webapps/blackboard/execute/modulepage/view",
    "/webapps/blackboard/execute/announcementmanager",
    "/webapps/blackboard/content/contentwrapper.jsp",
}


def enabled() -> bool:
    return os.environ.get("BB_READ_DIAGNOSTICS") == "1"


def emit(kind: str, **counts: object) -> None:
    global _records
    if not enabled() or _records >= 300:
        return
    try:
        target = Path(__file__).resolve().parents[2] / ".work" / "classic-read-diagnostics-v3.jsonl"
        target.parent.mkdir(exist_ok=True)
        with target.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"kind": kind, **counts}, ensure_ascii=True) + "\n")
        _records += 1
    except Exception:
        pass  # Diagnostics must not change normal read results.


def _safe_route_path(value: object) -> str | None:
    """Return only the same-origin scheme/host/path portion of a URL."""

    try:
        parsed = urlsplit(str(value or ""))
        if parsed.scheme.casefold() != "https" or parsed.netloc.casefold() != "bb.cuhk.edu.cn":
            return None
        path = (parsed.path or "/").rstrip("/").casefold() or "/"
        if path not in _SAFE_ROUTE_PATHS:
            path = "/webapps/blackboard/<unknown-route>" if path.startswith("/webapps/blackboard/") else "/<unknown-route>"
        return f"{parsed.scheme.casefold()}://{parsed.netloc.casefold()}{path}"
    except Exception:
        return None


def emit_sidebar_observation(
    *,
    frame_count: int,
    document_count: int,
    menu_roots: int,
    menu_candidates: int,
    supported_candidates: int,
    accepted: int,
    filtered: dict[str, int],
    paths: list[str],
    attempts: int,
) -> None:
    """Write bounded, redacted structure diagnostics for a sidebar read."""

    safe_paths = sorted({path for value in paths if (path := _safe_route_path(value))})[:32]
    emit(
        "sidebar",
        frameCount=max(0, int(frame_count)),
        documentCount=max(0, int(document_count)),
        menuRoots=max(0, int(menu_roots)),
        menuCandidates=max(0, int(menu_candidates)),
        supportedCandidates=max(0, int(supported_candidates)),
        accepted=max(0, int(accepted)),
        filtered={str(key): max(0, int(value)) for key, value in sorted(filtered.items())},
        paths=safe_paths,
        attempts=max(0, int(attempts)),
    )


def shape(source: str) -> dict[str, int]:
    return {
        "chars": len(source),
        "iframes": len(re.findall(r"<iframe\b", source, re.I)),
        "forms": len(re.findall(r"<form\b", source, re.I)),
        "contentLinks": len(re.findall(r"listContent", source, re.I)),
        "assignmentMarkers": len(re.findall(r"uploadAssignment|assignmentInfo|assessment", source, re.I)),
        "fileMarkers": len(re.findall(r"/bbcswebdav/", source, re.I)),
        "loginMarkers": len(re.findall(r'type\s*=\s*[\"\x27]password', source, re.I)),
    }


def attach(context: object) -> None:
    if not enabled() or id(context) in _attached:
        return
    try:
        def response_seen(response: object) -> None:
            try:
                parsed = urlsplit(response.url)
                if parsed.scheme != "https" or parsed.netloc != "bb.cuhk.edu.cn":
                    return
                resource = response.request.resource_type
                if resource not in {"document", "xhr", "fetch"}:
                    return
                content_type = response.header_value("content-type") or ""
                mime = "json" if "json" in content_type else "html" if "html" in content_type else "javascript" if "javascript" in content_type else "other"
                route = "dwr" if "/dwr" in parsed.path else "rest" if "/api/" in parsed.path else "content" if "listContent" in parsed.path else "other"
                emit("response", resource=resource, route=route, mime=mime, status=response.status)
            except Exception:
                pass
        context.on("response", response_seen)
        def request_finished(request: object) -> None:
            global _json_records
            try:
                parsed = urlsplit(request.url)
                if parsed.scheme != "https" or parsed.netloc != "bb.cuhk.edu.cn" or request.resource_type not in {"xhr", "fetch"} or _json_records >= 40:
                    return
                response = request.response()
                if response is None or "json" not in (response.header_value("content-type") or ""):
                    return
                _json_records += 1
                raw = response.body()
                if len(raw) > 1_000_000:
                    emit("json-oversize")
                    return
                payload = json.loads(raw)
                fields: set[str] = set()
                dictionaries = arrays = visited = 0
                pending = [(payload, 0)]
                while pending and visited < 200:
                    item, depth = pending.pop()
                    visited += 1
                    if isinstance(item, dict):
                        dictionaries += 1
                        fields.update(key for key in item if key in _FIELD_NAMES)
                        if depth < 4:
                            pending.extend((value, depth + 1) for value in list(item.values())[:30] if isinstance(value, (dict, list)))
                    elif isinstance(item, list):
                        arrays += 1
                        if depth < 4:
                            pending.extend((value, depth + 1) for value in item[:10] if isinstance(value, (dict, list)))
                # A one-way path fingerprint groups endpoints without logging
                # paths, IDs, query parameters, unknown field names or values.
                endpoint = hashlib.sha256(parsed.path.encode()).hexdigest()[:12]
                emit("json-shape", endpoint=endpoint, fields=sorted(fields), dictionaries=dictionaries, arrays=arrays, bytes=len(raw), status=response.status)
            except Exception:
                emit("json-inspection-failed")
        context.on("requestfinished", request_finished)
        _attached.add(id(context))
    except Exception:
        pass


def _parse_summary(source: str, course_id: str) -> dict[str, object]:
    # Imported only during an opt-in probe, after the connector is initialized.
    from classic_connector import ConnectorError, parse_assignments, parse_files
    result: dict[str, object] = {}
    for name, parser in (("assignments", parse_assignments), ("files", parse_files)):
        try:
            values = parser(source, course_id, limit=100, verified_page=False)
            result[name] = len(values)
            if name == "assignments":
                result["assignmentsWithDue"] = sum(bool(value.get("dueAt") or value.get("dueDateOnly")) for value in values)
                result["assignmentsWithSummary"] = sum(bool(value.get("summary")) for value in values)
                result["assignmentAttachments"] = sum(len(value.get("attachments") or []) for value in values)
        except ConnectorError as exc:
            result[name + "Error"] = exc.code
        except Exception:
            result[name + "Error"] = "DIAGNOSTIC_PARSE_FAILED"
    return result


def inspect_page(page: object, rendered: str, *, context: object = None, frame: bool = False) -> None:
    """Compare at most six known read documents using the existing session."""
    if not enabled():
        return
    emit("rendered-frame" if frame else "rendered", **shape(rendered))
    response = None
    try:
        parsed = urlsplit(page.url)
        if parsed.scheme != "https" or parsed.netloc != "bb.cuhk.edu.cn" or parsed.path not in _READ_PATHS:
            return
        course_id = parse_qs(parsed.query).get("course_id", [""])[0]
        if not re.fullmatch(r"_\d+_\d+", course_id):
            return  # Reserve the bounded probe budget for actual course pages.
        ctx = context if context is not None else page.context
        key = (id(ctx), page.url)
        if key in _probed or len(_probed) >= 6:
            return
        _probed.add(key)
        response = ctx.request.get(page.url, timeout=5000, max_redirects=0)
        content_type = response.headers.get("content-type", "")
        if "html" in content_type:
            raw = response.text()
            emit("same-session-frame-html" if frame else "same-session-html", status=response.status, **shape(raw))
            if response.status == 200:
                emit("paired-parser-result", frame=frame, raw=_parse_summary(raw, course_id), rendered=_parse_summary(rendered, course_id))
        else:
            emit("same-session-other", status=response.status)
    except Exception:
        emit("same-session-probe-failed")
    finally:
        if response is not None:
            try:
                response.dispose()
            except Exception:
                pass
