"""Passive, bounded diagnostics for the Classic sidecar.

The logger is deliberately independent from the MCP protocol stream.  It
records operation timing, bounded structure counts, navigation metadata and
stable resource identifiers, while refusing page text, response bodies,
headers, cookies and credential material.  Logging failures are swallowed so
that a full or unwritable log never changes a read result.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from threading import RLock
from typing import Any, Iterator, Mapping
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit


_TRACE = ContextVar("bb_classic_debug_trace", default=None)
_LOCK = RLock()
_ATTACHED_CONTEXTS: set[int] = set()
_WRITE_FAILURE_REPORTED = False

_MAX_BYTES = 2 * 1024 * 1024
_MAX_BACKUPS = 2
_MAX_EVENT_BYTES = 32 * 1024
_TRACE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
_FIELD_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_ERROR_TYPE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]{0,79}$")
_STABLE_ID_RE = re.compile(
    r"^(?:_[0-9]{1,24}_[0-9]{1,24}|[0-9]{1,32}|(?:assignment|announcement|file|course):_[0-9]{1,24}_1:[a-f0-9]{20})$",
    re.I,
)
_SAFE_NAV_ENUMS = {
    "action": {"default", "display", "list", "load", "login", "logout", "open", "refresh", "relogin", "show", "view"},
    "mode": {"content", "course", "default", "display", "list", "portal", "read", "view"},
}
_SENSITIVE_QUERY_RE = re.compile(
    r"(?:token|ticket|code|saml|relay|state|session|jsession|cookie|auth|password|secret|signature|assertion|credential|nonce|key)",
    re.I,
)
_SENSITIVE_FIELD_RE = re.compile(
    r"(?:body|html|raw|cookie|header|token|ticket|password|secret|credential|authorization|payload|stack|profile|user.?data|exception|message)",
    re.I,
)
_URL_FIELDS = {"url", "target", "landing", "pageUrl", "pageURL", "href", "pathUrl"}
_PATH_FIELDS = {"paths", "routes"}
_ID_FIELDS = {
    "courseId",
    "course_id",
    "contentId",
    "content_id",
    "assignmentId",
    "assignment_id",
    "assessmentId",
    "assessment_id",
    "itemId",
    "item_id",
    "resourceId",
    "resource_id",
    "id",
}
_NUMERIC_FIELDS = {
    "status",
    "count",
    "pagesRead",
    "maxPages",
    "deadlineMs",
    "elapsedMs",
    "attempt",
    "frameCount",
    "documentCount",
    "menuRoots",
    "menuCandidates",
    "supportedCandidates",
    "accepted",
    "attempts",
    "chars",
    "iframes",
    "forms",
    "contentLinks",
    "assignmentMarkers",
    "fileMarkers",
    "loginMarkers",
    "dictionaries",
    "arrays",
    "bytes",
    "jsonRecords",
    "courseLinkCount",
    "courses",
    "announcements",
    "assignments",
    "files",
    "errors",
}
_BOOL_FIELDS = {"authenticated", "marker", "sessionExpired", "portalCandidate", "external"}
_ALLOWED_FIELDS = {
    "scope",
    "step",
    "operation",
    "phase",
    "code",
    "errorType",
    "status",
    "resource",
    "resourceType",
    "mime",
    "route",
    "target",
    "landing",
    "url",
    "pageUrl",
    "pageURL",
    "href",
    "pathUrl",
    "paths",
    "routes",
    "courseId",
    "course_id",
    "contentId",
    "content_id",
    "assignmentId",
    "assignment_id",
    "assessmentId",
    "assessment_id",
    "itemId",
    "item_id",
    "resourceId",
    "resource_id",
    "id",
    "count",
    "pagesRead",
    "maxPages",
    "deadlineMs",
    "elapsedMs",
    "attempt",
    "frameCount",
    "documentCount",
    "menuRoots",
    "menuCandidates",
    "supportedCandidates",
    "accepted",
    "filtered",
    "attempts",
    "chars",
    "iframes",
    "forms",
    "contentLinks",
    "assignmentMarkers",
    "fileMarkers",
    "loginMarkers",
    "fields",
    "dictionaries",
    "arrays",
    "bytes",
    "jsonRecords",
    "authenticated",
    "courseLinkCount",
    "marker",
    "sessionExpired",
    "portalCandidate",
    "external",
    "courses",
    "announcements",
    "assignments",
    "files",
    "errors",
}


def enabled() -> bool:
    """Return whether passive logging is enabled (enabled by default)."""

    raw = os.environ.get("BB_DEBUG_LOG", os.environ.get("BB_DEBUG_LOG_ENABLED", "1"))
    return raw.strip().casefold() not in {"0", "false", "off", "no"}


def current_trace_id() -> str | None:
    value = _TRACE.get()
    return value if isinstance(value, str) and value else None


def new_trace_id() -> str:
    return uuid.uuid4().hex


def normalise_trace_id(value: object) -> str:
    if isinstance(value, str):
        candidate = value.strip()
        if _TRACE_RE.fullmatch(candidate):
            return candidate
    return new_trace_id()


def _log_directory() -> Path:
    configured = os.environ.get("BB_DEBUG_LOG_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    lms_home = os.environ.get("LMS_HOME", "").strip()
    if lms_home:
        return Path(lms_home).expanduser() / "logs"
    return Path(__file__).resolve().parents[2] / ".work" / "logs"


def log_path() -> Path:
    """Return the configured path without creating directories or logging it."""

    return _log_directory() / "sidecar-debug.jsonl"


def _safe_path(path: str, *, external: bool = False) -> str:
    value = path or "/"
    value = re.sub(r";(?:(?:jsessionid|sessionid)=[^/;]*)", ";<redacted>", value, flags=re.I)
    parts: list[str] = []
    for part in value.split("/"):
        if len(part) > 160 or re.match(r"(?:token|ticket|assertion|saml|relaystate|sessionid|jsessionid)=", part, re.I):
            parts.append("<redacted>")
        elif external and re.fullmatch(r"[A-Za-z0-9+/_=-]{40,}", part):
            parts.append("<redacted>")
        else:
            parts.append(part)
    return "/".join(parts)[:640] or "/"


def safe_url(value: object) -> str | None:
    """Return a locator-safe copy of a URL without changing the real URL."""

    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = urlsplit(value.strip())
        if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
            return None
        host = parsed.hostname.rstrip(".").casefold()
        if parsed.username or parsed.password:
            return f"{parsed.scheme.casefold()}://{host}/<redacted>"
        try:
            port = parsed.port
        except ValueError:
            return f"{parsed.scheme.casefold()}://{host}/<redacted>"
        netloc = host
        if port not in (None, 80 if parsed.scheme.casefold() == "http" else 443):
            netloc = f"{host}:{port}"
        query: list[tuple[str, str]] = []
        try:
            query_pairs = parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=80)
        except ValueError:
            # Preserve the route while avoiding unbounded query material.
            query_pairs = []
            if parsed.query:
                query.append(("<redacted-query>", "<redacted>"))
        for key, raw_value in query_pairs:
            clean_key = re.sub(r"[^A-Za-z0-9_.:-]", "_", key)[:80] or "<redacted-key>"
            if clean_key.casefold() in {"course_id", "courseid", "content_id", "contentid", "assessment_id", "assessmentid", "assignment_id", "assignmentid", "item_id", "itemid", "cmp_tab_id", "id"} and _STABLE_ID_RE.fullmatch(raw_value):
                clean_value = raw_value
            elif clean_key.casefold() == "tab_tab_group_id" and re.fullmatch(r"_[0-9]{1,4}_[0-9]{1,4}", raw_value):
                clean_value = raw_value
            elif raw_value.casefold() in _SAFE_NAV_ENUMS.get(clean_key.casefold(), set()):
                clean_value = raw_value
            elif _SENSITIVE_QUERY_RE.search(clean_key) or _SENSITIVE_QUERY_RE.search(raw_value):
                clean_value = "<redacted>"
            elif re.fullmatch(r"[0-9]{1,32}", raw_value) and clean_key.casefold() in {"page", "offset", "limit"}:
                clean_value = raw_value
            else:
                clean_value = "<redacted>"
            query.append((clean_key, clean_value))
        return urlunsplit((parsed.scheme.casefold(), netloc, _safe_path(parsed.path, external=host != "bb.cuhk.edu.cn"), "&".join(f"{quote(k, safe='._:-')}={quote(v, safe='<>._:-')}" for k, v in query), ""))[:900]
    except Exception:
        return None


def _safe_text(value: object, *, limit: int = 160) -> str | None:
    if not isinstance(value, (str, int, float, bool)):
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value).strip()
    if not text:
        return None
    if any(ord(char) < 32 for char in text):
        return None
    return text[:limit]


def _safe_id(value: object) -> str | None:
    text = _safe_text(value, limit=96)
    if text is None:
        return None
    return text if _STABLE_ID_RE.fullmatch(text) else "<redacted>"


def _safe_field(key: str, value: object, *, depth: int = 0) -> object | None:
    if depth > 2 or _SENSITIVE_FIELD_RE.search(key):
        return None
    if key in _URL_FIELDS:
        return safe_url(value)
    if key in _PATH_FIELDS:
        if isinstance(value, (list, tuple)):
            return [safe_url(item) for item in list(value)[:40] if safe_url(item)]
        return None
    if key in _ID_FIELDS:
        return _safe_id(value)
    if key in _BOOL_FIELDS:
        return value if isinstance(value, bool) else None
    if key in _NUMERIC_FIELDS:
        if isinstance(value, bool):
            return None
        try:
            number = int(value)
        except Exception:
            return None
        return max(-1_000_000, min(1_000_000_000, number))
    if key == "errorType":
        text = _safe_text(value, limit=96)
        return text if text and _ERROR_TYPE_RE.fullmatch(text) else "UnknownError"
    if key in {"scope", "step", "operation", "phase", "code", "resource", "resourceType", "mime", "route"}:
        text = _safe_text(value, limit=200)
        return text if text and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,200}", text) else "<redacted>"
    if key in {"filtered"} and isinstance(value, Mapping):
        output: dict[str, int] = {}
        for item_key, item_value in list(value.items())[:80]:
            clean_key = _safe_text(item_key, limit=80)
            try:
                number = max(0, min(100000, int(item_value)))
            except Exception:
                continue
            if clean_key:
                output[clean_key] = number
        return output
    if key == "fields" and isinstance(value, (list, tuple, set)):
        return [item for item in (_safe_text(item, limit=80) for item in list(value)[:80]) if item and _FIELD_RE.fullmatch(item)]
    if isinstance(value, Mapping):
        output: dict[str, object] = {}
        for item_key, item_value in list(value.items())[:40]:
            clean_key = _safe_text(item_key, limit=80)
            if clean_key is None or _SENSITIVE_FIELD_RE.search(clean_key):
                continue
            clean_value = _safe_field(clean_key, item_value, depth=depth + 1)
            if clean_value is not None:
                output[clean_key] = clean_value
        return output
    if isinstance(value, (list, tuple, set)):
        return [clean for item in list(value)[:40] if (clean := _safe_field(key, item, depth=depth + 1)) is not None]
    return _safe_text(value, limit=240)


def _rotate_if_needed(target: Path, incoming: int) -> None:
    try:
        if not target.exists() or target.stat().st_size + incoming <= _MAX_BYTES:
            return
        for index in range(_MAX_BACKUPS, 0, -1):
            source = target.with_name(f"{target.name}.{index}")
            destination = target.with_name(f"{target.name}.{index + 1}")
            if index == _MAX_BACKUPS:
                try:
                    source.unlink()
                except FileNotFoundError:
                    pass
            elif source.exists():
                os.replace(source, destination)
        os.replace(target, target.with_name(f"{target.name}.1"))
    except Exception:
        # A full log must never interfere with a read.
        return


def emit(event: str, **fields: object) -> None:
    """Append one redacted event; all I/O and serialization failures vanish."""

    if not enabled():
        return
    global _WRITE_FAILURE_REPORTED
    try:
        clean_event = re.sub(r"[^A-Za-z0-9_.:-]", "_", str(event))[:80] or "event"
        record: dict[str, object] = {
            "ts": int(time.time() * 1000),
            "traceId": current_trace_id() or "unscoped",
            "event": clean_event,
        }
        for key, value in fields.items():
            if key not in _ALLOWED_FIELDS and key not in _URL_FIELDS and key not in _PATH_FIELDS:
                continue
            if _SENSITIVE_FIELD_RE.search(key):
                continue
            clean = _safe_field(key, value)
            if clean is not None:
                record[key] = clean
        encoded = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        if len(encoded) > _MAX_EVENT_BYTES:
            # Keep structure and timing while dropping potentially large maps.
            for key in ("filtered", "fields", "paths", "routes"):
                record.pop(key, None)
            encoded = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        target = log_path()
        with _LOCK:
            target.parent.mkdir(parents=True, exist_ok=True)
            _rotate_if_needed(target, len(encoded))
            with target.open("ab") as stream:
                stream.write(encoded)
    except Exception:
        # Keep the MCP stdout protocol and the business result untouched, but
        # give the host one fixed, path-free signal that the local log sink is
        # unavailable.  The host may surface this as a diagnostic warning;
        # never include the filesystem path or exception text here.
        if not _WRITE_FAILURE_REPORTED:
            try:
                with _LOCK:
                    if not _WRITE_FAILURE_REPORTED:
                        sys.stderr.write("BB_DEBUG_LOG_WRITE_FAILED\n")
                        sys.stderr.flush()
                        _WRITE_FAILURE_REPORTED = True
            except Exception:
                pass


def emit_for_trace(trace_id: object, event: str, **fields: object) -> None:
    """Emit one event on a caller thread while preserving the worker trace."""

    token = _TRACE.set(normalise_trace_id(trace_id))
    try:
        emit(event, **fields)
    finally:
        _TRACE.reset(token)


def emit_error(event: str, *, code: object = None, scope: object = None, exc: BaseException | None = None, **fields: object) -> None:
    safe_fields = dict(fields)
    if code is not None:
        safe_fields["code"] = code
    if scope is not None:
        safe_fields["scope"] = scope
    if exc is not None:
        safe_fields["errorType"] = exc.__class__.__name__
    emit(event, **safe_fields)


def emit_navigation_start(target: object, *, scope: object = None, step: object = None) -> None:
    emit("navigation-start", target=target, scope=scope, step=step)


def emit_navigation_end(target: object, landing: object, *, scope: object = None, step: object = None, status: object = None, elapsed_ms: object = None, code: object = None) -> None:
    emit("navigation-end", target=target, landing=landing, scope=scope, step=step, status=status, elapsedMs=elapsed_ms, code=code)


def emit_sidebar(*, frame_count: int, document_count: int, menu_roots: int, menu_candidates: int, supported_candidates: int, accepted: int, filtered: Mapping[str, int], paths: list[object], attempts: int, scope: object = None) -> None:
    try:
        emit(
            "sidebar",
            scope=scope,
            frameCount=max(0, int(frame_count)),
            documentCount=max(0, int(document_count)),
            menuRoots=max(0, int(menu_roots)),
            menuCandidates=max(0, int(menu_candidates)),
            supportedCandidates=max(0, int(supported_candidates)),
            accepted=max(0, int(accepted)),
            filtered=dict(filtered),
            paths=paths,
            attempts=max(0, int(attempts)),
        )
    except Exception:
        pass


def emit_detail(*, scope: object, course_id: object, assignment_id: object, pages_read: int, max_pages: int, deadline_ms: object = None, landing: object = None, code: object = None, elapsed_ms: object = None) -> None:
    try:
        emit(
            "assignment-detail",
            scope=scope,
            courseId=course_id,
            assignmentId=assignment_id,
            pagesRead=max(0, int(pages_read)),
            maxPages=max(0, int(max_pages)),
            deadlineMs=deadline_ms,
            landing=landing,
            code=code,
            elapsedMs=elapsed_ms,
        )
    except Exception:
        pass


@contextmanager
def operation(trace_id: object = None, name: str = "connector") -> Iterator[str]:
    trace = normalise_trace_id(trace_id)
    token = _TRACE.set(trace)
    started = time.monotonic()
    emit("operation-start", operation=name)
    try:
        yield trace
    except BaseException as exc:
        emit_error(
            "operation-error",
            code=getattr(exc, "code", None),
            scope=getattr(exc, "scope", name),
            exc=exc,
            operation=name,
            elapsedMs=int(max(0.0, time.monotonic() - started) * 1000),
        )
        raise
    else:
        emit("operation-end", operation=name, elapsedMs=int(max(0.0, time.monotonic() - started) * 1000))
    finally:
        _TRACE.reset(token)


def _response_status(response: object) -> int | None:
    try:
        status = int(getattr(response, "status"))
        return status if 100 <= status <= 599 else None
    except Exception:
        return None


def response_status(response: object) -> int | None:
    """Read a bounded status value without letting diagnostics raise."""

    return _response_status(response)


def object_url(value: object) -> str | None:
    """Read a Playwright-like object's URL without propagating diagnostics errors."""

    try:
        result = getattr(value, "url", None)
        return result if isinstance(result, str) else None
    except Exception:
        return None


