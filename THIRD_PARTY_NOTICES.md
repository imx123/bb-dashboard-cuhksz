# Reused open-source components

This application is not affiliated with CUHK, CUHK(SZ), Blackboard, Anthology, Instructure,
OpenAI or any other institution.

## Imported source repositories

- [tayang-cc/CUHK-Blackboard-Dashboard](https://github.com/tayang-cc/CUHK-Blackboard-Dashboard), imported at commit `8530cf56ed5628ac7aa1d0545910dbd68f1343eb`. Its MIT text is retained in the root `LICENSE`.
- [changshenhan/bb-mcp](https://github.com/changshenhan/bb-mcp), commit `1a2ea2625ea87f42e4597347813c44291e6c2553`, read as a reference implementation for the CUHK(SZ) Classic navigation. The adapted Python sidecar was retired and removed from this repository on 2026-11-01; no bb-mcp source is distributed with this project. Its MIT notice is reproduced under [Reference-only code](#reference-only-code-removed).

The imported source files remain attributable to their upstream projects. The CUHK(SZ)
Classic adapter and synthetic fixtures are local additions and do not imply institution
endorsement. Keep the root `LICENSE` when copying the Dashboard, and keep the bb-mcp notice
below while this project still describes work derived from that reference.

## Names and brand assets

The neutral lms-cli book/terminal icon (`assets/lms-icon.svg` and its rendered PNG copies) is an original project asset under the MIT license. Version 0.3.0 no longer distributes the PolyU emblem as its app/plugin icon. School names, including the optional PolyU preset, and the Canvas, Blackboard and Codex names remain the property of their respective rights holders. Their mention does not imply sponsorship, approval or permission to reuse third-party marks. Historical releases retain their original notices.

## Vendored LMS connectors (MIT)

- [xmike04/canvas-student-mcp](https://github.com/xmike04/canvas-student-mcp), v1.3.3, commit `d35bb973c82604f6f16414709b926b892a42558f`. Original license: `vendor/canvas/LICENSE`.
- [felipedias-ie/blackboard-mcp](https://github.com/felipedias-ie/blackboard-mcp), v0.6.0, commit `73fb032e14d3fecce396a5a0bf59404ca62dbe29`. Original license: `vendor/blackboard/LICENSE`.

Sources are pinned in `vendor/`, compiled with the application, and not fetched from a moving branch at runtime. These are community connectors, not institution-certified integrations or a claim of universal maturity. Canvas uses its REST endpoints. Blackboard uses Learn Ultra's internal endpoints, which may change without notice.

Local patches inherited from the earlier deployment: HTTPS / URL-credential rejection, Canvas same-origin pagination and credential isolation on download redirects, HTTP timeouts, bounded Blackboard redirects, explicit read-only environment override, configurable Canvas Keychain service.

Additional patches in this distribution: longer Canvas announcement bodies with update timestamps/source links; preservation of Canvas login User-Agent; chunked Canvas calendar contexts (no silent ten-course cutoff); Blackboard announcement IDs/course source links and bounded-coverage notices; explicit ISO/UTC timestamps. All other endpoint mappings, pagination helpers, parsers and LMS tools are reused. The adapter redirects credential loading/persistence to our cross-platform vault and uses a reviewed read-only tool allowlist. Upstream browser-import/login and raw/write tools are never exposed by the LMS CLI.

## Other dependencies

The official Model Context Protocol TypeScript SDK supplies client/server transports and schemas. Electron and electron-builder supply the authorization app and installers. `@napi-rs/keyring` / keyring-rs supply system credential storage. Commander supplies CLI parsing, Ajv schema validation, Zod data validation, proper-lockfile local write coordination, tough-cookie cookie jars, unpdf document extraction, and ical-generator standards-based calendar serialization.

Exact versions and transitive packages are recorded in `package-lock.json`. Their respective licenses are included by their packages. Electron binaries include Chromium and its notices. Preserve these files when redistributing installers or npm packages.

## Reference-only code (removed)

`sidecar/bb-mcp/` — the adapted Python Classic sidecar (15 tracked source files, a local
`requirements.lock` and virtual environment) — was removed on 2026-11-01, after the
TypeScript JSON API replaced it in the production read path. The direct versions tested
while it existed were `mcp==1.30.0` and `playwright==1.63.0`, with `pydantic`, `httpx`,
`cryptography` and `pywin32` among the transitive packages. None of them is a dependency of
the shipped application, and Playwright browser binaries are no longer part of the delivery.
The upstream MIT notice is reproduced in full:

```
MIT License

Copyright (c) 2026 changshenhan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
