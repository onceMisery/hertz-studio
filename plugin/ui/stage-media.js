// SPDX-License-Identifier: MIT
// Player DataDir assets. Only this transport module owns upload tasks/read leases;
// Backgrounds owns the one decoded media element shared by all stage presentations.
(function () {
  'use strict';

  // The Stage facade includes native parent-window suspension. Standalone consumers keep browser visibility.
  function documentHidden() {
    var stage = window.Stage;
    return stage && typeof stage.isDocumentHidden === "function" ? stage.isDocumentHidden() : !!document.hidden;
  }
  var CHUNK = 256 * 1024, active = null, serial = 0;
  function resources() {
    var ledger = window.Stage && Stage.resources && Stage.resources();
    if (!ledger) throw new Error('resource-policy-required');
    return ledger.port('stage-media');
  }
  function releaseTicket(ticket) { if (ticket) ticket.release({ apiReleased: true, allocationEnded: true }); }
  function transport() { if (!window.VMusicTransport) throw new Error('服务连接尚未就绪'); return window.VMusicTransport; }
  function uid() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'stage-' + Date.now().toString(36) + '-' + (++serial) + '-' + Math.random().toString(36).slice(2); }
  function command(action, body) {
    // Cancellation joins native preparation; acquisition may rebuild a missing image.
    // Ordinary control/renewal requests must not occupy a UI queue for fifteen minutes.
    var timeout = action === 'import.cancel' ? 930000 : action === 'lease.acquire' ? 75000 : 15000;
    return transport().post('/v1/stage/media', Object.assign({ action: action }, body), { timeoutMs: timeout });
  }
  function target() { return { width: Math.max(1, Math.min(8192, Math.ceil(window.innerWidth || 1920))), height: Math.max(1, Math.min(8192, Math.ceil(window.innerHeight || 1080))) }; }
  function cancelled() { var e = new Error('已取消素材导入'); e.name = 'AbortError'; return e; }
  function notify(task, status, percent) { if (task.progress) task.progress({ status: status, percent: percent }); }
  async function sha(bytes) {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    if (window.CreativeDraft && CreativeDraft.hashBytes) return CreativeDraft.hashBytes(new Uint8Array(bytes));
    throw new Error('当前环境缺少素材校验能力');
  }
  async function importFile(file, progress) {
    if (active) throw new Error('请先完成或取消当前导入');
    var media = /^video\//.test(file.type) || /\.(mp4|webm)$/i.test(file.name) ? 'video' : 'image';
    if (!file.size || file.size > (media === 'video' ? 512 : 32) * 1024 * 1024) throw new Error('图片最多 32 MiB，视频最多 512 MiB');
    var task = active = { cancelled: false, progress: progress, importId: null };
    try {
      notify(task, 'uploading', 0);
      var request = Object.assign({ requestId: uid(), session: uid(), name: file.name, size: file.size, media: media }, target());
      var begun;
      try { begun = await command('import.begin', request); }
      catch (e) { if (e.status && e.status < 500) throw e; begun = await command('import.begin', request); }
      task.importId = begun.importId;
      if (task.cancelled) throw cancelled();
      for (var offset = begun.offset || 0; offset < file.size;) {
        if (task.cancelled) throw cancelled();
        var part = file.slice(offset, Math.min(file.size, offset + CHUNK));
        var chunkTicket = resources().require({ ownedCpuBytes: part.size * 2 + 256 },
          'StageMedia upload ArrayBuffer, SHA256 work copy and digest', 0, 'bounded-estimate');
        var chunkBytes = null, hash;
        try { chunkBytes = await part.arrayBuffer(); hash = await sha(chunkBytes); chunkTicket.commit(); }
        finally { chunkBytes = null; releaseTicket(chunkTicket); }
        var path = '/v1/stage/media/import/chunk?importId=' + encodeURIComponent(begun.importId)
          + '&uploadToken=' + encodeURIComponent(begun.uploadToken) + '&offset=' + offset + '&hash=' + hash;
        try { await transport().postRaw(path, part, 'application/octet-stream'); }
        catch (e) {
          if (task.cancelled) throw cancelled();
          // Same offset and digest can be replayed once; the native owner checks bytes.
          if (e.status && e.status < 500) throw e;
          await transport().postRaw(path, part, 'application/octet-stream');
        }
        offset += part.size;
        notify(task, 'uploading', Math.round(offset / file.size * 100));
      }
      if (task.cancelled) throw cancelled();
      var receipt;
      try { receipt = await command('import.finish', { importId: task.importId }); }
      catch (e) { receipt = await command('import.status', { importId: task.importId }); if (receipt.status === 'uploading') throw e; }
      notify(task, 'preparing', 100);
      var deadline = Date.now() + 900000;
      while (receipt.status === 'preparing') {
        if (task.cancelled) throw cancelled();
        if (Date.now() > deadline) throw new Error('素材准备超时，可从已导入素材中检查结果');
        await new Promise(function (r) { setTimeout(r, 400); });
        receipt = await command('import.status', { importId: task.importId });
      }
      if (task.cancelled) throw cancelled();
      if (receipt.status !== 'committed' || !receipt.assetRef) throw new Error(receipt.error || '素材导入未完成');
      return { type: 'media', media: receipt.media, assetRef: receipt.assetRef };
    } catch (e) {
      // A committed installation survives cancellation or a failed browser probe.
      if (task.importId) await command('import.cancel', { importId: task.importId }).catch(function () {});
      throw e;
    } finally { if (active === task) active = null; }
  }
  async function cancel() {
    if (!active) return;
    active.cancelled = true;
    if (active.importId) await command('import.cancel', { importId: active.importId });
  }
  async function acquire(spec, options) {
    options = options || {};
    if (options.signal && options.signal.aborted) throw cancelled();
    var reply = await command('lease.acquire', Object.assign({ assetRef: spec.assetRef }, target()));
    var blobUrl = null, timer = 0, released = false, activeLease = true, renewing = null, lost = false;
    var readTicket = null, blobTicket = null, assembling = false, parts = [], raw = null, bytes = null;
    var interval = Math.max(1000, Math.min(30000, (reply.ttlMs || 120000) / 4));
    function stopTimer() { clearTimeout(timer); timer = 0; }
    function schedule() {
      stopTimer();
      if (released || lost || !activeLease || documentHidden()) return;
      timer = setTimeout(function () { timer = 0; renew().catch(function () {}); }, interval);
    }
    function renew() {
      if (released) return Promise.reject(cancelled());
      if (renewing) return renewing;
      stopTimer();
      renewing = command('lease.renew', { leaseId: reply.leaseId }).then(function (receipt) {
        if (!released) { lost = false; interval = Math.max(1000, Math.min(30000, (receipt.ttlMs || 120000) / 4)); }
        return receipt;
      }).catch(function (error) {
        if (!released) {
          lost = true;
          if (options.onLost) options.onLost(error);
        }
        throw error;
      }).finally(function () { renewing = null; schedule(); });
      return renewing;
    }
    function setActive(value) {
      var changed = activeLease !== !!value;
      activeLease = !!value;
      if (!activeLease) { stopTimer(); return null; }
      // A hidden/inactive surface may have outlived its server lease.
      if (changed) return renew();
      return renewing;
    }
    async function release() {
      if (released) return; released = true; stopTimer();
      if (options.signal) options.signal.removeEventListener('abort', release);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = null;
      if (!assembling) { releaseTicket(blobTicket); blobTicket = null; }
      await command('lease.release', { leaseId: reply.leaseId }).catch(function () {});
    }
    schedule();
    try {
      if (options.signal) {
        options.signal.addEventListener('abort', release, { once: true });
        if (options.signal.aborted) { await release(); throw cancelled(); }
      }
      if (!reply.url) {
        if (reply.media !== 'image' || !Number.isSafeInteger(reply.length) || reply.length <= 0 || reply.length > 32 * 1024 * 1024)
          throw new Error('当前 DBX 宿主不支持视频流或无效图片长度');
        assembling = true;
        readTicket = resources().require({ ownedCpuBytes: reply.length + CHUNK * 8 },
          'StageMedia DBX retained typed parts plus bounded JSON base64/atob/block copies', 0, 'bounded-estimate');
        blobTicket = resources().require({ ownedCpuBytes: reply.length }, 'StageMedia DBX encoded Blob source', 0, 'bounded-estimate');
        for (var offset = 0; offset < reply.length;) {
          if (released) throw cancelled();
          var block = await command('lease.read', { leaseId: reply.leaseId, offset: offset, count: CHUNK });
          if (released) throw cancelled();
          if (block.offset !== offset || block.length !== reply.length || block.contentKey !== reply.contentKey) throw new Error('素材读取版本发生变化，请重试');
          if (typeof block.dataBase64 !== 'string' || block.dataBase64.length > Math.ceil(CHUNK / 3) * 4)
            throw new Error('素材读取块编码长度无效');
          raw = atob(block.dataBase64); bytes = new Uint8Array(raw.length);
          if (!raw.length || raw.length > CHUNK || offset + raw.length > reply.length) throw new Error('素材读取长度无效');
          for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          parts.push(bytes); offset += bytes.length;
        }
        blobUrl = URL.createObjectURL(new Blob(parts, { type: reply.mime }));
        blobTicket.commit();
        parts.length = 0; raw = bytes = null; releaseTicket(readTicket); readTicket = null; assembling = false;
      }
      if (options.signal) options.signal.removeEventListener('abort', release);
      return { url: blobUrl || reply.url, release: release, assetRef: spec.assetRef,
        media: reply.media, length: reply.length,
        // Native prepare::image uses cover scaling, so target width*height is not an upper bound.
        // Its independent 16MP/8192-side guard is the source contract for every derived image.
        decodeBounds: Object.freeze(reply.media === 'image'
          ? { maxPixels: 16000000, maxSide: 8192, rgbaFrames: 1, basis: 'native prepare::image 16MP/8192' }
          : { maxPixels: 1920 * 1088, maxSide: 1920, rgbaFrames: 6, basis: 'native prepare::validate video bound; candidate six-frame workspace' }),
        renew: renew, setActive: setActive };
    } catch (e) { await release(); throw e; }
    finally {
      parts.length = 0; raw = bytes = null; releaseTicket(readTicket); assembling = false;
      if (released) { releaseTicket(blobTicket); blobTicket = null; }
    }
  }
  window.StageMedia = { importFile: importFile, cancel: cancel, acquire: acquire, uid: uid,
    busy: function () { return !!active; }, list: function (offset) { return transport().get('/v1/stage/media?offset=' + (offset || 0)); },
    remove: function (ref) { return command('asset.delete', { assetId: ref.assetId }); } };
})();
