// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 宿主适配层。
//
// 必须是 index.html 里**第一个**加载的脚本：app.js 排在最后，而 stage3d.js、
// theme-studio.js、online.js 这些都在它之前，靠不上 app.js 定义的东西。
//
// 这一层只做一件事：把「运行在 DBX 插件沙箱里」与「运行在独立服务上」的差异
// 收敛到几个函数里，让其余 47k 行前端代码不需要知道自己跑在哪个宿主上。
//
// 独立形态下这里的每个函数都是恒等的 / 不安装的，行为与改动前逐字节一致。

(function () {
  'use strict';

  // 宿主把 SDK 注入在 <head> 最前面，所以这里能同步拿到。
  var dbx = window.dbxPlugin || null;

  // -------------------------------------------------------------------------
  // 站内资源 URL
  // -------------------------------------------------------------------------

  /// 把站内绝对路径解析成当前宿主下真正可取的 URL。
  ///
  /// 两边要求是冲突的，不能简单选一个：
  /// - 独立形态**必须**用根相对路径。theme-studio.js 的 WALL_BASE 注释记着一个
  ///   修过的 bug：页面挂在反代前缀下时，相对路径会解析成 /前缀/wallpapers/x.jpg
  ///   而对服务端是 404，表现是「换了主题，背景图却不出来」。
  /// - DBX 插件形态**必须**补全。宿主注入 <base href="dbx-plugin://localhost/<插件id>/ui/">，
  ///   而按 RFC 3986，以 / 开头的引用会**丢掉 base 的 path**，解析成
  ///   dbx-plugin://localhost/wallpapers/x.jpg —— 少了插件 id 前缀，自定义协议
  ///   处理器直接 404。
  ///
  /// 所以声明处一律保持根相对（check-online.js 的图标路径断言也因此不用改），
  /// 只在真正赋给 DOM 的地方过一遍这个函数。
  function assetUrl(url) {
    if (!dbx || typeof url !== 'string' || url.charAt(0) !== '/') return url;
    try {
      return new URL(url.slice(1), document.baseURI).href;
    } catch (err) {
      return url;
    }
  }

  // -------------------------------------------------------------------------
  // localStorage
  // -------------------------------------------------------------------------

  /// 探测原生 localStorage 是否可用。
  ///
  /// DBX 的插件 iframe 是 srcdoc + sandbox="allow-scripts"，origin 是 opaque(null)，
  /// 这种情况下**读取 window.localStorage 这个属性本身**就抛 SecurityError，
  /// 不是等到 getItem 才抛。前端有 14 个文件、55 处引用，其中若干是裸访问
  /// （没包 try/catch），所以必须在这里兜住。
  function probeNativeStorage() {
    try {
      var storage = window.localStorage;
      // 光拿到引用还不够：某些实现是访问方法时才抛。
      storage.getItem('__hertz_probe__');
      return storage;
    } catch (err) {
      return null;
    }
  }

  var STORAGE_KEY = 'ui-local-storage';
  var PERSIST_DEBOUNCE_MS = 250;

  /// 内存 Map + 宿主持久化的 localStorage 替身。
  ///
  /// 整存整取而不是逐键存：宿主的 storage 只有 get/set/delete，**没有枚举 API**，
  /// 逐键存的话刷新后就再也找不回有哪些键。代价是每次 setItem 都要重写整个 blob，
  /// 所以做了 debounce。宿主侧单个值上限 256 KiB、整个 storage 上限 1 MiB，
  /// 这里存的都是视图偏好、主题选择、舞台参数这类小字符串，够用；真超了就
  /// 丢一次写入并告警，比让调用方炸掉好。
  function installStorageShim() {
    var memory = new Map();
    var timer = 0;
    var warned = false;

    function persist() {
      if (!dbx || !dbx.storage) return;
      var snapshot = {};
      memory.forEach(function (value, key) { snapshot[key] = value; });
      dbx.storage.set(STORAGE_KEY, snapshot).catch(function (err) {
        if (warned) return;
        warned = true;
        console.warn('[hertz] 界面偏好持久化失败（本次会话内仍然有效）：', err);
      });
    }

    function schedulePersist() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = 0; persist(); }, PERSIST_DEBOUNCE_MS);
    }

    var shim = {
      getItem: function (key) {
        return memory.has(String(key)) ? memory.get(String(key)) : null;
      },
      setItem: function (key, value) {
        memory.set(String(key), String(value));
        schedulePersist();
      },
      removeItem: function (key) {
        if (memory.delete(String(key))) schedulePersist();
      },
      clear: function () {
        memory.clear();
        schedulePersist();
      },
      key: function (index) {
        var keys = Array.from(memory.keys());
        return index >= 0 && index < keys.length ? keys[index] : null;
      },
    };
    Object.defineProperty(shim, 'length', {
      get: function () { return memory.size; },
      enumerable: true,
    });

    try {
      Object.defineProperty(window, 'localStorage', {
        value: shim,
        writable: false,
        configurable: true,
      });
    } catch (err) {
      console.warn('[hertz] 无法安装 localStorage 替身：', err);
      return null;
    }

    /// 把宿主里存的偏好读回内存。必须在任何模块读取偏好之前 await 完。
    shim.hydrate = function () {
      if (!dbx || !dbx.storage) return Promise.resolve();
      return dbx.storage.get(STORAGE_KEY).then(function (snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        Object.keys(snapshot).forEach(function (key) {
          var value = snapshot[key];
          if (typeof value === 'string') memory.set(key, value);
        });
      }).catch(function (err) {
        console.warn('[hertz] 界面偏好读取失败，按首次启动处理：', err);
      });
    };
    return shim;
  }

  var native = probeNativeStorage();
  var shim = native ? null : installStorageShim();

  // -------------------------------------------------------------------------
  // 对外
  // -------------------------------------------------------------------------

  window.hertzHost = {
    /// 是否跑在 DBX 插件沙箱里。传输层据此在 HTTP 与 invoke 之间选一条。
    isDbx: !!dbx,
    dbx: dbx,
    assetUrl: assetUrl,
    /// 原生 localStorage 不可用时装了替身，需要先 hydrate 再让界面读偏好。
    needsHydrate: !!shim,
    hydrate: function () {
      return shim && shim.hydrate ? shim.hydrate() : Promise.resolve();
    },
  };
})();
