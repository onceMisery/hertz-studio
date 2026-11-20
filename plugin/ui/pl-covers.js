// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 歌单封面解析（共享数据层）。
//
// 3D 歌单架与封面列表行都需要同一套两跳解析：列出歌单曲目 → 挑第一张
// 带内嵌封面的曲子 → 取它的封面 URL。此前这套逻辑（含缓存、在途去重、
// 稳定色相占位）是 shelf.js 私有的，列表行只能画渐变色块。
//
// 这里只做解析与缓存，不碰 DOM、不写 fetch：数据依赖由 app.js 通过
// init({ fetchTracks, fetchCover }) 注入，与 shelf.js / stage.js 同一套分工。

(function () {
  'use strict';

  var api = null;
  // playlistId -> { s:'pending'|'none'|'url', url?, hue }
  var states = new Map();
  var listeners = [];
  var STATE_CAP = 200;
  var borrowed = new Map(), stateTickets = new Map(), requests = new Set(), sourcePort = null;

  function finishState(record) {
    clearTimeout(record.timer); record.timer = null;
    record.finished = true; requests.delete(record);
    if (record.retired) record.ticket.release({ apiReleased: true, allocationEnded: true });
  }

  function releaseState(id) {
    var lease = borrowed.get(id); if (lease) lease.release(); borrowed.delete(id);
    var record = stateTickets.get(id);
    if (record) {
      record.retired = true; clearTimeout(record.timer); record.timer = null;
      if (record.finished) record.ticket.release({ apiReleased: true, allocationEnded: true });
    }
    stateTickets.delete(id);
    states.delete(id);
  }
  function clearStates() { states.forEach(function (_, id) { releaseState(id); }); }
  function admitState(id) {
    var ledger = window.Stage && Stage.resources && Stage.resources();
    if (!ledger) throw new Error('resource-policy-required');
    if (!sourcePort) sourcePort = ledger.port('playlist-cover-state');
    var ticket = sourcePort.require({ ownedCpuBytes: 512 + String(id).length * 2 },
      'playlist cover identity, state and bounded promise callbacks', 0, 'bounded-estimate');
    ticket.commit();
    var record = { ticket: ticket, finished: false, retired: false, timer: null };
    stateTickets.set(id, record); requests.add(record); return record;
  }

  // 没有封面的歌单也要有东西看：用 id 哈希出稳定色相，同一个歌单每次渲染
  // 必须同色，否则切换时占位块跳色。
  function placeholderHue(id) {
    var h = 0;
    for (var i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
    return h;
  }

  // 挑第一张真带封面的曲目。has_cover 是扫描时从标签里读出来的，靠它先筛
  // 一遍，比逐首请求封面再吃 404 省一大截。
  function pickCoverTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    for (var i = 0; i < tracks.length; i += 1) if (tracks[i].has_cover) return tracks[i].id;
    return null;
  }

  function emit(id) {
    for (var i = 0; i < listeners.length; i += 1) {
      try { listeners[i](id); } catch (e) { /* 一个监听者出错不连累别的视图 */ }
    }
  }

  // 只在第一次被询问时解析，在途期间重复询问共享同一个结果 —— 两个视图
  // 同时可见同一个歌单时不会打出两跳重复请求。
  function load(id) {
    if (!api || states.has(id)) return;
    if (requests.size >= STATE_CAP) return;
    while (states.size >= STATE_CAP) releaseState(states.keys().next().value);
    var record;
    try { record = admitState(id); } catch (_) { return; }
    var pending = { s: 'pending', hue: placeholderHue(id) };
    states.set(id, pending);
    record.timer = setTimeout(function () {
      if (states.get(id) !== pending) return;
      // Keep a bounded terminal placeholder until a new explicit invalidation;
      // onChange readers must not turn the watchdog into an automatic retry loop.
      states.set(id, { s: 'none', hue: placeholderHue(id) }); emit(id);
    }, 8000);
    var deps = api;
    // states already deduplicates both hops. Only keep the final URL/hue;
    // playlist track arrays are no longer retained after choosing a cover.
    var tracksPromise;
    try { tracksPromise = Promise.resolve(deps.fetchTracks(id)); }
    catch (error) { tracksPromise = Promise.reject(error); }
    tracksPromise.then(function (tracks) {
      if (states.get(id) !== pending) return;
      var trackId = pickCoverTrack(tracks);
      if (!trackId) { states.set(id, { s: 'none', hue: placeholderHue(id) }); emit(id); return; }
      return deps.fetchCover(trackId).then(function (url) {
        if (states.get(id) !== pending) return;
        if (url && window.HertzCovers && HertzCovers.borrow) {
          var lease = HertzCovers.borrow(url, sourcePort);
          if (lease) { borrowed.set(id, lease); url = lease.url; }
        }
        states.set(id, url
          ? { s: 'url', url: url, hue: placeholderHue(id) }
          : { s: 'none', hue: placeholderHue(id) });
        emit(id);
      });
    }).catch(function () {
      if (states.get(id) !== pending) return;
      states.set(id, { s: 'none', hue: placeholderHue(id) });
      emit(id);
    }).finally(function () { finishState(record); });
  }

  // 实例只建一次：app.js 持有 init() 的返回值，shelf.js 不经过 app.js，
  // 直接用 window.PlaylistCovers 上的同名方法，两者必须是同一个实例。
  var instance = {
    // 首次询问即触发解析。调用方不要长期保存返回状态对象的字段，封面就绪
    // 后以 onChange 回调里的再次查询为准。
    state: function (id) {
      if (!api) throw new Error('PlaylistCovers.init() must run before state()');
      if (!states.has(id)) load(id);
      return states.get(id) || { s: 'none', hue: placeholderHue(id) };
    },
    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
    // 歌单内容变了要丢掉缓存，否则加歌/删歌之后封面还停在旧数据上。
    invalidate: function (id) {
      if (id) releaseState(id);
      else clearStates();
    }
  };

  window.PlaylistCovers = {
    init: function (deps) {
      api = deps || {};
      clearStates();
      listeners = [];
      return instance;
    },
    state: function (id) { return instance.state(id); },
    onChange: function (fn) { instance.onChange(fn); },
    invalidate: function (id) { instance.invalidate(id); }
  };
  if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', function (event) {
    if (!event.persisted) clearStates();
  });
})();
