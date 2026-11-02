# Rehearsal: Hertz Studio UI refinement

Date: 2026-11-02

## Brief and references

The user approved refining button shapes, layout and stage controls, while
preserving Orbit's intentional embossed appearance. Classic, Liunian, Qingfeng
and Heijiao retain their navigation, player and content identities. Orbit's
`skin.orbit.css` and `skin.orbit.js` have no diff. Shared stage and workshop
inspectors are refined independently of the skin surfaces.

Gold references: Stageshow `dark-hero` and `dark-bento`, captured as
`gold-dark-hero.png` and `gold-dark-bento.png`. Kept the hierarchy of surfaces,
restrained borders, readable controls, music artwork and one clear focal panel.
The real application has a full library and parameter schema, so its density
and content remain those of a working music application. No illustration kit,
placeholder records or scripted cursor was added to the runtime.

This is a real UI refinement, not a Stageshow illustration or animation. The
Stageshow film gate was not run and is not claimed to pass. Visual review used
actual browser screenshots and interactive regression checks.

## Changes reviewed in frames

| Area | Finding and resulting change | Current evidence |
| --- | --- | --- |
| Browsing skins | Inconsistent action shapes and insets. Use 36px desktop / 40px mobile general actions with 8px corners, aligned tools, clearer content surfaces and one search field outline. Circular transport controls and Qingfeng's signature capsules remain. | `final-classic.png`, `final-liunian.png`, `final-qingfeng.png`, `final-heijiao.png` |
| Narrow content headers | Titles were compressed beside tool groups; Liunian player actions could orphan button text. Stack titles above wrapping filters and put player actions on their own row. | `final-classic-390.png`, `mobile-liunian-320.png`, `narrow-toolbar/` |
| Narrow toolbars | Heijiao at 320px had 2px of horizontal overflow. Allow the existing secondary player controls to wrap within the available width. | `narrow-toolbar-source.log` |
| Qingfeng settings | The mobile dialog's outer box fitted, but its desktop inner flex layout crushed navigation and content into narrow strips. Stack the layout, scroll category links horizontally and retain a full-width pane. Actual category clicks pass at 390 and 320px. | `final-settings-qingfeng-390.png`, `final-settings-qingfeng-320.png` |
| Stage inspector | Dense nested boxes, small labels and ambiguous dot toggles. Use a 420px inspector, clear header/search/sections, aligned readouts and visible switch tracks. Scene presets use two columns so long labels fit; narrow slider groups use one column. Footer actions stay visible. | `before-stage-control.png`, `final-stage-control.png`, `final-stage-control-320.png`, `final-stage-control-light-320.png` |
| Real 3D controls | The same inspector must remain above the actual immersive scene and reflect the active context. | `final-stage-control-3d.png` |
| Scene settings and space console | Small field geometry, weak headings and a panel that moved when hovered. Increase readable field sizes and insets, clarify tabs, retain a sticky settings heading and keep the open panel stationary. | `final-scene-settings.png`, `final-scene-settings-320.png`, `final-space-console.png`, `final-space-display-390.png` |
| Workshop light theme | The permanently dark workshop inherited dark text from light themes. Keep its existing green-gray palette local to the panel, with readable labels, tabs and fields. | `workshop-light-review.png` |
| Workshop switches | Existing switches rendered as a 351×6px gray line without a thumb; enabled switches also showed a forbidden cursor. Add a local 44×32px control with a track/thumb and apply the disabled cursor only when disabled. Related selects fill the pane with consistent field geometry. | `final-workshop-switch-ios-light-390.png`, `final-workshop-switch-mineral-1440.png` |
| Settings / empty library | Confirm real empty-library states and all four settings entry/close paths. Heijiao's hover navigation is opened with keyboard focus and Enter in the probe. | `final-empty-{skin}-390.png`, `final-settings-{skin}-390.png`, `finish-smoke.log` |

All filenames above are relative to
`output/playwright/ui-refinement/`. The screenshots, isolated fixtures and
one-off probes are local ignored review artifacts, not application assets.

## Captured sizes and states

- Desktop: 1440×960, plus a 1280×720 short desktop for the inspector footer.
- Tablet: 768×1024 for the inspector and its fixed actions.
- Mobile: 390×844 and 320×844 for the four skins, settings, stage controls and
  scene settings. Toolbar interaction checks also cover widths 330, 620, 621
  and 700.
- Themes: Mineral and iOS Light for inspector/workshop checks; all 23 themes
  across the four skins in the desktop theme matrix.
