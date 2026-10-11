"""Keep the synchronous Playwright connector on one dedicated thread.

FastMCP 1.x runs synchronous tool functions on the anyio event-loop thread.
Playwright's synchronous API rejects that thread, and its objects must not
move between threads.  The runtime therefore creates the connector lazily in
one single-worker executor and executes every connector method, including
``close()``, on that same worker.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from typing import Any, Callable

from classic_connector import ClassicConnector
import debug_log


class ConnectorRuntime:
    """Async facade over one thread-owned :class:`ClassicConnector`."""

    def __init__(self, factory: Callable[[], ClassicConnector] = ClassicConnector) -> None:
        self._factory = factory
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bb-classic-playwright")
        self._connector: ClassicConnector | None = None
        self._lock = Lock()
        self._closed = False

    def _ensure_connector(self) -> ClassicConnector:
        if self._connector is None:
            self._connector = self._factory()
        return self._connector

    def _invoke(
        self,
        method: str,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        trace_id: str | None,
    ) -> Any:
        # The trace identifier belongs to the worker operation, never to a
        # connector method's business arguments.  ContextVar keeps it on the
        # Playwright-owning thread so navigation callbacks inherit it.
        with debug_log.operation(trace_id, method):
            connector = self._ensure_connector()
            operation = getattr(connector, method)
            return operation(*args, **kwargs)

    async def call(self, method: str, *args: Any, trace_id: str | None = None, **kwargs: Any) -> Any:
        """Run one known connector method without moving its objects."""

        with self._lock:
            if self._closed:
                raise RuntimeError("connector runtime is closed")
        worker_trace = debug_log.normalise_trace_id(trace_id)
        debug_log.emit_for_trace(worker_trace, "worker-queued", operation=method)
        loop = asyncio.get_running_loop()
        future = self._executor.submit(self._invoke, method, args, kwargs, worker_trace)
        return await asyncio.wrap_future(future, loop=loop)

    def _close_worker(self) -> None:
        with debug_log.operation(None, "runtime-close"):
            connector = self._connector
            self._connector = None
            if connector is not None:
                connector.close()

    def close_sync(self) -> None:
        """Close Playwright on its owner thread and then stop the worker."""

        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            self._executor.submit(self._close_worker).result()
        finally:
            self._executor.shutdown(wait=True, cancel_futures=True)


__all__ = ["ConnectorRuntime"]
