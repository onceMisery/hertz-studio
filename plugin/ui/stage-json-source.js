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
    function walk(v, depth, arrayItem) {
      if (depth > 26) throw new Error('estimate-unavailable');
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
        if (v.length > 4096) throw new Error('estimate-unavailable');
        for (var i = 0; i < v.length; i++) {
          var item = Object.getOwnPropertyDescriptor(v, String(i));
          if (item && (item.get || item.set)) throw new Error('estimate-unavailable');
          if (i) chars++; bytes += 8; walk(item ? item.value : undefined, depth + 1, true);
        }
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
          if (++count > 512) throw new Error('estimate-unavailable');
          if (count > 1) chars++; chars += quotedLength(key) + 1; bytes += 8 + key.length * 2;
          walk(child, depth + 1, false);
        }
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
  window.StageJsonSource = Object.freeze({ measure: measure, clone: clone, representation: representation });
})();
