// SPDX-License-Identifier: MIT
// Stateless logical JSON measurement/clone tools. The injected original owner
// retains sources and borrows; these tools keep no page resources or cache.
(function () {
  'use strict';
  var MAX_CHARS = 4 * 1024 * 1024 + 512 * 1024 + 64 * 1024;
  function releaseTicket(ticket) { if (ticket) ticket.release({ apiReleased: true, allocationEnded: true }); }
  function quotedLength(text) {
    var length = 2;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charCodeAt(i);
      if (ch === 34 || ch === 92 || ch === 8 || ch === 9 || ch === 10 || ch === 12 || ch === 13) length += 2;
      else if (ch < 32 || (ch >= 0xd800 && ch <= 0xdbff && !(text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff))
        || (ch >= 0xdc00 && ch <= 0xdfff && !(text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff))) length += 6;
      else length++;
    }
    return length;
  }
  function measure(value, options) {
    options = options || {};
    var borrowed = options.borrowedRootStrings || [], ancestors = [], chars = 0, bytes = 0;
    var indent = Math.min(10, Math.max(0, options.space || 0));
    var rootValues = options.borrowedRootValues || [], itemValues = options.borrowedItemValues || [];
    function walk(v, depth, arrayItem, rootKey) {
      if (depth > 26) throw new Error('estimate-unavailable');
      // Logical ownership-only projections: the parent owns this reference
      // slot, while its explicit lease retains the child representation.
      if ((depth === 1 && rootValues.indexOf(rootKey) >= 0)
        || (depth === 2 && itemValues.indexOf(rootKey) >= 0)) { bytes += 8; return; }
      if (v === null || typeof v === 'boolean' || typeof v === 'number') {
        chars += v === null ? 4 : typeof v === 'boolean' ? (v ? 4 : 5) : Number.isFinite(v) ? String(v).length : 4;
        bytes += 8; return;
      }
      if (typeof v === 'string') { chars += quotedLength(v); bytes += 8 + v.length * 2; return; }
      if (typeof v !== 'object') {
        if (arrayItem && ['undefined','function','symbol'].indexOf(typeof v) >= 0) { chars += 4; bytes += 8; return; }
        throw new Error('estimate-unavailable');
      }
      var proto = Object.getPrototypeOf(v), ownJSON = Object.getOwnPropertyDescriptor(v, 'toJSON');
      var protoJSON = proto && Object.getOwnPropertyDescriptor(proto, 'toJSON');
      var constructor = proto && Object.getOwnPropertyDescriptor(proto, 'constructor');
      var jsonMethod = ownJSON || protoJSON;
      if (ancestors.indexOf(v) >= 0 || (jsonMethod && (jsonMethod.get || jsonMethod.set || typeof jsonMethod.value === 'function'))
        || (proto && (!constructor || !constructor.value || constructor.value.name !== (Array.isArray(v) ? 'Array' : 'Object'))))
        throw new Error('estimate-unavailable');
      ancestors.push(v); chars += 2; bytes += 16;
      if (Array.isArray(v)) {
        if (v.length > (options.maxArrayLength || 4096)) throw new Error('estimate-unavailable');
        for (var i = 0; i < v.length; i++) {
          var item = Object.getOwnPropertyDescriptor(v, String(i));
          if (item && (item.get || item.set)) throw new Error('estimate-unavailable');
          if (i) chars++;
          if (indent) chars += 1 + (depth + 1) * indent;
          bytes += 8; walk(item ? item.value : undefined, depth + 1, true, rootKey);
        }
        if (indent && v.length) chars += 1 + depth * indent;
      } else {
        var count = 0;
        for (var key in v) {
          if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
          var descriptor = Object.getOwnPropertyDescriptor(v, key);
          if (!descriptor || descriptor.get || descriptor.set) throw new Error('estimate-unavailable');
          var child = descriptor.value;
          // Only declared root strings may alias another retained source. Their
          // property/value slots remain charged; they are absent from clone wire.
          if (depth === 0 && borrowed.indexOf(key) >= 0 && typeof child === 'string') {
            bytes += 16 + key.length * 2; continue;
          }
          if (['undefined','function','symbol'].indexOf(typeof child) >= 0) continue;
          if (++count > (options.maxObjectKeys || 512)) throw new Error('estimate-unavailable');
          if (count > 1) chars++; chars += quotedLength(key) + 1; bytes += 8 + key.length * 2;
          if (indent) chars += 2 + (depth + 1) * indent;
          walk(child, depth + 1, false, depth === 0 ? key : rootKey);
        }
        if (indent && count) chars += 1 + depth * indent;
      }
      ancestors.pop();
      if (chars > MAX_CHARS || !Number.isSafeInteger(bytes)) throw new Error('estimate-unavailable');
    }
    walk(value, 0, false);
    if (chars > MAX_CHARS || !Number.isSafeInteger(bytes)) throw new Error('estimate-unavailable');
    return { chars: chars, bytes: bytes };
  }
  function representation(value, ticket, bytes, resources, onCleanup) {
    var retired = false, borrowers = 0;
    function cleanup() {
      if (!retired || borrowers || !ticket) return;
      value = null;
      if (onCleanup) onCleanup(); onCleanup = null;
      releaseTicket(ticket); ticket = null;
    }
    return { get value() { return value; }, ticket: ticket, bytes: bytes,
      borrow: function () {
        if (retired) throw new Error('resource-unavailable');
        var lease = resources.retain(ticket.resourceId, resources.nextId());
        if (!lease.ok) throw new Error(lease.reason);
        borrowers++; var released = false;
        return { release: function () { if (released) return; released = true; lease.ticket.release(); borrowers--; cleanup(); } };
      },
      release: function () { retired = true; cleanup(); } };
  }
  function clone(value, options) {
    var p = options.resources, generation = options.generation || 0;
    var scratch = p.require({ ownedCpuBytes: 2048 }, 'bounded JSON traversal stack/descriptors', generation, 'bounded-estimate');
    var ticket = null, text = null, out = null, borrowed = options.borrowedRootStrings || [];
    var metadataBytes = options.metadataBytes || 0;
    try {
      var plan = measure(value, options);
      ticket = p.require({ ownedCpuBytes: plan.chars * 2 + plan.bytes + metadataBytes },
        'JSON clone UTF16 serialization coexists with declared logical parsed data and source metadata', generation, 'bounded-estimate');
      text = JSON.stringify(value, borrowed.length ? function (key, child) {
        return this === value && borrowed.indexOf(key) >= 0 && typeof child === 'string' ? undefined : child;
      } : undefined);
      out = JSON.parse(text); text = null;
      borrowed.forEach(function (key) {
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && typeof descriptor.value === 'string')
          Object.defineProperty(out, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
      });
      var actual = measure(out, options), committed = ticket.commit({ ownedCpuBytes: actual.bytes + metadataBytes });
      if (!committed.ok) throw new Error(committed.reason);
      var source = representation(out, ticket, actual.bytes + metadataBytes, p); ticket = null; return source;
    } finally { text = out = null; releaseTicket(ticket); releaseTicket(scratch); }
  }
  // Logical payload bytes only: UTF-16 strings, declared typed bytes and JSON
  // scalar/property slots. These are bounded estimates, not engine heap headers.
  function port(owner) {
    var ledger = window.Stage && Stage.resources && Stage.resources();
    if (!ledger) throw new Error('resource-policy-required');
    return ledger.port(owner);
  }
  function reserve(owner, bytes, basis) {
    var p = typeof owner === 'string' ? port(owner) : owner;
    var ticket = p.require({ ownedCpuBytes: bytes }, basis, 0, 'bounded-estimate');
    return {
      finish: function (value, retainedBytes, cleanup) {
        var result = ticket.commit({ ownedCpuBytes: retainedBytes });
        if (!result.ok) { var error = new Error(result.reason); error.resourceFailure = result; throw error; }
        var source = representation(value, ticket, retainedBytes, p, cleanup);
        ticket = null; return source;
      },
      release: function () { releaseTicket(ticket); ticket = null; }
    };
  }
  function utf8Length(text, limit) {
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 128) bytes++;
      else if (c < 2048) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
      if (limit !== undefined && bytes > limit) return bytes;
    }
    return bytes;
  }
  function stringify(value, options) {
    options = options || {};
    var p = options.resources || port(options.owner || 'creative-json');
    var scratch = reserve(p, 2048, 'bounded JSON measurement traversal');
    var work, text;
    try {
      var plan = measure(value, options);
      work = reserve(p, plan.chars * 2, 'JSON output UTF16 text, including requested indentation');
      text = JSON.stringify(value, null, options.space || 0);
      if (options.limit && utf8Length(text, options.limit) > options.limit) throw new Error(options.limitMessage || 'JSON payload too large');
      return work.finish(text, text.length * 2);
    } finally { text = null; if (work) work.release(); scratch.release(); }
  }
  function parse(text, options) {
    options = options || {};
    var limit = options.limit || MAX_CHARS;
    if (typeof text !== 'string' || utf8Length(text, limit) > limit) throw new Error(options.limitMessage || 'JSON payload too large');
    // Every parsed scalar/member consumes at least one source character. 24
    // logical bytes per character bounds even arrays of single-digit numbers.
    var work = reserve(options.owner || 'creative-json', text.length * 26 + 2048,
      'input UTF16 text and bounded parsed JSON scalar/member payload');
    var value;
    try { value = JSON.parse(text); return work.finish(value, text.length * 24 + 2048); }
    finally { value = null; work.release(); }
  }
  function ownedClone(value, owner, options) {
    return clone(value, Object.assign({}, options, { resources: port(owner || 'creative-json') }));
  }
  function transfer(source) {
    // Legacy value APIs transfer to an external caller with an unobservable
    // lifetime. Application consumers use leases, never this boundary wrapper.
    var value = source.value; source.release(); return value;
  }
  function blob(text, type, owner) {
    var bytes = utf8Length(text), work = reserve(owner || 'workshop-download', bytes,
      'download Blob declared UTF8 bytes retained until object URL revocation');
    try { return work.finish(new Blob([text], { type: type }), bytes); }
    finally { work.release(); }
  }
  window.StageJsonSource = Object.freeze({ measure: measure, clone: clone, representation: representation,
    port: port, reserve: reserve, utf8Length: utf8Length, stringify: stringify, parse: parse,
    ownedClone: ownedClone, transfer: transfer, blob: blob });
})();
