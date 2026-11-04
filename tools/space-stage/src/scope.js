export function createScope() {
  const controller = new AbortController();
  const resources = new Set();
  const cleanups = new Set();
  const timers = new Set();
  const leases = new Set();
  let disposed = false;
  function defer(fn) {
    if (typeof fn !== 'function') throw new Error('Cleanup must be a function');
    if (disposed) fn(); else cleanups.add(fn);
    return fn;
  }
  function track(resource) {
    if (!resource || typeof resource.dispose !== 'function') throw new Error('Resource must be disposable');
    if (!resources.has(resource)) {
      if (disposed) resource.dispose(); else resources.add(resource);
    }
    return resource;
  }
  // Pool resources never enter `track`: scope teardown releases the consumer
  // lease and lets the pool decide whether the underlying texture can die.
  function lease(poolLease) {
    if (!poolLease || typeof poolLease.release !== 'function') throw new Error('Pool lease must be releasable');
    if (disposed) { poolLease.release(); return poolLease; }
    leases.add(poolLease);
    return poolLease;
  }
  function trackTree(root) {
    root.traverse(object => {
      if (object.isInstancedMesh) track(object);
      if (object.geometry) track(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of materials) {
        track(material);
        Object.values(material).forEach(value => { if (value && value.isTexture && !value.poolOwned) track(value); });
        Object.values(material.uniforms || {}).forEach(uniform => { if (uniform.value && uniform.value.isTexture && !uniform.value.poolOwned) track(uniform.value); });
      }
      if (object.shadow && object.shadow.map) track(object.shadow.map);
    });
    return root;
  }
  function stats() {
    let estimatedBytes = 0;
    for (const resource of resources) {
      if (resource.isBufferGeometry) {
        const arrays = new Set(Object.values(resource.attributes || {}).map(attr => attr.array));
        if (resource.index) arrays.add(resource.index.array);
        arrays.forEach(array => { estimatedBytes += array ? array.byteLength : 0; });
      } else if (resource.isTexture) {
        const img = resource.image || {};
        estimatedBytes += (img.width || 0) * (img.height || 0) * 4 * 1.333;
      } else if (resource.isWebGLRenderTarget) estimatedBytes += resource.width * resource.height * 8;
      else if (resource.isInstancedMesh) estimatedBytes += resource.instanceMatrix.array.byteLength + (resource.instanceColor ? resource.instanceColor.array.byteLength : 0);
    }
    return { resources: resources.size, tasks: timers.size, cleanups: cleanups.size, leases: leases.size, estimatedBytes: Math.round(estimatedBytes) };
  }
  return { signal: controller.signal, track, trackTree, lease, defer, stats,
    release(resource) { if (resources.delete(resource)) resource.dispose(); },
    listen(target, event, handler, options) { target.addEventListener(event, handler, options); defer(() => target.removeEventListener(event, handler, options)); return handler; },
    timeout(fn, ms) { if (disposed) return null; const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, ms); timers.add(timer); return timer; },
    abortController() { const child = new AbortController(); defer(() => child.abort()); return child; },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      timers.forEach(clearTimeout); timers.clear();
      [...cleanups].reverse().forEach(fn => { try { fn(); } catch (_) {} }); cleanups.clear();
      [...leases].reverse().forEach(poolLease => { try { poolLease.release(); } catch (_) {} }); leases.clear();
      [...resources].reverse().forEach(resource => { try { resource.dispose(); } catch (_) {} }); resources.clear();
    },
  };
}
