# Phase 5 Dashboard Mockup Audit

Date: 2026-08-05

## Scope

The audited source is `temp/Luwi Runtime Dashboard Mockup`. It is a visual reference only.
Neither generated HTML variant nor its runtime support bundle is production code or evidence
that a LUWI capability exists.

Inspected files:

- `Luwi Runtime.dc.html` and `Luwi Runtime - Mono.dc.html`;
- `support.js`;
- `_ds/.../_ds_bundle.js`, `_ds_manifest.json`, `_adherence.oxlintrc.json`, `styles.css`, and
  `readme.md`;
- `assets/luwi-mark-white.png`, the screenshot strip, and four uploaded reference images.

## Accepted visual language

The production dashboard may reuse the ideas, not the generated implementation:

- graphite background `#08080d`, three restrained surface elevations, thin translucent
  borders, 4–8 px radii, compact 4 px spacing rhythm;
- a 216–224 px text-first navigation rail;
- dense operational rows rather than generic KPI cards;
- system sans fonts with local fallbacks and a system monospace stack for identifiers;
- indigo selection, green success, amber warning, red failure, grey unknown;
- labelled confidence and context-state chips that never rely on color alone;
- one compact runtime status area and one restrained pulse animation with reduced-motion
  support.

The normalized production tokens will live in `apps/dashboard/src/styles/tokens.css`.

## Patterns to reimplement

- shell, navigation, command-bar shell, operational strip, tables, status chips, empty states,
  and degraded-state banners must be authored as typed React components;
- responsive layout must use CSS grid/minmax rather than the mockup's fixed inline widths;
- command palette markup is not copied because unified search does not exist;
- generated `sc-if`, `sc-for`, inline style strings, event handlers, and embedded static data
  are not accepted production patterns.

`support.js` dynamically loads React/Babel from `unpkg.com`, uses `innerHTML`, and posts
wildcard messages to a parent window. It is rejected in full. Production has no CDN,
runtime compiler, wildcard `postMessage`, or generated design-canvas runtime.

## Data and capability classification

| Visible feature                            | Class     | Reason                                                                                            |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------- |
| Runtime/Redis status, uptime, latency      | SUPPORTED | `/health` and `/api/v1/runtime` expose validated fields.                                          |
| Projects and active-session counts         | SUPPORTED | Project/session collections and presence make this a safe join.                                   |
| Agent definitions and project bindings     | SUPPORTED | Phase 3 read endpoints exist.                                                                     |
| Recent activity                            | SUPPORTED | Bounded normalized event list exists.                                                             |
| Usage source composition                   | SUPPORTED | Global usage summary preserves source distinctions.                                               |
| Context contribution states                | SUPPORTED | Bounded contribution list preserves assigned/effective/loaded/invoked/unknown.                    |
| Git/package/technology summaries           | DERIVABLE | Project-scoped endpoints exist; not required in the first Pulse viewport.                         |
| Operational graph summary                  | PLANNED   | Was true at this audit date: only rooted graph queries existed. ADR 0013 later added the summary. |
| Optimization finding count                 | SUPPORTED | Bounded read-only finding collection exists.                                                      |
| WebSocket connectivity indicator           | SUPPORTED | Transport exists; Phase 5A observes connection only and applies no events.                        |
| Project lifecycle stage/release readiness  | PLANNED   | No lifecycle or release-scoring domain exists.                                                    |
| Task/path/file leases                      | PLANNED   | No implemented Phase 1–4 transition or public API exists.                                         |
| Unified project/session/commit/file search | PLANNED   | No unified search endpoint exists.                                                                |
| GitHub status                              | REJECTED  | GitHub integration is outside Phase 5A and current product boundary.                              |
| Dashboard ConfigPlan apply/graph rebuild   | REJECTED  | Phase 5A is read-only; mutation surfaces are forbidden.                                           |
| Mock waiting/blocked/event-rate totals     | REJECTED  | Values are static and not all are safely derivable from current endpoints.                        |

## Accessibility and layout corrections

- metadata below 11 px is raised to at least 12 px;
- visible `:focus-visible` rings are mandatory;
- status always includes text, not only a colored dot;
- landmark elements, a skip link, semantic tables, headings, and `aria-current` are used;
- page-level horizontal overflow is forbidden at 1280, 1440, and 1728 px;
- the shell owns scrolling; nested table panels avoid independent scrollbars;
- contextual secondary panels move below the primary panel below 1400 px;
- long paths use middle abbreviation plus an accessible full-value title;
- reduced-motion disables pulse animation.

## Security review

- no mock support scripts, remote fonts, CDN scripts, analytics, or external assets;
- no direct Redis access and no Redis URL rendering;
- frontend fetches same-origin loopback daemon endpoints only;
- unknown response values are rendered as `Unknown`, never inserted as HTML;
- no mutation buttons or unsafe retry loop;
- retained snapshots are in-memory only and contain validated daemon responses.

## Assets

Only `assets/luwi-mark-white.png` is LUWI-owned and potentially reusable. Phase 5A uses a
text/CSS identity mark, so no binary asset is copied in this slice. Screenshot and uploaded
images remain audit evidence and are not copied. If the logo is later required, its exact
destination is `apps/dashboard/public/assets/luwi-mark-white.png` and the copy must be
recorded in the implementation report.