def attach_context(context: object) -> None:
    """Attach passive Playwright listeners without reading bodies or headers."""

    if not enabled() or context is None or id(context) in _ATTACHED_CONTEXTS:
        return
    context_id = id(context)
    try:
        def response_seen(response: object) -> None:
            try:
                request = getattr(response, "request", None)
                resource = getattr(request, "resource_type", None) or "unknown"
                if resource not in {"document", "xhr", "fetch"}:
                    return
                status = _response_status(response)
                emit(
                    "response",
                    url=getattr(response, "url", None),
                    resourceType=resource,
                    status=status,
                    code=f"HTTP_{status}" if status in {401, 403} else None,
                )
            except Exception:
                pass

        def request_finished(request: object) -> None:
            try:
                resource = getattr(request, "resource_type", None) or "unknown"
                if resource not in {"document", "xhr", "fetch"}:
                    return
                response = request.response()
                emit(
                    "request-finished",
                    url=getattr(request, "url", None),
                    resourceType=resource,
                    status=_response_status(response) if response is not None else None,
                )
            except Exception:
                pass

        def request_failed(request: object) -> None:
            try:
                resource = getattr(request, "resource_type", None) or "unknown"
                if resource not in {"document", "xhr", "fetch"}:
                    return
                emit(
                    "request-failed",
                    url=getattr(request, "url", None),
                    resourceType=resource,
                    code="REQUEST_FAILED",
                )
            except Exception:
                pass

        def context_closed(_closed_context: object = None) -> None:
            try:
                _ATTACHED_CONTEXTS.discard(context_id)
                emit("context-closed")
            except Exception:
                pass

        context.on("response", response_seen)
        context.on("requestfinished", request_finished)
        context.on("requestfailed", request_failed)
        context.on("close", context_closed)
        _ATTACHED_CONTEXTS.add(id(context))
        emit("context-listeners-attached")
    except Exception:
        pass


__all__ = [
    "attach_context",
    "current_trace_id",
    "emit",
    "emit_for_trace",
    "emit_detail",
    "emit_error",
    "emit_navigation_end",
    "emit_navigation_start",
    "emit_sidebar",
    "enabled",
    "log_path",
    "new_trace_id",
    "normalise_trace_id",
    "operation",
    "object_url",
    "response_status",
    "safe_url",
]
