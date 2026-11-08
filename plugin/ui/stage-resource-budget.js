// SPDX-License-Identifier: MIT
// Resource declarations only. Allocation, cleanup and scene definitions stay in their owners.
(function (global) {
  'use strict';
  var KEYS = ['gpuContexts', 'canvases', 'drawingBufferPixels', 'programs',
    'renderTargetDeclaredBytes', 'textureDeclaredBytes', 'bufferDeclaredBytes',
    'ownedCpuBytes', 'decodeReservedBytes', 'decoderLeases'];
  var nextLedger = 0;

  function vector(value, complete) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('estimate-unavailable');
    Object.keys(value).forEach(function (key) {
      if (KEYS.indexOf(key) < 0) throw new Error('unknown-resource-dimension: ' + key);
    });
    var result = {};
    KEYS.forEach(function (key) {
      var n = value[key];
      if (n === undefined && !complete) n = 0;
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid-resource-dimension: ' + key);
      result[key] = n;
    });
    return result;
  }
  function zero() { return vector({}); }
  function add(a, b) {
    var sum = {};
    KEYS.forEach(function (key) {
      var n = a[key] + b[key];
      if (!Number.isSafeInteger(n)) throw new Error('resource-counter-overflow');
      sum[key] = n;
    });
    return sum;
  }
  function text(value, name) {
    if (typeof value !== 'string' || !value || value.length > 256) throw new Error('invalid-' + name);
    return value;
  }
  function copyReport(value) {
    var result = {};
    Object.keys(value).forEach(function (key) {
      result[key] = Array.isArray(value[key]) ? value[key].slice() : value[key];
    });
    return result;
  }

  function create(policy, options) {
    if (!policy || policy.contractVersion !== 1) throw new Error('resource-policy-required');
    var caps = Object.freeze(vector(policy.caps, true));
    var policyVersion = text(policy.policyVersion, 'policy-version');
    options = options || {};
    if (nextLedger === Number.MAX_SAFE_INTEGER) throw new Error('resource-identity-overflow');
    var qualification = policy.qualification;
    var ledgerId = 'stage-resources-' + (++nextLedger), serial = 0, closed = false;
    var entries = new Map(), reports = new Map(), listeners = new Set();
    var pending = zero(), live = zero(), peak = zero(), violations = [], rejections = 0;
    var notificationPending = false;
    var defer = typeof options.defer === 'function' ? options.defer : function (fn) {
      if (typeof queueMicrotask === 'function') queueMicrotask(fn); else Promise.resolve().then(fn);
    };
    function id(owner) {
      if (serial === Number.MAX_SAFE_INTEGER) throw new Error('resource-identity-overflow');
      return ledgerId + ':' + owner + ':' + (++serial);
    }
    function held() { return add(live, pending); }
    function recordPeak() {
      var total = held();
      KEYS.forEach(function (key) { peak[key] = Math.max(peak[key], total[key]); });
    }
    function changed() {
      if (notificationPending) return;
      notificationPending = true;
      defer(function () {
        notificationPending = false;
        listeners.forEach(function (fn) { try { fn(); } catch (e) { /* Observer cannot change admission. */ } });
      });
    }
    function rejection(reason, dimensions) {
      rejections++;
      return { ok: false, reason: reason, dimensions: dimensions || [], policyVersion: policyVersion };
    }
    function violation(entry, reason, observed) {
      entry.cancelled = true;
      var detail = { resourceId: entry.resourceId, requestId: entry.requestId, owner: entry.owner,
        reason: reason, observed: observed || null, policyVersion: policyVersion };
      violations.push(detail);
      if (violations.length > 64) violations.shift();
      return { ok: false, reason: 'contract-violation', detail: detail };
    }
    function retain(resourceId, use) {
      var entry = entries.get(resourceId);
      if (!entry || entry.released || entry.cancelled) return rejection('resource-unavailable');
      use = use || {};
      var useId = text(use.useId, 'use-id'), owner = text(use.owner, 'owner');
      if (entry.leases.has(useId)) {
        var old = entry.leases.get(useId);
        return old.owner === owner ? { ok: true, ticket: old.ticket, referenced: true }
          : rejection('resource-identity-conflict');
      }
      var released = false;
      var ticket = Object.freeze({ kind: 'lease', resourceId: resourceId, useId: useId,
        release: function () {
          if (released) return { ok: true, duplicate: true };
          released = true; entry.leases.delete(useId); changed(); return { ok: true };
        } });
      entry.leases.set(useId, { owner: owner, ticket: ticket });
      return { ok: true, ticket: ticket, referenced: true };
    }
    function reserve(plan) {
      if (closed) return rejection('page-resources-closed');
      plan = plan || {};
      var amount, owner, resourceId, requestId, lifetimeId;
      try {
        amount = vector(plan.resources);
        owner = text(plan.owner, 'owner'); resourceId = text(plan.resourceId, 'resource-id');
        requestId = text(plan.requestId, 'request-id'); lifetimeId = text(plan.lifetimeId, 'lifetime-id');
        if (!Number.isSafeInteger(plan.generation) || plan.generation < 0 || plan.planVersion !== 1)
          throw new Error('invalid-resource-plan');
        if (plan.policyVersion && plan.policyVersion !== policyVersion) throw new Error('stale-resource-policy');
        if (!plan.basis || ['exact-declared', 'bounded-estimate'].indexOf(plan.basis.precision) < 0
            || typeof plan.basis.source !== 'string' || !plan.basis.source) throw new Error('estimate-unavailable');
      } catch (e) { return rejection(e.message); }
      var old = entries.get(resourceId);
      if (old) {
        if (old.owner !== owner || old.lifetimeId !== lifetimeId || old.generation !== plan.generation
            || KEYS.some(function (key) { return old.envelope[key] !== amount[key]; }))
          return rejection('resource-identity-conflict');
        return retain(resourceId, { owner: owner, useId: requestId });
      }
      var next;
      try { next = add(held(), amount); } catch (e) { return rejection(e.message); }
      var exceeded = KEYS.filter(function (key) { return next[key] > caps[key]; });
      if (exceeded.length) return rejection('aggregate-budget', exceeded);
      var entry = { owner: owner, resourceId: resourceId, requestId: requestId, lifetimeId: lifetimeId,
        generation: plan.generation, planVersion: plan.planVersion, policyVersion: policyVersion,
        basis: { precision: plan.basis.precision, source: plan.basis.source }, envelope: amount,
        pending: vector(amount), live: zero(), ended: false, cancelled: false, released: false, committed: null,
        leases: new Map() };
      pending = add(pending, amount); entries.set(resourceId, entry); recordPeak();
      function materialize(value) {
        if (entry.released || entry.ended) return rejection('resource-allocation-ended');
        var actual;
        try { actual = vector(value); } catch (e) { return violation(entry, e.message); }
        var overrun = KEYS.filter(function (key) { return actual[key] > entry.pending[key]; });
        var nextEntryLive, nextLive;
        try { nextEntryLive = add(entry.live, actual); nextLive = add(live, actual); }
        catch (e) { return violation(entry, e.message, actual); }
        // Even a violating, already-materialized allocation remains visible and blocks further admission.
        KEYS.forEach(function (key) {
          var consumed = Math.min(actual[key], entry.pending[key]);
          entry.pending[key] -= consumed; pending[key] -= consumed;
        });
        entry.live = nextEntryLive; live = nextLive; recordPeak();
        if (overrun.length) return violation(entry, 'allocation-exceeds-plan', actual);
        return { ok: true, cancelled: entry.cancelled };
      }
      function settle(proof) {
        if (entry.released) return { ok: true, duplicate: true };
        if (!proof || proof.allocationEnded !== true) return rejection('allocation-still-pending');
        if (entry.ended) return { ok: true, duplicate: true };
        KEYS.forEach(function (key) { pending[key] -= entry.pending[key]; entry.pending[key] = 0; });
        entry.ended = true; changed(); return { ok: true };
      }
      var ticket = Object.freeze({ kind: 'allocation', resourceId: resourceId, requestId: requestId,
        policyVersion: policyVersion,
        materialize: materialize,
        commit: function (value) {
          if (entry.released) return rejection('resource-allocation-ended');
          if (entry.ended) {
            try {
              var repeated = value === undefined ? entry.committed : vector(value);
              if (entry.committed && repeated && KEYS.every(function (key) { return repeated[key] === entry.committed[key]; }))
                return { ok: true, duplicate: true, cancelled: entry.cancelled };
            } catch (e) { return rejection(e.message); }
            return rejection('resource-allocation-ended');
          }
          var committed;
          try { committed = vector(value === undefined ? entry.pending : value); }
          catch (e) { return violation(entry, e.message); }
          var result = materialize(committed);
          if (!result.ok) return result;
          entry.committed = committed;
          settle({ allocationEnded: true }); return result;
        },
        cancel: function () {
          if (entry.released) return { ok: true, duplicate: true };
          entry.cancelled = true; return { ok: true, allocationEnded: entry.ended };
        },
        settle: settle,
        release: function (proof) {
          if (entry.released) return { ok: true, duplicate: true };
          if (!proof || proof.apiReleased !== true || proof.allocationEnded !== true)
            return rejection('resource-cleanup-unconfirmed');
          if (entry.leases.size) return rejection('resource-in-use');
          KEYS.forEach(function (key) {
            pending[key] -= entry.pending[key]; live[key] -= entry.live[key];
            entry.pending[key] = entry.live[key] = 0;
          });
          entry.ended = entry.released = true; entries.delete(resourceId); changed(); return { ok: true };
        },
        state: function () {
          return { resourceId: resourceId, requestId: requestId, cancelled: entry.cancelled,
            allocationEnded: entry.ended, released: entry.released, leases: entry.leases.size,
            pending: vector(entry.pending), live: vector(entry.live) };
        } });
      return { ok: true, ticket: ticket, referenced: false };
    }
    function port(owner, lifetimeId) {
      owner = text(owner, 'owner'); lifetimeId = text(lifetimeId || id(owner), 'lifetime-id');
      return Object.freeze({ contractVersion: 1, policyVersion: policyVersion, owner: owner, lifetimeId: lifetimeId,
        nextId: function () { return id(owner); },
        reserve: function (plan) {
          plan = plan || {};
          return reserve(Object.assign({}, plan, { owner: owner, lifetimeId: lifetimeId,
            resourceId: plan.resourceId || id(owner), requestId: plan.requestId || id(owner) }));
        },
        require: function (resources, source, generation, precision) {
          var result = reserve({ owner: owner, lifetimeId: lifetimeId, resourceId: id(owner), requestId: id(owner),
            generation: generation, planVersion: 1, policyVersion: policyVersion, resources: resources,
            basis: { precision: precision || 'exact-declared', source: source } });
          if (!result.ok) {
            var error = new Error(result.reason);
            error.resourceFailure = result;
            throw error;
          }
          return result.ticket;
        },
        retain: function (resourceId, useId) { return retain(resourceId, { owner: owner, useId: useId }); },
        onAvailable: function (fn) {
          if (typeof fn !== 'function') throw new Error('invalid-resource-observer');
          listeners.add(fn); var removed = false;
          return function () { if (!removed) { removed = true; listeners.delete(fn); } };
        },
        report: function (value) {
          // Clone scalars; a renderer/DOM handle can never enter the ledger through a report.
          var out = { contractVersion: 1, owner: owner, lifetimeId: lifetimeId };
          Object.keys(value || {}).forEach(function (key) {
            var v = value[key];
            if ((key === 'owner' && v !== owner) || (key === 'lifetimeId' && v !== lifetimeId)
                || (key === 'contractVersion' && v !== 1)) throw new Error('resource-report-identity-conflict');
            if (v === null || typeof v === 'string' || typeof v === 'boolean'
                || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
            else if (Array.isArray(v) && v.every(function (x) { return typeof x === 'string'; })) out[key] = v.slice();
            else throw new Error('resource-report-must-be-scalar');
          });
          reports.set(lifetimeId, out);
        },
        forgetReport: function () { reports.delete(lifetimeId); } });
    }
    return Object.freeze({ contractVersion: 1, policyVersion: policyVersion, port: port, reserve: reserve, retain: retain,
      close: function () { closed = true; entries.forEach(function (entry) { entry.cancelled = true; }); },
      snapshot: function (detail) {
        var result = { contractVersion: 1, policyVersion: policyVersion, qualification: qualification,
          closed: closed, caps: vector(caps), live: vector(live), pending: vector(pending), held: held(),
          peak: vector(peak), resources: entries.size, listeners: listeners.size, rejections: rejections,
          violations: violations.map(function (v) { return Object.assign({}, v, { observed: v.observed && vector(v.observed) }); }) };
        if (detail) {
          result.entries = Array.from(entries.values()).map(function (entry) {
            return { owner: entry.owner, resourceId: entry.resourceId, requestId: entry.requestId,
              lifetimeId: entry.lifetimeId, generation: entry.generation, basis: Object.assign({}, entry.basis),
              pending: vector(entry.pending), live: vector(entry.live), cancelled: entry.cancelled,
              allocationEnded: entry.ended, leases: entry.leases.size };
          });
          result.hosts = Array.from(reports.values()).map(copyReport);
        }
        return result;
      } });
  }
  var api = Object.freeze({ contractVersion: 1, dimensions: Object.freeze(KEYS.slice()), create: create, vector: vector });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.StageResourceBudget = api;
})(typeof window === 'object' ? window : globalThis);
