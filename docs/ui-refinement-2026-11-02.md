# Hertz Studio UI refinement

The work covers Classic, Liunian, Qingfeng and Heijiao, together with stage
controls, scene settings and the creative workshop. Orbit's embossed surfaces are intentional and its
skin files must remain unchanged. The user confirmed that button geometry,
layout and stage controls are the priorities.

The Stageshow `dark-hero` and `dark-bento` examples guide surface hierarchy and
restraint. This is a real application, so the existing native controls, real
metadata, full keyboard access and skin lifecycle are retained. The illustration
kit and scripted cursor are not needed in the product runtime.

## Composition and visual direction

- Preserve the four skins' navigation, wallpaper, turntable and player layout
  identities. Improve readable content surfaces and consistent panel insets.
- Controls: 36px desktop actions, 8px corners, aligned labels and 18px utility
  icons. Retain circular transport controls and Qingfeng's signature capsules.
  Search is one field rather than an input outlined inside another field.
- Content: separate cover art, track metadata and secondary text with a clear
  type scale. Group related actions and reduce unnecessary nested borders.
- Stage controls: a readable inspector with a proper header, search field,
  section separators, aligned value readouts, recognizable switches and a fixed
  action footer. Preserve the parameter schema, live updates, undo and search.
- Scene settings: consistent fields and action shapes, a clear sticky header,
  enough space between property groups, and bounded mobile panels.
- Creative workshop: preserve its green-gray palette, including under light
  themes. Give its existing switches a visible track, thumb and disabled state;
  align full-width selects with the other parameter controls.
- Mobile: controls remain reachable at 390 and 320px; inspector panels adapt
  to the viewport instead of shrinking their text. Qingfeng's settings use a
  horizontal category bar above a full-width pane, rather than squeezing the
  desktop navigation beside the content.
- Themes: use the existing palette tokens; verify both Mineral and iOS Light.
  Reduced motion and keyboard focus remain explicit.

## Scope and verification

Changes belong to existing shared skin styles, the four relevant skin
stylesheets and stage control/scene/workshop styles. Two decorative letter
badges use the application's existing SVG sprite icons. Existing playback, queue,
persistence, navigation and skin switching remain with their canonical owners.
Other pending workspace edits are independent.

Compare source-served screenshots before and after using an isolated real
backend and tagged WAV fixtures. Check desktop, short desktop, tablet, mobile,
light theme, empty library, settings, control search, undo and player opening. Run the
existing frontend contracts and relevant browser regressions. Record actual
checks and limitations in `plugin/ui/skins/REHEARSAL.md`.
