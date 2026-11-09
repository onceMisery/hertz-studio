// SPDX-License-Identifier: MIT
// Consumer ownership and pending-work lifetime are independent. Retiring work
// continues to occupy a bounded slot until its actual loader settles.
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value === 0 ? 0 : value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  throw new Error('invalid-resource-identity');
}
export function resourceKey(identity, contextId) {
  if (!identity || typeof identity.contentKey !== 'string' || !identity.contentKey
      || typeof identity.adapterId !== 'string' || !identity.adapterId
      || !Number.isSafeInteger(identity.adapterVersion) || identity.adapterVersion < 1)
    throw new Error('invalid-resource-identity');
  return canonical({ contentKey: identity.contentKey, decodeOptions: identity.decodeOptions || {},
    adapterId: identity.adapterId, adapterVersion: identity.adapterVersion, contextId: identity.contextId || contextId });
}

export function createResourcePool({ contextId, maxEntries = 512, onInvalidate } = {}) {
  const entries = new Map(), pending = new Set(), consumers = new WeakMap();
  let disposed = false, serial = 0;
  function retire(entry) {
    if (entry.retired || entry.consumers.size) return;
    entry.retired = true;
    if (entries.get(entry.poolKey) === entry) entries.delete(entry.poolKey);
    entry.controller?.abort();
    entry.spec.retire?.(entry);
    if (entry.value !== undefined) { entry.spec.releaseValue?.(entry.value); entry.value = undefined; }
  }
  function release(lease) {
    const consumer = consumers.get(lease);
    if (!consumer?.active) return;
    consumer.active = false; consumer.signal?.removeEventListener('abort', consumer.abort);
    consumer.reject?.(new DOMException('Resource cancelled', 'AbortError'));
    consumer.entry.consumers.delete(consumer); retire(consumer.entry);
  }
  function retain(entry, signal, generation, isCurrent) {
    if (disposed || entry.retired || signal?.aborted) return null;
    const consumer = { entry, signal, generation, isCurrent, active: true, abort: null };
    const lease = { release() { release(lease); } };
    for (const field of ['key', 'line', 'font', 'maxWidth', 'aspect', 'layout', 'start', 'end', 'failed', 'resourceFailure'])
      Object.defineProperty(lease, field, { enumerable: true, get: () => entry[field] });
    Object.defineProperties(lease, {
      texture: { enumerable: true, get: () => consumer.active ? entry.texture || entry.value?.texture || null : null },
      value: { enumerable: true, get: () => consumer.active ? entry.value : undefined },
      ready: { get() {
        if (!consumer.ready || consumer.sourcePromise !== entry.promise) {
          consumer.sourcePromise=entry.promise;
          consumer.ready = new Promise((resolve, reject) => {
            consumer.reject = reject;
            (entry.promise || Promise.resolve(entry.value)).then(value => {
              if (!consumer.active || (consumer.isCurrent && !consumer.isCurrent(consumer.generation))) {
                release(lease); reject(new DOMException('Resource cancelled', 'AbortError'));
              } else resolve(value);
            }, reject);
            if (!consumer.active) reject(new DOMException('Resource cancelled', 'AbortError'));
          });
          consumer.ready.catch(() => {});
        }
        return consumer.ready;
      } },
      active: { get: () => consumer.active },
      generation: { value: generation }
    });
    consumer.abort = () => release(lease); consumers.set(lease, consumer); entry.consumers.add(consumer);
    signal?.addEventListener('abort', consumer.abort, { once: true });
    return Object.freeze(lease);
  }
  function start(entry) {
    if (!entry.spec.load || entry.hasValue || entry.loading || entry.retired || !entry.consumers.size) return;
    const loadGeneration = ++serial, controller = new AbortController();
    entry.loadGeneration = loadGeneration; entry.controller = controller; entry.failed = false; entry.loading = true;
    pending.add(entry);
    entry.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DOMException('Resource cancelled', 'AbortError');
      return entry.spec.load({ signal: controller.signal, generation: loadGeneration, entry });
    }).then(value => {
      for (const consumer of [...entry.consumers])
        if (consumer.isCurrent && !consumer.isCurrent(consumer.generation)) release(consumer.lease);
      if (disposed || entry.retired || controller.signal.aborted || entry.loadGeneration !== loadGeneration || !entry.consumers.size) {
        entry.spec.releaseValue?.(value); throw new DOMException('Resource cancelled', 'AbortError');
      }
      entry.value = value; entry.hasValue = true; onInvalidate?.(); return value;
    }).catch(error => {
      if (!entry.retired && !controller.signal.aborted) { entry.failed = true; entry.resourceFailure = error.message; onInvalidate?.(); }
      throw error;
    }).finally(() => { entry.loading = false; pending.delete(entry); entry.controller = null; });
    // A caller may consume only the compatibility .texture getter.
    entry.promise.catch(() => {});
  }
  return {
    entries,
    has(identity) { return entries.has(resourceKey(identity, contextId)); },
    acquire(identity, spec = {}) {
      if (disposed || spec.signal?.aborted) return null;
      const key = resourceKey(identity, contextId); let entry = entries.get(key);
      if (!entry) {
        const units = entries.size + [...pending].filter(item => item.retired).length;
        if (units >= maxEntries) return null;
        entry = Object.assign(spec.create?.() || {}, { poolKey: key, consumers: new Set(), spec, retired: false, value: undefined });
        entries.set(key, entry);
      }
      const lease = retain(entry, spec.signal, spec.generation, spec.isCurrent);
      if (lease) { const consumer = consumers.get(lease); consumer.lease = lease; start(entry); }
      return lease;
    },
    // Existing lazy text/cover adapters use the same consumer owner while
    // preserving their original bounded frame-upload scheduling.
    adopt(key, entry, retireEntry) {
      if (disposed || entries.has(key)) throw new Error('resource-pool-entry-conflict');
      Object.assign(entry, { poolKey: key, consumers: new Set(), spec: { retire: retireEntry }, retired: false });
      entries.set(key, entry); return entry;
    },
    retain(entry, signal) { const lease = retain(entry, signal); if (lease) consumers.get(lease).lease = lease; return lease; },
    release,
    retirementCandidates(leases) {
      // Credit a shared representation only when this retiring batch owns
      // every live consumer. Its settled value may retain dependency leases;
      // those retire only after the representation itself releases its pixels.
      const retiring = new Set(Array.isArray(leases) ? leases : [leases]), complete = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const lease of retiring) {
          const consumer = consumers.get(lease), entry = consumer?.entry;
          if (!consumer?.active || entry.loading || entry.retired || complete.has(entry)
              || [...entry.consumers].some(other => !retiring.has(other.lease))) continue;
          complete.add(entry);
          for (const dependency of entry.value?.retirementLeases?.() || []) {
            if (consumers.has(dependency) && !retiring.has(dependency)) { retiring.add(dependency); changed = true; }
          }
        }
      }
      return [...new Set([...complete].flatMap(entry => entry.value?.retirementCandidates?.() || []))];
    },
    owns(lease) { return consumers.has(lease); },
    markOwned(value) { Object.defineProperty(value, 'poolOwned', { value: true, configurable: false }); return value; },
    retry() { for (const entry of entries.values()) if (entry.failed) start(entry); },
    stats() { return { poolEntries: entries.size, poolPending: pending.size,
      poolLeases: [...entries.values()].reduce((sum, entry) => sum + entry.consumers.size, 0) }; },
    dispose() {
      if (disposed) return; disposed = true;
      for (const entry of [...entries.values()]) {
        for (const consumer of [...entry.consumers]) release(consumer.lease);
        retire(entry);
      }
    }
  };
}
