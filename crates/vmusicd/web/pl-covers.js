// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
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
  var trackCache = new Map();
  var listeners = [];

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
    states.set(id, { s: 'pending', hue: placeholderHue(id) });

    var tracksPromise = trackCache.has(id)
      ? Promise.resolve(trackCache.get(id))
      : api.fetchTracks(id).then(function (tracks) {
          trackCache.set(id, tracks || []);
          return tracks || [];
        });

    tracksPromise.then(function (tracks) {
      var trackId = pickCoverTrack(tracks);
      if (!trackId) { states.set(id, { s: 'none', hue: placeholderHue(id) }); emit(id); return; }
      return api.fetchCover(trackId).then(function (url) {
        states.set(id, url
          ? { s: 'url', url: url, hue: placeholderHue(id) }
          : { s: 'none', hue: placeholderHue(id) });
        emit(id);
      });
    }).catch(function () {
      states.set(id, { s: 'none', hue: placeholderHue(id) });
      emit(id);
    });
  }

  // 实例只建一次：app.js 持有 init() 的返回值，shelf.js 不经过 app.js，
  // 直接用 window.PlaylistCovers 上的同名方法，两者必须是同一个实例。
  var instance = {
    // 首次询问即触发解析。调用方不要长期保存返回状态对象的字段，封面就绪
    // 后以 onChange 回调里的再次查询为准。
    state: function (id) {
      if (!api) throw new Error('PlaylistCovers.init() must run before state()');
      if (!states.has(id)) load(id);
      return states.get(id);
    },
    onChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
    // 歌单内容变了要丢掉缓存，否则加歌/删歌之后封面还停在旧数据上。
    invalidate: function (id) {
      if (id) { states.delete(id); trackCache.delete(id); }
      else { states.clear(); trackCache.clear(); }
    }
  };

  window.PlaylistCovers = {
    init: function (deps) {
      api = deps || {};
      states.clear();
      trackCache.clear();
      listeners = [];
      return instance;
    },
    state: function (id) { return instance.state(id); },
    onChange: function (fn) { instance.onChange(fn); },
    invalidate: function (id) { instance.invalidate(id); }
  };
})();
