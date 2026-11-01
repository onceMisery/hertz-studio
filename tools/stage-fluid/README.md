# Hertz Studio fluid enhancement

Application integration of the fluid solver in Canvas UI's
`src/lib/Liquid/LiquidVanilla.ts`, pinned to upstream commit
`a04a99b235299ee79a123a16ccb2e6cf9da74b6b`.

The copied simulation shaders and adapted solver retain **MIT + Commons Clause**,
copyright David Haz. See [the complete license](LICENSE.md). This integration is
distributed as part of Hertz Studio, not as a reusable component package.

Changes: removed framework wrappers, HTML-in-Canvas capture, content textures,
independent animation loops and input listeners; accept external time and input;
bound simulation work and resolution; check allocation/compilation and clean up
partial failures; render only a premultiplied, transparent, local color layer.
Hertz Studio owns preference storage, input, visibility, scheduling and lifetime.

Build with the existing `tools/space-stage` esbuild dependency:

```sh
node tools/build-stage-fluid.mjs
node tools/build-stage-fluid.mjs --check
```

The generated `plugin/ui/vendor/stage-fluid.js` includes the complete upstream
license and stays separate from the MIT-labeled shared Three.js runtime.
The build also refreshes `.build-manifest.json`; the frontend guard checks its
source, license, build-script and bundle hashes without requiring esbuild in CI.
Current application admission and verification limits are documented in
[`docs/stage-fluid-enhancement.md`](../../docs/stage-fluid-enhancement.md).
