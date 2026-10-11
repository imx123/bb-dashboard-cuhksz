"""Start a local Chromium context and verify connector shutdown closes it.

This test opens only ``about:blank`` with a temporary profile.  It never visits
Blackboard and never performs account authentication.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from classic_connector import ClassicConnector, ConnectorConfig, ManualAuthProvider


HERE = Path(__file__).resolve().parent


def main() -> None:
    # Use the project workspace rather than the sandbox's protected Windows
    # temp root; this directory is ignored and is writable by the sidecar.
    with tempfile.TemporaryDirectory(prefix=".browser-cleanup-", dir=HERE) as root:
        config = ConnectorConfig(
            base_url="https://bb.cuhk.edu.cn",
            user_data_dir=Path(root) / "profile",
            retries=0,
        )
        connector = ClassicConnector(config)
        page = None
        try:
            auth = connector.auth
            if not isinstance(auth, ManualAuthProvider):
                raise AssertionError("the default connector auth provider is not ManualAuthProvider")
            context = auth._ensure_browser(connector)
            page = context.new_page()
            page.goto("about:blank")
            connector.close()
            if not page.is_closed():
                raise AssertionError("browser page remained open after connector.close()")
        finally:
            connector.close()
    print("browser cleanup ok")


if __name__ == "__main__":
    main()
