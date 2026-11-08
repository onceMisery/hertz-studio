// SPDX-License-Identifier: MIT
// One renderer, drawing-buffer reservation and context lifetime per target.
import { createResourcePool } from './resources/pool.js';

let nextContextId = 0;
export function createRenderContext(THREE, canvas, options = {}) {
  if (!canvas || typeof canvas.addEventListener !== 'function') throw new Error('Stage requires a canvas');
  const pagePort = options.resources || null;
  if (pagePort && pagePort.contractVersion !== 1) throw new Error('resource-policy-required');
  const contextId = `space-context-${++nextContextId}`;
  const release = ticket => ticket?.release({ apiReleased: true, allocationEnded: true });
  let renderer = null, contextTicket = null, surfaceTicket = null, retired = false, lost = false, admissionFailure = '';
  const pool = createResourcePool({ contextId, maxEntries: options.maxResourceEntries || 512 });
  function retire() {
    if (retired) return;
    retired = true; pool.dispose();
    try {
      if (renderer) {
        renderer.dispose();
        if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
      }
    } finally {
      renderer = null; canvas.width = canvas.height = 0;
      release(surfaceTicket); release(contextTicket); surfaceTicket = contextTicket = null;
    }
  }
  const onLost = event => {
    event.preventDefault();
    if (retired || lost) return;
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
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.hertzProgramResources = pagePort; renderer.hertzBufferResources = pagePort;
    renderer.info.autoReset = false;
    contextTicket?.commit(); surfaceTicket?.commit();
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
    stats() { return { contextId, retired, contextLost: lost, ...pool.stats() }; }
  };
}
