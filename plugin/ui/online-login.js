// SPDX-License-Identifier: MIT
//
// 在线音源扫码登录：start → 渲染二维码 → 轮询票态 → confirmed/cancel。
// 弹窗 DOM 在 index.html #qr-modal；传输层用 app.js 挂出的 VMusicTransport。
// 平台握手票从不离开服务端，前端只拿到 Registry 换发的不透明 ticket。
(function () {
  'use strict';
  /// 背景图位封面：插件形态下远程地址要经 sidecar 换成 data URL（沙箱 CSP 画不
  /// 出 https 图）。HertzCovers 由 app.js 挂出；契约检查的沙箱只加载本模块，
  /// 拿不到时回落成直接赋值，即独立形态的同款行为。
  function applyBg(el, url) {
    if (window.HertzCovers) { window.HertzCovers.applyBg(el, url); return; }
    if (el) el.style.backgroundImage = url ? 'url("' + url + '")' : '';
  }
  /// <img> 位封面，同 applyBg：插件形态走代理，沙箱回落直接赋值。
  function applyImg(img, url) {
    if (window.HertzCovers) { window.HertzCovers.applyImg(img, url); return; }
    if (!img) return;
    if (url) img.src = url;
    else img.removeAttribute('src');
  }
  // VMusicTransport 由后加载的 app.js 挂到 window，顶层抓只会拿到 undefined；
  // 本模块所有网络调用都发生在 start() 之后，届时再取即可。
  var T = null;
  var pollTimer = null;
  var currentSource = null;
  var currentTicket = null;
  // QQ 当前码渠道：'qq'（手机 QQ 扫）或 'wx'（微信扫）。
  var currentChannel = 'qq';
  // 可登录音源清单（来自 /v1/online/sources，只保留有任一登录能力的源）。
  var loginSources = [];
  // 各源已登录账号：source -> AccountInfo（未登录的源不在表里）。
  var accountsById = {};
  // 顶栏选中展示头像的音源 id。
  //
  // 权威值存在服务端 settings 表的 `topAvatarSource` 键，跟着数据库走，
  // 服务重启后仍在。localStorage 只作「同一次会话内的即时镜像」：服务每次
  // 启动监听的端口不同，浏览器按 origin 隔离 localStorage，换端口就是换
  // 源，旧镜像根本读不到——只靠它就会每次重启都丢选择。
  var TOP_AV_KEY = 'vmusic.topAvatarSource';
  var TOP_AV_SETTING = 'topAvatarSource';
  var selectedAvatarSource = readSelectedAvatar();
  function readSelectedAvatar() {
    try { return localStorage.getItem(TOP_AV_KEY) || null; } catch (e) { return null; }
  }
  /// 只写本地镜像，不触网。
  function writeLocalMirror(id) {
    try {
      if (id) localStorage.setItem(TOP_AV_KEY, id);
      else localStorage.removeItem(TOP_AV_KEY);
    } catch (e) {}
  }
  /// 落内存 + 本地镜像 + 服务端持久层。
  /// 服务端写入失败不打断交互：镜像还在，本次会话仍按选择展示。
  function writeSelectedAvatar(id) {
    writeLocalMirror(id);
    if (!T) return;
    T.put('/v1/settings', { topAvatarSource: id || '' }).catch(function (e) {
      if (window.console) console.warn('顶栏头像选择持久化失败：', e);
    });
  }
  /// 启动时从服务端读回选择。
  /// 服务端没有而镜像有，说明是只存 localStorage 的旧版本留下的选择——
  /// 顺手迁移到服务端，之后重启就能恢复。
  async function loadSelectedAvatar() {
    var remote = null;
    try {
      var s = await T.get('/v1/settings');
      var v = s ? s[TOP_AV_SETTING] : null;
      if (typeof v === 'string' && v) remote = v;
    } catch (e) { /* 读不到就退回镜像 */ }
    var local = readSelectedAvatar();
    if (remote) {
      selectedAvatarSource = remote;
      writeLocalMirror(remote); // 镜像与服务端对齐
    } else if (local) {
      selectedAvatarSource = local;
      writeSelectedAvatar(local); // 旧值迁移上服务端
    } else {
      selectedAvatarSource = null;
    }
  }

  // 各平台二维码必须用对应 App 扫：QQ 走的是 QQ 互联授权，用 QQ 音乐 App
  // 扫只会打开网页（用户实测会跳到 QQ 音乐 PC 首页）。汽水的登录码由抖音
  // Passport 签发，上游文案也是「请使用「抖音 APP」扫码验证」。
  var SCAN_APP = {
    netease: '网易云音乐 App',
    qq: '手机 QQ（不是 QQ 音乐 App）',
    kugou: '酷狗音乐 App',
    qishui: '抖音 App（汽水音乐用抖音账号登录）',
  };
  function scanApp(source) { return SCAN_APP[source] || '对应平台的 App'; }

  function el(id) { return document.getElementById(id); }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function renderQr(start) {
    var box = el('qr-canvas');
    box.innerHTML = '';
    box.style.cursor = 'default';
    if (start.qr_image) {
      var img = new Image();
      img.src = start.qr_image;
      img.alt = '登录二维码';
      box.appendChild(img);
    } else if (start.qr_text && window.qrcode) {
      var qr = window.qrcode(0, 'M');
      qr.addData(start.qr_text);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } else {
      // 既没有平台下发的图片，本地二维码库也没加载出来：不能让用户对着
      // 空白框等。把原文摆出来至少还能换个扫码工具手动处理。
      box.textContent = start.qr_text || '二维码生成失败';
    }
    currentTicket = start.ticket;
    schedulePoll(currentSource, start.ticket, start.poll_ms || 2000);
  }

  function schedulePoll(source, ticket, ms) {
    stopPolling();
    pollTimer = setTimeout(function () { poll(source, ticket, ms); }, ms);
  }

  async function poll(source, ticket, ms) {
    var p;
    try {
      p = await T.get('/v1/online/qr/poll?source=' + encodeURIComponent(source)
        + '&ticket=' + encodeURIComponent(ticket));
    } catch (e) {
      // 服务端业务错误（换票失败、风控等）要把原文显示出来，不能笼统当
      // 网络问题无限重试，否则用户无法判断发生了什么。
      el('qr-status').textContent = '请求失败：' + (e && e.message ? e.message : '网络异常') + '（3s 后重试）';
      schedulePoll(source, ticket, 3000);
      return;
    }
    if (p.state === 'waiting') {
      el('qr-status').textContent = '请用' + scanApp(source) + '扫码登录';
      schedulePoll(source, ticket, ms);
    } else if (p.state === 'scanned') {
      el('qr-status').textContent = '已扫码，请在手机上确认登录';
      schedulePoll(source, ticket, ms);
    } else if (p.state === 'confirmed') {
      stopPolling();
      el('qr-status').textContent = '登录成功';
      close();
      if (window.OnlinePlaylists) window.OnlinePlaylists.refresh();
    } else if (p.state === 'rejected') {
      // 上游明确拒绝这次扫码（如网易云 8821）：不是"再等等"，刷新二维码
      // 也只会拿到同一句，直接引导走手动 cookie。
      stopPolling();
      el('qr-status').textContent = '该平台拒绝了这次扫码登录，请改用下方手动 cookie 登录';
    } else if (p.state === 'mfa_required') {
      // 上游要求二次验证（汽水音乐 2046），而那一步要在官方 JS 环境里跑，
      // 本地服务没有浏览器内核：这条码走不通，如实说清并指向 cookie 导入。
      stopPolling();
      el('qr-status').textContent = '该平台要求二次安全验证，本机无法完成，请改用下方手动 cookie 登录';
    } else if (p.state === 'expired') {
      stopPolling();
      el('qr-status').textContent = '二维码已过期，点击二维码刷新';
      var box = el('qr-canvas');
      box.style.opacity = '.4';
      box.style.cursor = 'pointer';
      box.onclick = function () { start(source, currentChannel); };
    } else {
      // 未约定的票态（平台侧异常串等）：继续轮询只会空转，停下并把原始
      // 状态展示出来，用户可以关掉重开或走 cookie 兜底。
      stopPolling();
      el('qr-status').textContent = '登录状态异常：' + p.state;
    }
  }

  function paintChannels() {
    var bar = el('qr-channels');
    // 只有 QQ 有两种码；其余平台隐藏切换条。
    bar.hidden = currentSource !== 'qq';
    var setActive = function (id, on) {
      var b = el(id);
      if (b) b.classList.toggle('active', on);
    };
    setActive('qr-ch-qq', currentChannel === 'qq');
    setActive('qr-ch-wx', currentChannel === 'wx');
  }

  // ── 可登录音源清单与选择条 ─────────────────────────────────────────────

  function hasAnyLoginCap(s) {
    var caps = s.caps || [];
    return caps.indexOf('cookie_login') >= 0
      || caps.indexOf('qr_login') >= 0
      || caps.indexOf('user_playlists') >= 0;
  }

  // 拉取音源清单（每次打开弹窗刷新一次，保证能力表最新）。
  async function loadLoginSources() {
    var data = await T.get('/v1/online/sources');
    loginSources = (data.sources || []).filter(hasAnyLoginCap);
    paintSourceTabs();
    return loginSources;
  }

  function sourceLabel(id) {
    var s = loginSources.filter(function (x) { return x.id === id; })[0];
    return s ? s.label : id;
  }

  // 并发拉取各源账号态：未登录/失败一律按未登录（绝不弹错打扰）。
  async function loadAccounts() {
    accountsById = {};
    await Promise.all(
      loginSources.map(async function (s) {
        try {
          var acc = await T.get(
            '/v1/online/account?source=' + encodeURIComponent(s.id)
          );
          if (acc && (acc.nickname || acc.avatar)) accountsById[s.id] = acc;
        } catch (e) { /* 未登录，忽略 */ }
      })
    );
    refreshTopAvatar();
  }

  /// 取账号头像的可展示 URL（走 Online.safeCoverUrl 归一化），无则 null。
  function avatarUrlOf(source) {
    var acc = accountsById[source];
    if (!acc || !acc.avatar || !window.Online) return null;
    return window.Online.safeCoverUrl(acc.avatar);
  }

  /// 根据当前已登录账号与用户选择，刷新顶栏头像。
  /// 规则：选中源仍登录 → 用它；否则若只有一个已登录源 → 用它；
  /// 否则回退默认人形图标。
  function refreshTopAvatar() {
    var loggedIds = Object.keys(accountsById);
    var pick = null;
    if (selectedAvatarSource && accountsById[selectedAvatarSource]) {
      pick = selectedAvatarSource;
    } else if (loggedIds.length === 1) {
      pick = loggedIds[0];
    }
    var face = el('online-account-face');
    var dot = el('online-account-dot');
    var url = pick ? avatarUrlOf(pick) : null;
    if (url) {
      face.classList.add('has-avatar');
      applyBg(face, url);
      dot.hidden = false; // 有头像时角标可作在线指示
    } else {
      face.classList.remove('has-avatar');
      face.style.backgroundImage = '';
      dot.hidden = true;
    }
  }

  /// 把某个已登录源设为顶栏头像（弹窗内操作）。
  function selectTopAvatar(source) {
    selectedAvatarSource = source;
    writeSelectedAvatar(source);
    refreshTopAvatar();
  }

  function paintSourceTabs() {
    var box = el('qr-sources');
    box.innerHTML = '';
    loginSources.forEach(function (s) {
      var acc = accountsById[s.id];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qr-source' + (acc ? ' is-in' : '');
      b.dataset.source = s.id;

      if (acc) {
        // 已登录：显示头像 + 昵称；点击直接进该源（不再要求登录）。
        var av = document.createElement('span');
        av.className = 'qr-source-av';
        var url = acc.avatar && window.Online
          ? window.Online.safeCoverUrl(acc.avatar)
          : null;
        if (url) {
          var img = new Image();
          applyImg(img, url);
          img.alt = '';
          av.appendChild(img);
        } else {
          av.classList.add('is-missing');
          av.textContent = (acc.nickname || s.id).slice(0, 1).toUpperCase();
        }
        b.appendChild(av);
        var nm = document.createElement('span');
        nm.className = 'qr-source-nm';
        nm.textContent = acc.nickname || s.label;
        b.appendChild(nm);
        b.onclick = function () {
          if (currentSource !== s.id) enterLoggedIn(s.id);
        };
      } else {
        // 未登录：显示平台名，点击走登录取码。
        b.textContent = s.label;
        b.onclick = function () {
          if (currentSource !== s.id) start(s.id, 'qq');
        };
      }
      box.appendChild(b);
    });
  }

  function paintSourceActive() {
    var tabs = el('qr-sources').querySelectorAll('.qr-source');
    Array.prototype.forEach.call(tabs, function (b) {
      b.classList.toggle('active', b.dataset.source === currentSource);
    });
  }

  /// 打开统一登录弹窗。不指定 source 时：若只有一个已登录源默认进它，
  /// 否则默认选清单第一个源；已登录源直接展示账号信息，不再要求登录。
  async function open(source) {
    T = window.VMusicTransport;
    // 标记弹窗打开：隐藏 .app，从根本上杜绝页面内任何元素（含带动画/
    // transform 的层叠上下文）穿透遮挡弹窗。
    document.documentElement.classList.add('qr-modal-open');
    el('qr-modal').hidden = false;
    el('qr-status').textContent = '正在加载音源…';
    el('qr-canvas').innerHTML = '';
    try {
      var list = await loadLoginSources();
      if (!list.length) {
        el('qr-status').textContent = '当前没有可登录的音源';
        return;
      }
      await loadAccounts();
      // 弹窗里也要以服务端为准（另开标签页改过选择时这里能跟上）。
      await loadSelectedAvatar();
      paintSourceTabs();
      refreshTopAvatar();
      // 选目标源：显式指定 > 唯一已登录源 > 清单第一个。
      var loggedInIds = list
        .map(function (s) { return s.id; })
        .filter(function (id) { return accountsById[id]; });
      var pick;
      if (source && list.some(function (s) { return s.id === source; })) {
        pick = source;
      } else if (loggedInIds.length === 1) {
        pick = loggedInIds[0];
      } else {
        pick = list[0].id;
      }
      if (accountsById[pick]) enterLoggedIn(pick);
      else await start(pick, 'qq');
    } catch (e) {
      el('qr-status').textContent = '加载音源失败：' + (e && e.message ? e.message : '网络错误');
    }
  }

  /// 进入一个已登录源：不显示二维码，展示头像/昵称与退出按钮。
  function enterLoggedIn(source) {
    var acc = accountsById[source];
    stopPolling();
    currentSource = source;
    currentTicket = null;
    el('qr-title').textContent = sourceLabel(source);
    paintSourceActive();
    // QQ 的 QQ/微信渠道条在已登录态无意义，隐藏。
    el('qr-channels').hidden = true;
    var box = el('qr-canvas');
    box.style.opacity = '1';
    box.style.cursor = 'default';
    box.onclick = null;
    box.innerHTML = '';

    var panel = document.createElement('div');
    panel.className = 'qr-logged-in';

    var av = document.createElement('div');
    av.className = 'qr-logged-av';
    var url = acc.avatar && window.Online ? window.Online.safeCoverUrl(acc.avatar) : null;
    if (url) {
      var img = new Image();
      applyImg(img, url); img.alt = '';
      av.appendChild(img);
    } else {
      av.classList.add('is-missing');
      av.textContent = (acc.nickname || source).slice(0, 1).toUpperCase();
    }
    panel.appendChild(av);

    var nick = document.createElement('div');
    nick.className = 'qr-logged-nick';
    nick.textContent = acc.nickname || sourceLabel(source);
    panel.appendChild(nick);

    var hint = document.createElement('div');
    hint.className = 'qr-logged-hint';
    hint.textContent = '已登录，无需再次扫码';
    panel.appendChild(hint);

    // 「设为顶栏头像」：把该平台头像展示到右上角。已是当前展示源时标注。
    var useAv = document.createElement('button');
    useAv.type = 'button';
    useAv.className = 'btn qr-use-avatar';
    var isCurrent = selectedAvatarSource === source;
    useAv.textContent = isCurrent ? '✓ 已在右上角展示' : '在右上角展示此头像';
    useAv.onclick = function () {
      selectTopAvatar(source);
      enterLoggedIn(source); // 重绘按钮态
    };
    panel.appendChild(useAv);

    var logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'btn qr-logged-out';
    logout.textContent = '退出登录';
    logout.onclick = function () { logoutOf(source); };
    panel.appendChild(logout);

    box.appendChild(panel);
    el('qr-status').textContent = '';
  }

  /// 退出某源：清空后端凭据后重绘弹窗（该源回到未登录入口）。
  async function logoutOf(source) {
    el('qr-status').textContent = '正在退出…';
    try {
      await T.post('/v1/online/cookie', { source: source, cookie: '' });
    } catch (e) {
      el('qr-status').textContent = '退出失败：' + (e && e.message ? e.message : '网络错误');
      return;
    }
    delete accountsById[source];
    // 若退出的正是顶栏展示头像的源，清掉选择（refreshTopAvatar 会
    // 自动回退到唯一剩余的已登录源或默认图标）。
    if (selectedAvatarSource === source) {
      selectedAvatarSource = null;
      writeSelectedAvatar(null);
    }
    if (window.OnlinePlaylists) window.OnlinePlaylists.refresh();
    refreshTopAvatar();
    paintSourceTabs();
    // 回到该源的未登录登录取码视图。
    await start(source, 'qq');
  }

  async function start(source, channel) {
    // 账号区按钮直接调 start()（不经 open()），T 必须在这里也绑定一次，
    // 否则首次点「扫码登录」时 T 为 null。
    T = window.VMusicTransport;
    // 渠道/音源切换重入：先把上一张票作废，避免服务端留孤儿会话。
    if (currentTicket) {
      T.post('/v1/online/qr/cancel', {
        source: currentSource,
        ticket: currentTicket,
      }).catch(function () {});
    }
    stopPolling();
    currentSource = source;
    currentTicket = null;
    currentChannel = channel || 'qq';
    el('qr-title').textContent = sourceLabel(source) + ' 登录';
    el('qr-status').textContent = '正在生成二维码…';
    paintSourceTabs();
    paintSourceActive();
    paintChannels();
    var box = el('qr-canvas');
    box.style.opacity = '1';
    box.style.cursor = 'default';
    box.onclick = null;
    box.innerHTML = '';
    el('qr-cookie-input').value = '';
    document.documentElement.classList.add('qr-modal-open');
    el('qr-modal').hidden = false;
    var s;
    try {
      s = await T.post('/v1/online/qr/start', {
        source: source,
        channel: currentChannel,
      });
    } catch (e) {
      // 该源此刻取不到扫码（平台侧问题/能力闸门）：保留弹窗，引导走 cookie。
      el('qr-status').textContent =
        '暂取不到二维码：' + (e && e.message ? e.message : '该平台可能限制了扫码') +
        '；可展开下面的 cookie 登录';
      return;
    }
    renderQr(s);
  }

  function close() {
    stopPolling();
    el('qr-modal').hidden = true;
    // 解除背景隔离，恢复 .app 显示。
    document.documentElement.classList.remove('qr-modal-open');
    var box = el('qr-canvas');
    box.onclick = null;
    box.style.opacity = '1';
    el('qr-cookie-input').value = '';
    if (currentSource) {
      // 传真实票据让服务端立即删掉会话；票据可能为空（start 失败就关窗），
      // 后端对空票按幂等成功处理。
      var payload = { source: currentSource, ticket: currentTicket || '' };
      currentSource = null;
      currentTicket = null;
      T.post('/v1/online/qr/cancel', payload).catch(function () {});
    }
  }

  el('qr-close').onclick = close;
  // 点击弹窗外的遮罩空白处关闭；点卡片内部不关闭（target 是遮罩本身才算）。
  el('qr-modal').addEventListener('mousedown', function (e) {
    if (e.target === el('qr-modal')) close();
  });
  // Esc 关闭，符合弹窗惯例。
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el('qr-modal').hidden) close();
  });
  // QQ/微信切换：用新渠道重新取码（旧会话随 close 逻辑在 start 里弃用）。
  el('qr-ch-qq').onclick = function () {
    if (currentChannel !== 'qq') start(currentSource, 'qq');
  };
  el('qr-ch-wx').onclick = function () {
    if (currentChannel !== 'wx') start(currentSource, 'wx');
  };
  el('qr-cookie-save').onclick = async function () {
    var source = currentSource;
    var cookie = el('qr-cookie-input').value.trim();
    if (!source || !cookie) return;
    var btn = this;
    btn.disabled = true;
    var res;
    try {
      res = await T.post('/v1/online/cookie', { source: source, cookie: cookie });
    } catch (e) {
      el('qr-status').textContent = '保存失败：' + e.message;
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    // 后端回读 cred 包按平台判据给结论：存进去不等于登录成功
    // （缺 MUSIC_U / qm_keyst / token 的包各平台仍按未登录处理）。
    // 绝不能在 false 时关窗假装成功。
    if (res && res.signedIn) {
      close();
      if (window.OnlinePlaylists) window.OnlinePlaylists.refresh();
      if (window.toast) window.toast(source + ' 登录成功');
    } else {
      el('qr-status').textContent = 'cookie 已保存，但平台未判定为登录态，请检查后重试';
    }
  };

  /// 启动恢复：拉音源清单 + 账号态 + 服务端持久化的顶栏头像选择，重绘顶栏。
  ///
  /// app.js 在 boot 里调用。此前 refreshTopAvatar 只挂在「打开登录弹窗」上，
  /// 服务重启后不打开弹窗就一直是默认人形图标——这是选择「看起来丢了」的
  /// 另一半原因（另一半是只存 localStorage 而端口每次都变）。
  /// 顶栏头像属锦上添花，这里失败一律静默，不打扰启动。
  async function init() {
    T = window.VMusicTransport;
    try {
      var list = await loadLoginSources();
      if (!list.length) return;
      await loadAccounts();
      await loadSelectedAvatar();
      refreshTopAvatar();
    } catch (e) { /* 静默 */ }
  }

  window.OnlineLogin = {
    init: init,
    open: open,
    start: start,
    close: close,
    stopPolling: stopPolling,
  };
})();
