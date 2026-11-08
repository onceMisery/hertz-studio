export function createScope(options = {}) {
  const pagePort = options.resources || null;
  if (pagePort && pagePort.contractVersion !== 1) throw new Error('resource-policy-required');
  const controller = new AbortController();
  const resources = new Set();
  const cleanups = new Set();
  const timers = new Set();
  const leases = new Set();
  const admissions = new Set();
  let disposed = false, cleanupFailed = false, allocationTasks = 0;
  function releaseAdmissions() {
    if (!disposed || allocationTasks || cleanupFailed) return;
    admissions.forEach(ticket => ticket.release({ apiReleased: true, allocationEnded: true })); admissions.clear();
  }
  function bufferPlan(cpuPeakBytes, bufferBytes, source) {
    if (disposed) throw new Error('Scope disposed');
    if (!pagePort) return { cpuReady() {}, upload(attribute) { return attribute; } };
    let cpu, gpu;
    try {
      cpu = pagePort.require({ ownedCpuBytes: cpuPeakBytes }, source + ' CPU construction/retained array plan', options.generation || 0);
      gpu = pagePort.require({ bufferDeclaredBytes: bufferBytes }, source + ' per-context buffer upload plan', options.generation || 0);
    } catch (error) { cpu?.release({ apiReleased: true, allocationEnded: true }); throw error; }
    admissions.add(cpu); admissions.add(gpu);
    const uploaded = new WeakSet();
    return {
      cpuReady(bytes) { const result = cpu.commit({ ownedCpuBytes: bytes }); if (!result.ok) throw new Error('CPU allocation exceeds plan'); },
      upload(attribute) {
        const underlying = attribute.isInterleavedBufferAttribute ? attribute.data : attribute;
        if (underlying.hertzBufferAdmission && underlying.hertzBufferAdmission !== gpu) throw new Error('buffer-plan-alias-conflict');
        underlying.hertzBufferAdmission = gpu;
        const previous = underlying.onUploadCallback;
        underlying.onUpload(function () {
          previous?.call(this);
          if (disposed || uploaded.has(underlying)) return;
          uploaded.add(underlying);
          const result = gpu.materialize({ bufferDeclaredBytes: underlying.array.byteLength });
          if (!result.ok) throw new Error('Buffer upload exceeds plan');
          if (!gpu.state().pending.bufferDeclaredBytes) gpu.settle({ allocationEnded: true });
        });
        return attribute;
      }
    };
  }
  function defer(fn) {
    if (typeof fn !== 'function') throw new Error('Cleanup must be a function');
    if (disposed) fn(); else cleanups.add(fn);
    return fn;
  }
  function track(resource) {
    if (!resource || typeof resource.dispose !== 'function') throw new Error('Resource must be disposable');
    if (resource.poolOwned) return resource;
    if (!resources.has(resource)) {
      if (disposed) { try { resource.dispose(); } catch (error) { cleanupFailed = true; throw error; } } else resources.add(resource);
    }
    return resource;
  }
  // Pool resources never enter the private set: teardown releases the consumer
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
    return { resources: resources.size, tasks: timers.size, cleanups: cleanups.size, leases: leases.size,
      admissionTickets: admissions.size, allocationTasks, cleanupFailed, estimatedBytes: Math.round(estimatedBytes) };
  }
  return { signal: controller.signal, track, trackTree, lease, defer, stats, bufferPlan,
    releaseLease(poolLease) { if (leases.delete(poolLease)) poolLease.release(); },
    retirementCandidates(renderer) {
      // Unsettled factories and failed cleanup cannot forecast reclaimable quota.
      if (allocationTasks || cleanupFailed) return [];
      const ids = [...admissions].map(ticket => ticket.resourceId), programUses = new Map();
      for (const material of resources) {
        const attributes = material.isBufferGeometry ? [...Object.values(material.attributes), material.index,
          ...Object.values(material.morphAttributes || {}).flat()] : material.isInstancedMesh ? [material.instanceMatrix, material.instanceColor] : [];
        attributes.filter(Boolean).forEach(attribute => {
          const underlying = attribute.isInterleavedBufferAttribute ? attribute.data : attribute;
          if (underlying.hertzImplicitBufferResourceId) ids.push(underlying.hertzImplicitBufferResourceId);
        });
        if (!material.isMaterial || !renderer) continue;
        const programs = renderer.properties.get(material).programs;
        programs?.forEach(program => programUses.set(program, (programUses.get(program) || 0) + 1));
      }
      // Three's cache owns aliases: only forecast a program's retirement when
      // every current material use belongs to this retiring scope.
      programUses.forEach((count, program) => {
        if (count === program.usedTimes && program.hertzProgramResourceId) ids.push(program.hertzProgramResourceId);
      });
      return [...new Set(ids)];
    },
    beginAllocation() { if (disposed) throw new Error('Scope disposed'); allocationTasks++; },
    endAllocation() { if (allocationTasks) allocationTasks--; releaseAdmissions(); },
    release(resource) { if (resources.delete(resource)) resource.dispose(); },
    listen(target, event, handler, options) { target.addEventListener(event, handler, options); defer(() => target.removeEventListener(event, handler, options)); return handler; },
    timeout(fn, ms) { if (disposed) return null; const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, ms); timers.add(timer); return timer; },
    abortController() { const child = new AbortController(); defer(() => child.abort()); return child; },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      timers.forEach(clearTimeout); timers.clear();
      [...cleanups].reverse().forEach(fn => { try { fn(); } catch (_) { cleanupFailed = true; } }); cleanups.clear();
      [...leases].reverse().forEach(poolLease => { try { poolLease.release(); } catch (_) { cleanupFailed = true; } }); leases.clear();
      [...resources].reverse().forEach(resource => { try { resource.dispose(); } catch (_) { cleanupFailed = true; } }); resources.clear();
      admissions.forEach(ticket => ticket.cancel()); releaseAdmissions();
    },
  };
}