- Data: an isolated backend with eight tagged WAV files and existing artwork,
  and a separate genuinely empty library. Playback is paused with null output;
  no UI playback state is fabricated.
- Interactions: real entry buttons, skin switching, settings categories,
  toolbar menus/search, switches, slider drags, keyboard actions, undo,
  persistence failures/recovery and reduced motion.

## Verification

| Check | Actual result | Evidence |
| --- | --- | --- |
| `check-skins.js` | 669/669 passed. The existing Liunian shape assertion now expects the approved 8px corners and retains the nowrap requirement. | `frontend-final.log` and direct rerun |
| `check-css-tokens.js` | Passed after the final workshop change: 21 files, 5,153 rules, 45 checked declarations. | Final direct run |
| `check-creative.js` | 465/465 passed after the final workshop change. | Final direct run |
| `check-stage-control-browser.js` | All 27 scenarios passed, including search, parameter edits, keyboard transactions, undo, history bounds, persistence recovery, two themes, narrow screens and no uncaught page exceptions. | `stage-control-final.log` |
| `check-skin-matrix-browser.js` against source assets | 92 desktop theme × skin combinations passed. Later mobile-only fixes were verified separately. | `skin-matrix-source.log` |
| `check-heijiao-browser.js` against source assets | All 86 checks passed, including turntable drag, queue modes, geometry, lifecycle and reduced motion. | `heijiao-source.log` |
| `check-narrow-topbar-browser.js` against source assets, four affected skins | 28 skin/width combinations, zero failures. Includes actual clickability, menu chains and search. | `narrow-toolbar-source.log` |
| Final screen capture/layout probe | 23 layout checks passed, including genuine 3D context, scene settings, space console, mobile and light controls. No uncaught page exceptions. | `final-capture.log`, `final-capture-report.json` |
| Empty/settings/short-screen probe | 12 checks passed, including actual Qingfeng category changes at 390/320px and reachable inspector actions. No uncaught page exceptions. | `finish-smoke.log` |
| Workshop switch probe | 12 cases passed: two real switches × two themes × three widths. Keyboard changes write to actual Stage3D preferences and can be restored. Reduced-motion check passed; no uncaught page exceptions. | `workshop-switch.log` |
| `git diff --check` | Passed for the refinement files. | Final direct run |

The fixture executable embeds older frontend assets. Source-based checks serve
the saved CSS/JS/HTML over a real loopback HTTP/WebSocket proxy while the
isolated backend supplies the APIs. The product bundle has not been rebuilt.

## Existing failures and fixture limits

- `check-frontend.js`: 65 steps passed, two failed. `check-scripts.js` reported
  unregistered wallpaper checks (`check-wallpaper-import-native.js`,
  `check-wallpaper-media-native.js`, `check-wallpaper-runtime.js`).
  `check-adrs.js` reported ADR 0012's missing `MESSAGE_LIMIT` reference and
  `SCHEMA_VERSION` 4 versus source 5 in desktop IPC. These concern independent
  workspace changes; this UI refinement does not alter them. Exact captured
  output is in `frontend-final.log`.
- `check-settings-sheet-browser.js`: 47/50 passed. Three assertions expect 18
  settings groups; the current application contains 19, including “AI 与外部连接”.
  Open/close, category switching, scroll isolation, lifecycle cleanup and the
  no-page-exception checks passed. See `settings-source.log`.
- `check-stage-control-3d-browser.js`: all five functional scenarios passed,
  including actual switch/slider writeback and context changes. Its final
  console-clean assertion fails because the isolated fixture has no desktop
  companion and `/v1/desktop/control` returns 503. This script is not reported
  as fully passing. See `stage-3d-source.log`.
- Some preview captures also record `/v1/home/quote` returning 504 from its
  upstream service. The captured layout probe has no uncaught JS exceptions;
  service errors are retained in `final-capture-report.json`.

## Assumptions and not checked

- The user's existing navigation, skin-specific artwork and Orbit embossing
  are intentional. The refinement preserves those choices.
- These screenshots cover Chrome on Windows and emulated narrow viewports;
  physical mobile devices, Safari and Firefox were not checked.
- Null output fixtures validate UI behavior, not audio fidelity, hardware
  output devices or a native desktop companion.
- No full Stageshow loop/contact sheet, cursor choreography or film gate was
  produced for this working application. Review is based on the listed frames
  and browser interactions.
- The installed/packaged Rust executable has not been rebuilt to embed the new
  assets. Rebuilding the application is needed for the packaged UI to show
  these source changes. No unrelated workspace changes were reverted or
  committed as part of this refinement.
