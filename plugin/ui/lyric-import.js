// SPDX-License-Identifier: MIT
// Selection prepares a candidate. Only the separate Apply action writes.
(function () {
  'use strict';
  function create(host, actions) {
    var serial = 0, controller = null, picked = null, candidate = null;
    var writeNote = '将替换这首曲目的歌词覆盖层，保留每曲偏移；不修改原歌词文件。';
    function h(tag, text) { var e = document.createElement(tag); if (text) e.textContent = text; return e; }
    var title = h('strong'), status = h('p'), preview = h('ol'), note = h('p', writeNote);
    status.setAttribute('role', 'status'); status.dataset.lyricImportStatus = '';
    var form = h('form'), source = h('select'), query = h('input'), search = h('button', '搜索候选'), results = h('ul');
    var automaticLabel = h('label'), automaticApply = h('input');
    form.className = 'np-lyric-search'; form.hidden = true;
    source.setAttribute('aria-label', '歌词来源'); source.dataset.lyricSource = '';
    query.type = 'text'; query.maxLength = 192; query.setAttribute('aria-label', '歌词检索词'); query.dataset.lyricQuery = '';
    search.type = 'submit'; search.className = 'np-lyric-btn'; search.dataset.lyricSearch = '';
    results.className = 'np-lyric-candidates';
    automaticApply.type = 'checkbox'; automaticApply.dataset.lyricAutoApply = '';
    automaticLabel.className = 'np-lyric-auto-option';
    automaticLabel.append(automaticApply, h('span', '仅对当前无可见歌词时自动应用唯一精确匹配'));
    form.append(source, query, search, automaticLabel);
    var apply = h('button', '应用这份歌词'), cancel = h('button', '取消'); apply.type = cancel.type = 'button';
    apply.className = cancel.className = 'np-lyric-btn'; apply.dataset.lyricImportApply = ''; cancel.dataset.lyricImportCancel = '';
    var buttons = h('div'); buttons.className = 'np-lyric-import-actions'; buttons.append(apply, cancel);
    host.append(title, form, status, results, preview, note, buttons); host.hidden = true;
    function same(a, b) { return !!a && !!b && a.id === b.id && a.epoch === b.epoch; }
    function active(mine, target) { return mine === serial && same(target, actions.selection()); }
    function invalidate() { serial++; if (controller) controller.abort(); controller = null; candidate = null; apply.disabled = true; search.disabled = false; }
    function close() {
      invalidate(); picked = null; host.hidden = true; form.hidden = true;
      preview.replaceChildren(); results.replaceChildren(); note.textContent = writeNote;
    }
    function errorText(error) { return (error.message || '歌词处理失败') + (error.requestId ? '（request_id ' + error.requestId + '）' : ''); }
    function endpoint(target) { return '/v1/tracks/' + encodeURIComponent(target.id) + '/lyrics'; }
    async function readUtf8(file) {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
      catch (error) { throw Error('歌词文件必须是有效的 UTF-8 文本'); }
    }
    function validId(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value); }
    function validRevision(value) { return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value); }
    function showPreview(reply) {
      if (!reply || !validId(reply.candidateId) || !validRevision(reply.lyricsRevision)
        || ['lrc', 'enhanced_lrc', 'ttml'].indexOf(reply.format) < 0 || ['line', 'word', 'mixed'].indexOf(reply.timingPrecision) < 0
        || !Number.isSafeInteger(reply.lineCount) || reply.lineCount < 1 || reply.lineCount > 2048
        || !Number.isSafeInteger(reply.wordCount) || reply.wordCount < 0 || reply.wordCount > 16384
        || !Array.isArray(reply.preview) || reply.preview.length < 1 || reply.preview.length > 3) throw Error('歌词候选结构无效，请重新检查');
      var origin = reply.origin;
      if (!['local-import', 'online-provider'].includes(reply.source) || (reply.source === 'online-provider') !== !!origin
        || origin && (typeof origin.label !== 'string' || !origin.label.trim() || origin.label.length > 256
        || typeof origin.provider !== 'string' || !origin.provider.trim() || origin.provider.length > 32
        || typeof origin.refId !== 'string' || !origin.refId.trim() || origin.refId.length > 256 || origin.licenseStatus !== 'not_provided')) throw Error('歌词来源信息无效');
      var precision = { line: '逐行', word: '逐词', mixed: '混合行/词时间' }[reply.timingPrecision];
      status.textContent = (origin ? origin.label : '本地导入') + ' · ' + reply.format.toUpperCase() + ' · ' + precision + ' · ' + reply.lineCount + ' 行 / ' + reply.wordCount + ' 词。检查通过，尚未应用。';
      note.textContent = origin ? writeNote + ' 来源未提供歌词再分发许可；分享或导出前请确认授权。' : writeNote;
      preview.replaceChildren();
      reply.preview.forEach(function (line) {
        if (typeof line.text !== 'string' || !Number.isSafeInteger(line.startMs) || line.startMs < 0 || line.startMs > 86400000) throw Error('歌词候选预览无效');
        preview.append(h('li', (line.startMs / 1000).toFixed(3) + ' 秒 · ' + line.text.slice(0, 320)));
      });
      candidate = reply; apply.disabled = false;
    }
    async function choose(file) {
      close(); picked = actions.selection(); if (!picked) return;
      var target = picked, mine = ++serial; host.hidden = false; title.textContent = '检查歌词：' + file.name;
      status.textContent = '正在检查格式与时间轴…';
      try {
        if (file.size > 262144) throw Error('歌词文件不能超过 256 KiB');
        controller = new AbortController();
        var loaded = await Promise.all([readUtf8(file), actions.get(endpoint(target), { signal: controller.signal })]);
        if (!active(mine, target)) return;
        var format = /\.(ttml|xml)$/i.test(file.name) ? 'ttml' : /\.lrc$/i.test(file.name) ? 'lrc' : 'auto';
        var reply = await actions.post(endpoint(target) + '/candidates', {
          content: loaded[0], format: format, expectedMetadataRevision: loaded[1].metadataRevision, expectedLyricsRevision: loaded[1].lyricsRevision,
        }, { signal: controller.signal });
        if (active(mine, target)) showPreview(reply);
      } catch (error) { if (mine === serial) { candidate = null; apply.disabled = true; status.textContent = errorText(error); } }
      finally { if (mine === serial) { controller = null; search.disabled = false; } }
    }
    function openSearch() {
      close(); picked = actions.selection(); if (!picked) return;
      var sources = actions.sources ? actions.sources() : []; if (!sources.length) return;
      host.hidden = false; form.hidden = false; title.textContent = '查找在线歌词';
      source.replaceChildren(); sources.forEach(function (item) { var option = h('option', item.label); option.value = item.id; source.append(option); });
      query.value = [picked.title, picked.artist].filter(Boolean).join(' ');
      status.textContent = '搜索会将检索词发给所选来源；默认手动检查并确认应用。';
      query.focus();
    }
    function reasonText(evidence) {
      var names = { title_equal: '曲名一致', title_different: '曲名不同', artist_equal: '歌手一致', artist_missing: '缺少歌手', artist_different: '歌手不同',
        album_equal: '专辑一致', album_missing: '缺少专辑', album_different: '专辑不同', duration_close: '时长接近', duration_different: '时长不同', duration_missing: '缺少时长', version_different: '版本标记不同' };
      return evidence.reasons.map(function (reason) { return names[reason] || reason; }).join(' · ')
        + (Number.isSafeInteger(evidence.durationDeltaMs) ? ' · 时长差 ' + (evidence.durationDeltaMs / 1000).toFixed(3) + ' 秒' : '');
    }
    async function applyCandidate(target, current, automatic) {
      var mine = ++serial; apply.disabled = true;
      status.textContent = automatic ? '正在应用已检查的唯一精确匹配…' : '正在应用已检查歌词…';
      controller = new AbortController();
      try {
        await actions.post(endpoint(target) + '/candidates/apply', { candidateId: current.candidateId,
          expectedLyricsRevision: current.lyricsRevision, automaticApply: !!automatic }, { signal: controller.signal });
        if (!active(mine, target)) return;
        candidate = null; status.textContent = '歌词已应用。'; preview.replaceChildren(); await actions.applied(target.id);
      } catch (error) { if (mine === serial) { candidate = null; status.textContent = errorText(error); } }
      finally { if (mine === serial) { controller = null; search.disabled = false; } }
    }
    async function checkOnline(item, revision, target, automatic) {
      if (!same(picked, target) || !same(target, actions.selection())) return;
      invalidate(); var mine = ++serial; preview.replaceChildren();
      title.textContent = '检查歌词：' + item.title;
      status.textContent = automatic ? '唯一精确匹配已确认，正在检查歌词…' : '正在读取并检查所选歌词…'; controller = new AbortController();
      try {
        var reply = await actions.post(endpoint(target) + '/candidates/prepare-online', { candidateId: item.candidateId, expectedLyricsRevision: revision }, { signal: controller.signal });
        if (active(mine, target)) {
          showPreview(reply);
          if (automatic) await applyCandidate(target, candidate, true);
        }
      } catch (error) { if (mine === serial) { candidate = null; apply.disabled = true; status.textContent = errorText(error); } }
      finally { if (mine === serial) controller = null; }
    }
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); if (!same(picked, actions.selection())) { close(); return; }
      invalidate(); var mine = ++serial, target = picked; search.disabled = true; results.replaceChildren(); preview.replaceChildren();
      status.textContent = '正在搜索歌词候选…'; controller = new AbortController();
      try {
        var baseline = await actions.get(endpoint(target), { signal: controller.signal });
        if (!active(mine, target)) return;
        var reply = await actions.post(endpoint(target) + '/candidates/search', { source: source.value, query: query.value,
          expectedMetadataRevision: baseline.metadataRevision, expectedLyricsRevision: baseline.lyricsRevision,
          allowAutomaticApply: automaticApply.checked }, { signal: controller.signal });
        if (!active(mine, target)) return;
        if (!reply || !Array.isArray(reply.candidates) || reply.candidates.length > 3 || !validRevision(reply.lyricsRevision)
          || typeof reply.automaticApplyAllowed !== 'boolean') throw Error('歌词搜索结果无效');
        reply.candidates.forEach(function (item) {
          if (!validId(item.candidateId) || ![item.title, item.artist, item.album].every(function (s) { return typeof s === 'string' && s.length <= 2048; })
            || !item.evidence || typeof item.evidence.strongMetadataMatch !== 'boolean'
            || typeof item.evidence.automaticApplyAllowed !== 'boolean' || !Array.isArray(item.evidence.reasons) || item.evidence.reasons.length > 6
            || !item.evidence.reasons.every(function (r) { return typeof r === 'string' && r.length <= 48; })
            || (item.evidence.durationDeltaMs !== null && (!Number.isSafeInteger(item.evidence.durationDeltaMs) || item.evidence.durationDeltaMs < 0))) throw Error('歌词候选信息无效');
          var row = h('li'), name = h('strong', item.title), description = h('p', [item.artist, item.album].filter(Boolean).join(' · '));
          var reasons = h('p', reasonText(item.evidence)), check = h('button', '检查这份歌词'); check.type = 'button'; check.className = 'np-lyric-btn'; check.dataset.lyricCheck = '';
          check.addEventListener('click', function () { checkOnline(item, reply.lyricsRevision, target); }); row.append(name, description, reasons, check); results.append(row);
        });
        var automaticChoices = reply.candidates.filter(function (item) { return item.evidence.automaticApplyAllowed; });
        if (reply.automaticApplyAllowed !== (automaticChoices.length === 1) || (reply.automaticApplyAllowed && !automaticApply.checked)) throw Error('歌词自动应用资格无效');
        if (reply.automaticApplyAllowed) {
          status.textContent = '找到唯一精确匹配，正在检查并应用…';
          await checkOnline(automaticChoices[0], reply.lyricsRevision, target, true);
        } else {
          status.textContent = reply.candidates.length ? '找到 ' + reply.candidates.length + ' 份候选。请核对同名异曲、翻唱和现场版本；需手动确认应用。' : '未找到候选；可修改检索词后重试，或导入本地歌词。';
        }
      } catch (error) { if (mine === serial) { results.replaceChildren(); status.textContent = errorText(error); } }
      finally { if (mine === serial) { controller = null; search.disabled = false; } }
    });
    function changedSearch() {
      invalidate(); results.replaceChildren(); preview.replaceChildren(); note.textContent = writeNote;
      status.textContent = '检索条件已改变，请重新搜索。';
    }
    source.addEventListener('change', changedSearch); query.addEventListener('input', changedSearch);
    automaticApply.addEventListener('change', function () {
      invalidate(); results.replaceChildren(); preview.replaceChildren(); note.textContent = writeNote;
      status.textContent = '自动应用设置已改变，请重新搜索。';
    });
    apply.addEventListener('click', async function () {
      if (!candidate || !same(picked, actions.selection())) { close(); return; }
      await applyCandidate(picked, candidate, false);
    });
    cancel.addEventListener('click', close);
    return { choose: choose, search: openSearch, close: close, sync: function () {
      var selection = actions.selection(); if (picked && !same(picked, selection)) close();
      if (actions.availability) actions.availability(!!selection && !!(actions.sources && actions.sources().length));
    } };
  }
  window.LyricImport = { create: create };
})();
