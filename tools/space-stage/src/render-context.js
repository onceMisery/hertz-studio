// SPDX-License-Identifier: MIT
// One renderer, drawing-buffer reservation and context lifetime per target.
import { createResourcePool } from './resources/pool.js';

export const THREE_DEFAULT_RESOURCES = Object.freeze({ textureDeclaredBytes: 9 * 4, ownedCpuBytes: 4 * 4 });

let nextContextId = 0;
export function createRenderContext(THREE, canvas, options = {}) {
  if (!canvas || typeof canvas.addEventListener !== 'function') throw new Error('Stage requires a canvas');
  const pagePort = options.resources || null;
  if (pagePort && pagePort.contractVersion !== 1) throw new Error('resource-policy-required');
  const contextId = `space-context-${++nextContextId}`;
  const release = ticket => ticket?.release({ apiReleased: true, allocationEnded: true });
  let renderer = null, gl = null, contextTicket = null, surfaceTicket = null, defaultsTicket = null;
  let retired = false, cleanupComplete = false, cleanupFailed = false, lost = false, admissionFailure = '';
  const pool = createResourcePool({ contextId, maxEntries: options.maxResourceEntries || 512 });
  function confirmRetirement() {
    if (!retired || cleanupComplete || cleanupFailed || gl && !gl.isContextLost()) return;
    cleanupComplete = true;
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    renderer = gl = null; canvas.width = canvas.height = 0;
    release(surfaceTicket); release(defaultsTicket); release(contextTicket);
    surfaceTicket = defaultsTicket = contextTicket = null;
  }
  function retire() {
    if (retired) { confirmRetirement(); return; }
    retired = true; pool.dispose();
    try {
      renderer?.dispose();
    } catch (_) { cleanupFailed = true; }
    try {
      if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch (_) { /* No cleanup receipt: keep the original held tickets. */ }
    finally { confirmRetirement(); }
    if (!cleanupComplete) {
      // Losing a native context is asynchronous on some hosts. Retain the
      // original capability and its reservation until loss is actually proven.
      canvas.addEventListener('webglcontextlost', onLost);
    }
  }
  const onLost = event => {
    event.preventDefault();
    if (retired) { confirmRetirement(); return; }
    if (lost) return;
    lost = true;
    // Borrowers release private objects/leases before their renderer retires.
    try { options.onContextLost?.(); } finally { retire(); }
  };
  const onRestored = () => { if (lost) options.onContextRestored?.(); };
  try {
    contextTicket = pagePort?.require({ gpuContexts: 1 }, 'SpaceStage original shared Three renderer context', 0);
    const pixels = Math.max(1, canvas.width * canvas.height);
    surfaceTicket = pagePort?.require({ drawingBufferPixels: pixels, renderTargetDeclaredBytes: pixels * 8 },
      'SpaceStage original RGBA8/depth drawing buffer', 0, 'bounded-estimate');
    defaultsTicket = pagePort?.require(THREE_DEFAULT_RESOURCES,
      'Three r186 WebGLState original 1x1 RGBA8 2D,cube6,array,3D defaults and four upload arrays', 0);
    // The original context owner keeps the handle even if a subsequent Three
    // initialization allocation throws before the constructor returns.
    gl = canvas.getContext('webgl2', { alpha: true, depth: true, stencil: false,
      antialias: options.antialias === true, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    contextTicket?.commit(); surfaceTicket?.commit();
    renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: options.antialias === true, powerPreference: 'high-performance' });
    renderer.hertzProgramResources = pagePort; renderer.hertzBufferResources = pagePort;
    renderer.info.autoReset = false;
    defaultsTicket?.commit();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
  } catch (error) {
    retire(); throw new Error(`WebGL initialization failed: ${error.message}`);
  }
  return {
    contextId, canvas, pagePort, pool,
    get renderer() { return renderer; }, get lost() { return lost; },
    get admissionFailure() { return admissionFailure; },
    resize(width, height, dpr) {
      if (retired || lost) return false;
      const pixelWidth = Math.floor(width * dpr), pixelHeight = Math.floor(height * dpr);
      let nextSurface = null;
      try {
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
          const peakPixels = Math.max(pixelWidth * canvas.height, pixelWidth * pixelHeight);
          nextSurface = pagePort?.require({ drawingBufferPixels: peakPixels, renderTargetDeclaredBytes: peakPixels * 8 },
            'SpaceStage shared drawing buffer old/new/intermediate resize', 0, 'bounded-estimate');
          renderer.setDrawingBufferSize(width, height, dpr);
          nextSurface?.commit({ drawingBufferPixels: pixelWidth * pixelHeight, renderTargetDeclaredBytes: pixelWidth * pixelHeight * 8 });
          release(surfaceTicket); surfaceTicket = nextSurface;
        }
        admissionFailure = ''; return true;
      } catch (error) {
        if (nextSurface) {
          canvas.width = canvas.height = 0; release(surfaceTicket); surfaceTicket = null; release(nextSurface);
        }
        admissionFailure = error.message; return false;
      }
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      retire();
    },
    stats() { return { contextId, retired, cleanupComplete, cleanupFailed, contextLost: lost, antialiasRequested: options.antialias === true,
      // Default framebuffer samples are browser/driver storage, observed rather
      // than a fabricated application-owned render-target allocation.
      defaultFramebufferSamples: renderer?.capabilities.samples ?? null, ...pool.stats() }; }
  };
}
