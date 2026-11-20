// SPDX-License-Identifier: MIT
// Capture the classic-script URL while the shared runtime is evaluating.
// Direct source imports (Node checks) resolve to the same generated assets.
const script = typeof document === 'undefined' ? null : document.currentScript?.src;
const source = import.meta.url;
export function runtimeAssetUrl(file) {
  if (script) return new URL('stage-assets/' + file, script).href;
  if (typeof document !== 'undefined') return new URL('vendor/stage-assets/' + file, document.baseURI).href;
  if (source) return new URL('../../../plugin/ui/vendor/stage-assets/' + file, source).href;
  // A DOM-free bundle consumer may inspect contracts/catalogs without loading assets.
  return 'vendor/stage-assets/' + file;
}
