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
  // 一次登录意图 = source + channel + ticket，随 attempt 一起作废旧的。
  // 取码、轮询、手动 cookie 提交都属同一次意图：慢请求下 A 的响应可能在切到 B
  // 之后才回来，若用「当前 source」配「这张迟到的 ticket」去轮询，平台票跨平台
  // 根本无效；关窗后也还会多出一个后台轮询。所以每次网络收尾都先核对 attempt。
  var intent = { attempt: 0, source: null, channel: 'qq', ticket: null };
  var spaceView = null;
  function mountSpace(options) {
    if (spaceView || !options || options.presentation !== 'space' || !options.container) return;
    var modal = el('qr-modal'), card = modal.querySelector('.qr-card');
    var view = spaceView = { parent:modal.parentNode,next:modal.nextSibling,inert:modal.inert,focus:document.activeElement,
      children:Array.from(card.children),background:[],mode:'qr',events:new AbortController() };
    Array.from(options.container.children).forEach(function(node){if(node.tagName==='SCRIPT')return;view.background.push({node:node,inert:node.inert});node.inert=true;});
    options.container.appendChild(modal); modal.inert=false; modal.classList.add('qr-space');
    var scroll=document.createElement('div');scroll.className='qs-scroll';card.appendChild(scroll);view.scroll=scroll;
    var graph = document.createElement('div'); graph.className='qs-graph';
    graph.innerHTML='<svg class="qs-links" aria-hidden="true"><path class="qs-link" pathLength="1"/><path class="qs-signal"/><path class="qs-drag"/></svg><div class="qs-hub"><span class="qs-port qs-in" aria-hidden="true"></span><span class="qs-hub-mark">hz</span><strong>Hertz Studio</strong><small class="qs-connection">选择音源</small><div class="qs-modes" role="group" aria-label="登录方式"><button type="button" data-mode="qr">扫码</button><button type="button" data-mode="cookie">Cookie</button></div></div>';
    graph.prepend(el('qr-sources')); scroll.appendChild(graph); view.graph=graph;
    var drawer=document.createElement('div'); drawer.className='qs-drawer';
    view.children.forEach(function(node){if(node.id!=='qr-sources'&&node.id!=='qr-close')drawer.appendChild(node);});scroll.appendChild(drawer);view.drawer=drawer;
    var actions=document.createElement('div');actions.className='qs-actions';
    var skip=document.createElement('button');skip.type='button';skip.textContent='先搜索一首歌';skip.onclick=function(){close();if(window.SpaceHome)SpaceHome.focusSearch();};
    var connect=document.createElement('button');connect.type='button';connect.className='qs-connect';connect.textContent='开始登录';connect.onclick=function(){if(intent.source)start(intent.source,intent.channel);};
    actions.append(skip,connect);drawer.appendChild(actions);view.connect=connect;
    graph.querySelectorAll('[data-mode]').forEach(function(button){button.onclick=function(){selectSpaceSource(intent.source,button.dataset.mode);};});
    graph.addEventListener('pointerdown',function(event){
      var port=event.target.closest('.qs-out');if(!port)return;event.preventDefault();
      var source=port.closest('[data-source]').dataset.source;graph.setPointerCapture(event.pointerId);view.drag={source:source,id:event.pointerId,port:port};graph.classList.add('is-dragging');drawSpaceLink(event);
    },{signal:view.events.signal});
    graph.addEventListener('pointermove',function(event){if(view.drag)drawSpaceLink(event);},{signal:view.events.signal});
    graph.addEventListener('pointerup',function(event){
      if(!view.drag)return;var hub=graph.querySelector('.qs-hub').getBoundingClientRect(),drag=view.drag;view.drag=null;
      if(graph.hasPointerCapture(event.pointerId))graph.releasePointerCapture(event.pointerId);
      graph.querySelector('.qs-drag').removeAttribute('d');
      graph.classList.remove('is-dragging','is-drop-target');
      if(event.clientX>=hub.left&&event.clientX<=hub.right&&event.clientY>=hub.top&&event.clientY<=hub.bottom)selectSpaceSource(drag.source,view.mode);
    },{signal:view.events.signal});
    graph.addEventListener('pointercancel',function(){view.drag=null;graph.querySelector('.qs-drag').removeAttribute('d');graph.classList.remove('is-dragging','is-drop-target');},{signal:view.events.signal});
    window.addEventListener('resize',function(){drawSpaceLink();},{signal:view.events.signal});
    view.resize=new ResizeObserver(function(){if(spaceView===view)drawSpaceLink();});view.resize.observe(graph);
    matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change',function(event){if(event.matches&&view.linkAnimation)view.linkAnimation.cancel();},{signal:view.events.signal});
    modal.addEventListener('keydown',function(event){
      if(event.key!=='Tab')return;
      var nodes=Array.from(modal.querySelectorAll('button:not(:disabled),input,textarea,a[href],summary')).filter(function(node){return node.getClientRects().length;});
      var first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    },{signal:view.events.signal});
    requestAnimationFrame(function(){el('qr-close').focus();});
  }
  function unmountSpace() {
    if(!spaceView)return;var view=spaceView;spaceView=null;view.events.abort();view.resize.disconnect();if(view.linkAnimation)view.linkAnimation.cancel();
    var modal=el('qr-modal'),card=modal.querySelector('.qr-card');
    view.children.forEach(function(node){card.appendChild(node);});view.scroll.remove();
    modal.classList.remove('qr-space');view.parent.insertBefore(modal,view.next&&view.next.parentNode===view.parent?view.next:null);modal.inert=view.inert;
    view.background.forEach(function(item){item.node.inert=item.inert;});if(view.focus&&view.focus.isConnected)view.focus.focus({preventScroll:true});
  }
  function drawSpaceLink(pointer) {
    if(!spaceView)return;var graph=spaceView.graph,rect=graph.getBoundingClientRect();
    var selected=Array.from(el('qr-sources').children).find(function(node){return node.dataset.source===intent.source;});
    var port=pointer&&spaceView.drag?spaceView.drag.port:selected&&selected.querySelector('.qs-out');if(!port)return;
    var from=port.getBoundingClientRect(),to=graph.querySelector('.qs-in').getBoundingClientRect();
    var x=from.left+from.width/2-rect.left,y=from.top+from.height/2-rect.top;
    var endX=pointer?pointer.clientX-rect.left:to.left+to.width/2-rect.left,endY=pointer?pointer.clientY-rect.top:to.top+to.height/2-rect.top;
    var bend=Math.max(12,Math.abs(endX-x)*.48);
    var d='M'+x+','+y+' C'+(x+bend)+','+y+' '+(endX-bend)+','+endY+' '+endX+','+endY;
    var link=graph.querySelector(pointer?'.qs-drag':'.qs-link');link.setAttribute('d',d);
    if(pointer){
      var hub=graph.querySelector('.qs-hub').getBoundingClientRect();
      graph.classList.toggle('is-drop-target',pointer.clientX>=hub.left&&pointer.clientX<=hub.right&&pointer.clientY>=hub.top&&pointer.clientY<=hub.bottom);
    }else{
      graph.querySelector('.qs-signal').setAttribute('d',d);graph.classList.add('is-connected');
      var key=intent.source+'|'+spaceView.mode;
      if(spaceView.linkKey!==key){
        spaceView.linkKey=key;if(spaceView.linkAnimation)spaceView.linkAnimation.cancel();
        if(!matchMedia('(prefers-reduced-motion:reduce)').matches&&!document.body.matches('.reduce-motion,[data-rm~="ui"]'))spaceView.linkAnimation=link.animate([{strokeDashoffset:1},{strokeDashoffset:0}],{duration:650,easing:'cubic-bezier(.2,.8,.2,1)'});
      }
    }
  }
  function selectSpaceSource(source,mode) {
    if(!spaceView||!source)return;
    var definition=loginSources.find(function(item){return item.id===source;});if(!definition)return;
    var prev=intent;beginIntent(source,'qq');if(prev.ticket)cancelTicket(prev.source,prev.ticket);stopPolling();
    var caps=definition.caps||[];var logged=!!accountsById[source];
    spaceView.mode=(!logged&&((mode==='cookie'&&caps.indexOf('cookie_login')>=0)||caps.indexOf('qr_login')<0))?'cookie':'qr';
    // 已登录的源也必须走这一整段 chrome 更新。以前它在这里提前 return，hub
    // 一直停在「选择音源」、端口不亮，用户看不出这个平台其实已经接上了；
    // 而且从它切到别的源时，下面的账号面板不会被清掉，看着像没切成功。
    spaceView.graph.querySelector('.qs-connection').textContent=sourceLabel(source)+' · 已接入';
    spaceView.graph.classList.toggle('is-signed-in',logged);
    spaceView.graph.querySelectorAll('[data-mode]').forEach(function(button){button.disabled=caps.indexOf(button.dataset.mode==='qr'?'qr_login':'cookie_login')<0;button.setAttribute('aria-pressed',String(button.dataset.mode===spaceView.mode));});
    el('qr-title').textContent=sourceLabel(source)+(logged?'':' 登录');
    var box=el('qr-canvas');box.innerHTML='';box.hidden=false;box.style.opacity='1';box.style.cursor='default';box.onclick=null;
    el('qr-channels').hidden=true;
    el('qr-cookie-panel').hidden=spaceView.mode!=='cookie';el('qr-cookie-panel').open=spaceView.mode==='cookie';
    el('qr-cookie-input').value='';el('qr-cookie-save').disabled=false;
    el('qr-status').textContent='';
    spaceView.drawer.classList.add('is-connected');
    paintSourceActive();renderLoginGuide(definition);
    if(logged){
      enterLoggedIn(source);spaceView.connect.hidden=true;
      requestAnimationFrame(function(){drawSpaceLink();});return;
    }
    if(spaceView.mode==='cookie'){
      box.hidden=true;spaceView.connect.hidden=true;
      el('qr-status').textContent='此平台使用 cookie 登录，请填写下方表单';
      requestAnimationFrame(function(){drawSpaceLink();});return;
    }
    // 选到未登录的扫码源就直接取码。以前停在「等待开始扫码」，要再点一次
    // 「开始登录」才出码，二维码从来不是默认状态；该按钮改作「刷新二维码」。
    spaceView.connect.hidden=false;
    start(source,'qq').catch(function(e){if(window.console)console.warn('取二维码失败：',e);});
    requestAnimationFrame(function(){drawSpaceLink();});
  }
  function beginIntent(source, channel) {
    intent = {
      attempt: intent.attempt + 1,
      source: source,
      channel: channel || 'qq',
      ticket: null,
    };
    return intent;
  }
  function voidIntent() { intent = beginIntent(null, 'qq'); }
  function isCurrent(attempt) { return attempt === intent.attempt; }
  /// 作废服务端会话。source/ticket 一律用调用方自己那份，不读「当前」字段：
  /// 迟到的票要取消的是它自己的会话。后端对空票按幂等成功处理。
  function cancelTicket(source, ticket) {
    if (!source || !T) return;
    T.post('/v1/online/qr/cancel', { source: source, ticket: ticket || '' })
      .catch(function () { /* 作废失败不回滚：服务端随票据过期自行清理 */ });
  }
  // 可登录音源清单（来自 /v1/online/sources，只保留有任一登录能力的源）。
  var loginSources = [];
  // 各源已登录账号：source -> AccountInfo（未登录的源不在表里）。
  var accountsById = {};
  // 只给已确认的凭据变更排序，防旧账号探测/注销覆盖后来成功的同源登录。
  // 属于本模块账号快照的提交校验，不参与服务端授权判断。
  var accountRevisions = {};
  function accountRevision(source) { return accountRevisions[source] || 0; }
  function accountChanged(source) { accountRevisions[source] = accountRevision(source) + 1; }
  function accountVerdict(error) {
    if (window.Online && window.Online.accountVerdict) return window.Online.accountVerdict(error);
    return error && (error.code === 'auth_required' || error.status === 401 || error.status === 403)
      ? 'signed-out' : 'unknown';
  }
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
    } catch (e) { /* 隐私模式/配额满：写不进镜像就只留内存，不影响本次会话 */ }
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
  async function loadSelectedAvatar(attempt) {
    var selected = selectedAvatarSource;
    var remote = null;
    try {
      var s = await T.get('/v1/settings');
      var v = s ? s[TOP_AV_SETTING] : null;
      if (typeof v === 'string' && v) remote = v;
    } catch (e) { /* 读不到就退回镜像 */ }
    if (!isCurrent(attempt) || selected !== selectedAvatarSource) return;
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
  // 扫只会打开网页（用户实测会跳到 QQ 音乐 PC 首页）。汽水的码由抖音 Passport
  // 签发，上游文案写着「请使用「抖音 APP」扫码验证」，但那是错的——抖音扫只会
  // 回「请用汽水音乐 App 扫码」，实测扫上的是汽水 App（轮询里 scan_app_id 8478）。
  var SCAN_APP = {
    netease: '网易云音乐 App',
    qq: '手机 QQ（不是 QQ 音乐 App）',
    kugou: '酷狗音乐 App',
    qishui: '汽水音乐 App',
  };
  function scanApp(source, channel) {
    if (source === 'qq' && channel === 'wx') return '微信';
    return SCAN_APP[source] || '对应平台的 App';
  }

  /// 「怎么弄到这份 cookie」按音源渲染。数据来自 /v1/online/sources 的 login 字段
  /// （官网地址 + 后端判登录态实际认的字段名），这里不按音源名特判——SourceInfo
  /// 的契约就是「前端只认这张表，不硬编码任何音源名」。
  /// 步骤六个站是同一套：唯一可靠、且不受 httpOnly 影响的取法是从 DevTools 的
  /// Network 里拷请求头那整行，所以文案写死在这里、只让站点与字段随源变。
  function renderLoginGuide(definition) {
    var guide = el('qr-login-guide');
    var login = definition.login;
    if (!login || !login.site) {
      guide.hidden = true;
      guide.innerHTML = '';
      el('qr-cookie-help').textContent = '先在平台官网完成登录，再复制该平台的 cookie。';
      return;
    }
    var keys = (login.keys || []).filter(Boolean);
    guide.innerHTML = '<div class="qr-guide-site"><code class="qr-guide-url"></code>'
      + '<button type="button" class="qr-guide-copy">复制地址</button></div>'
      + '<ol class="qr-guide-steps">'
      + '<li>先在这个站点登录好账号（扫码或手机号验证码都行）。</li>'
      + '<li>按 <kbd>F12</kbd> 打开开发者工具，切到 <b>Network / 网络</b> 面板。</li>'
      + '<li>刷新页面，点列表里任意一条发往该站点的请求。</li>'
      + '<li>在 <b>Request Headers</b> 里找到 <code>cookie:</code> 那一行，把冒号后面的整串复制过来。'
      + '<b>别用 Console 里的 document.cookie</b>：登录态字段大多是 httpOnly，那样根本拷不到。</li>'
      + '</ol>'
      + (keys.length ? '<p class="qr-guide-keys"></p>' : '');
    // 站点与字段名一律走 textContent：它们来自后端表，不该变成可注入的标记。
    guide.querySelector('.qr-guide-url').textContent = login.site;
    var keyLine = guide.querySelector('.qr-guide-keys');
    if (keyLine) {
      keyLine.textContent = '本平台判登录态只认这些字段：' + keys.join(' / ')
        + '。整串照抄最省事；只拷到其中一两个也能用，少一个就会存成「未登录」。';
    }
    var copy = guide.querySelector('.qr-guide-copy');
    copy.onclick = function () {
      var done = function (ok) {
        copy.textContent = ok ? '已复制' : '复制失败，请手动选中';
        setTimeout(function () { copy.textContent = '复制地址'; }, 1800);
      };
      // 契约沙箱只加载本模块、没有 app.js，所以拿不到 HertzClipboard 时退回
      // navigator.clipboard——即独立形态的同款行为。
      var write = (window.HertzClipboard && window.HertzClipboard.write)
        || function (t) { return navigator.clipboard.writeText(t); };
      Promise.resolve().then(function () { return write(login.site); }).then(
        function () { done(true); }, function () { done(false); });
    };
    guide.hidden = false;
    el('qr-cookie-help').textContent = '把上面拷到的整串粘贴到这里，保存后立即生效。';
  }
  /// 上游拒绝这次扫码时的说法。默认那句「平台拒绝了」对汽水不准：汽水是
  /// 手机已确认、服务端却发不出会话（交付要官方客户端签名，本机没有浏览器
  /// 内核），说清成因用户才不会再去换个 App 反复扫。
  var REJECT_TEXT = {
    qishui: '汽水音乐已确认扫码，但登录态要官方客户端签名才能下发，本机做不到，请用下方「手动粘贴 cookie」登录',
  };

  function el(id) { return document.getElementById(id); }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }
  /// 扫码走到终态就把 cookie 面板展开：文案在让用户「改用下方手动粘贴 cookie」，
  /// 面板却还折叠着，等于让他先找一个没见过的控件去哪了。
  function openCookieFallback() {
    if(spaceView){
      var definition=loginSources.find(function(item){return item.id===intent.source;});
      if(definition&&(definition.caps||[]).indexOf('cookie_login')>=0)selectSpaceSource(intent.source,'cookie');
    }else el('qr-cookie-panel').open = true;
  }

  function renderQr(start, mine) {
    if (!isCurrent(mine.attempt)) {
      // 迟到的票：服务端会话已经建起来了，按它自己的 source 尽力作废，
      // 但不画二维码、也不起轮询——用户早就切走或关窗了。
      if (start.ticket) cancelTicket(mine.source, start.ticket);
      return;
    }
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
    intent.ticket = start.ticket;
    schedulePoll(mine, start.poll_ms || 2000);
  }

  function schedulePoll(mine, ms) {
    if (!isCurrent(mine.attempt)) return;
    stopPolling();
    pollTimer = setTimeout(function () { poll(mine, ms); }, ms);
  }

  async function poll(mine, ms) {
    var p;
    try {
      p = await T.get('/v1/online/qr/poll?source=' + encodeURIComponent(mine.source)
        + '&ticket=' + encodeURIComponent(mine.ticket));
    } catch (e) {
      if (!isCurrent(mine.attempt)) return;
      // 服务端业务错误（换票失败、风控等）要把原文显示出来，不能笼统当
      // 网络问题无限重试，否则用户无法判断发生了什么。
      el('qr-status').textContent = '请求失败：' + (e && e.message ? e.message : '网络异常') + '（3s 后重试）';
      schedulePoll(mine, 3000);
      return;
    }
    if (!isCurrent(mine.attempt)) return;
    if (p.state === 'waiting') {
      el('qr-status').textContent = '请用' + scanApp(mine.source, mine.channel) + '扫码登录';
      schedulePoll(mine, ms);
    } else if (p.state === 'scanned') {
      el('qr-status').textContent = '已扫码，请在手机上确认登录';
      schedulePoll(mine, ms);
    } else if (p.state === 'confirmed') {
      accountChanged(mine.source);
      stopPolling();
      el('qr-status').textContent = '登录成功';
      close();
      init();
      if (window.OnlinePlaylists) window.OnlinePlaylists.refresh();
    } else if (p.state === 'rejected') {
      // 上游明确拒绝这次扫码（如网易云 8821、汽水交付失败 2156）：不是"再等等"，
      // 对同一枚票再问只会拿到同一句，直接停下并引导走手动 cookie。
      stopPolling();
      openCookieFallback();
      el('qr-status').textContent = REJECT_TEXT[mine.source]
        || '该平台拒绝了这次扫码登录，请改用下方手动 cookie 登录';
    } else if (p.state === 'mfa_required') {
      // 上游要求二次验证（汽水音乐 2046），而那一步要在官方 JS 环境里跑，
      // 本地服务没有浏览器内核：这条码走不通，如实说清并指向 cookie 导入。
      stopPolling();
      openCookieFallback();
      el('qr-status').textContent = '该平台要求二次安全验证，本机无法完成，请改用下方手动 cookie 登录';
    } else if (p.state === 'expired') {
      stopPolling();
      el('qr-status').textContent = '二维码已过期，点击二维码刷新';
      var box = el('qr-canvas');
      box.style.opacity = '.4';
      box.style.cursor = 'pointer';
      box.onclick = function () { start(mine.source, mine.channel); };
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
    bar.hidden = intent.source !== 'qq';
    var setActive = function (id, on) {
      var b = el(id);
      if (b) b.classList.toggle('active', on);
    };
    setActive('qr-ch-qq', intent.channel === 'qq');
    setActive('qr-ch-wx', intent.channel === 'wx');
  }

  // ── 可登录音源清单与选择条 ─────────────────────────────────────────────

  function hasAnyLoginCap(s) {
    var caps = s.caps || [];
    return caps.indexOf('cookie_login') >= 0
      || caps.indexOf('qr_login') >= 0
      || caps.indexOf('user_playlists') >= 0;
  }

  // 拉取音源清单（每次打开弹窗刷新一次，保证能力表最新）。
  async function loadLoginSources(attempt) {
    var data = await T.get('/v1/online/sources');
    if (!isCurrent(attempt)) return [];
    loginSources = (data.sources || []).filter(hasAnyLoginCap);
    paintSourceTabs();
    return loginSources;
  }

  function sourceLabel(id) {
    var s = loginSources.filter(function (x) { return x.id === id; })[0];
    return s ? s.label : id;
  }

  // 并发拉取各源账号态。没登录的源（401/403）按未登录处理；**探测没出结果**
  // （上游 5xx / 超时 / 网络故障）不算授权断言（A6）：留着上一次的账号身份与
  // 顶栏头像，别把「没探到」显示成「没登录」而催用户重扫。
  async function loadAccounts(attempt) {
    var prev = accountsById;
    var next = {};
    var revisions = {};
    await Promise.all(
      loginSources.map(async function (s) {
        revisions[s.id] = accountRevision(s.id);
        var acc = null;
        var verdict = 'unknown';
        try {
          acc = await T.get(
            '/v1/online/account?source=' + encodeURIComponent(s.id)
          );
          verdict = 'ok';
        } catch (e) {
          verdict = accountVerdict(e);
        }
        if (verdict === 'ok' && acc && (acc.nickname || acc.avatar)) next[s.id] = acc;
        else if (verdict === 'unknown' && prev[s.id]) next[s.id] = prev[s.id];
      })
    );
    if (!isCurrent(attempt)) return;
    Object.keys(revisions).forEach(function (source) {
      if (revisions[source] === accountRevision(source)) return;
      // 凭据在探测途中发生了已确认的变化，沿用变更后的快照，不复活旧身份。
      if (accountsById[source]) next[source] = accountsById[source];
      else delete next[source];
    });
    accountsById = next;
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
    var spaceAccount = el('sp-account');
    if (spaceAccount) {
      spaceAccount.classList.toggle('has-avatar',!!url); applyBg(spaceAccount,url);
      spaceAccount.title=pick ? (accountsById[pick].nickname || sourceLabel(pick)) : '登录音源';
      spaceAccount.setAttribute('aria-label',spaceAccount.title);
    }
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

  /// 每个登录行前面的平台徽标。与搜索结果 / 歌单菜单共用 Online.badge 那一
  /// 份官方 app 图标表，别在登录弹窗里再抄一份平台名单；独立形态（契约沙箱）
  /// 拿不到 Online 时用平台名首字兜底，至少这一列不是空的。
  function platformBadge(s) {
    var b=(window.Online&&window.Online.badge)?window.Online.badge(s.id,s.label):null;
    if(!b){
      b=document.createElement('span');b.className='qs-brand-fallback';
      b.textContent=(s.label||s.id).slice(0,1);b.title=s.label||s.id;
      b.setAttribute('aria-label',b.title);
    }
    // 官方 PNG 只在 full 构建里内嵌；裁剪版（或图片加载失败）会 404，
    // 徽标就变成一块空白。补一个平台首字，图标位至少还是可辨认的。
    var img=b.querySelector&&b.querySelector('img');
    if(img){
      var fallback=function(){
        b.classList.remove('is-img');b.classList.add('qs-brand-fallback');
        b.textContent=(s.label||s.id).slice(0,1);
      };
      img.onerror=fallback;
      // 缓存里已经失败过的图不会再触发 onerror，挂载时补判一次。
      if(img.complete&&!img.naturalWidth)fallback();
    }
    return b;
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
      b.title = s.label;
      b.appendChild(platformBadge(s));
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
          if (intent.source !== s.id) enterLoggedIn(s.id);
        };
      } else {
        // 未登录：显示平台名。不能再写 b.textContent —— 那会把前面刚挂上的
        // 平台徽标一并清掉，整列又回到光秃秃的文字。
        var label = document.createElement('span');
        label.className = 'qs-label';
        label.textContent = s.label;
        b.appendChild(label);
        b.onclick = function () {
          if (intent.source !== s.id) start(s.id, 'qq');
        };
      }
      box.appendChild(b);
      if (spaceView) {
        var port=document.createElement('span');port.className='qs-port qs-out';port.title='连接到 Hertz Studio';b.appendChild(port);
        b.onclick=function(){selectSpaceSource(s.id,spaceView.mode);};
      }
    });
  }

  function paintSourceActive() {
    var tabs = el('qr-sources').querySelectorAll('.qr-source');
    Array.prototype.forEach.call(tabs, function (b) {
      b.classList.toggle('active', b.dataset.source === intent.source);
    });
    if(spaceView)requestAnimationFrame(function(){drawSpaceLink();});
  }

  /// 打开统一登录弹窗。不指定 source 时：若只有一个已登录源默认进它，
  /// 否则默认选清单第一个源；已登录源直接展示账号信息，不再要求登录。
  async function open(source, options) {
    T = window.VMusicTransport;
    mountSpace(options);
    var prev = intent;
    var mine = beginIntent(source || null, 'qq');
    if (prev.ticket) cancelTicket(prev.source, prev.ticket);
    stopPolling();
    // 标记弹窗打开：隐藏 .app，从根本上杜绝页面内任何元素（含带动画/
    // transform 的层叠上下文）穿透遮挡弹窗。
    document.documentElement.classList.add('qr-modal-open');
    el('qr-modal').hidden = false;
    el('qr-status').textContent = '正在加载音源…';
    el('qr-canvas').innerHTML = '';
    el('qr-canvas').onclick = null;
    el('qr-cookie-input').value = '';
    el('qr-channels').hidden = true;
    try {
      var list = await loadLoginSources(mine.attempt);
      if (!isCurrent(mine.attempt)) return;
      if (!list.length) {
        el('qr-status').textContent = '当前没有可登录的音源';
        return;
      }
      await loadAccounts(mine.attempt);
      if (!isCurrent(mine.attempt)) return;
      // 弹窗里也要以服务端为准（另开标签页改过选择时这里能跟上）。
      await loadSelectedAvatar(mine.attempt);
      // 关闭重开或直接切平台也会取代本次初始化，不能只看弹窗是否开着。
      if (!isCurrent(mine.attempt)) return;
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
      if (spaceView) selectSpaceSource(pick,'qr');
      else if (accountsById[pick]) enterLoggedIn(pick);
      else await start(pick, 'qq');
    } catch (e) {
      if (!isCurrent(mine.attempt)) return;
      el('qr-status').textContent = '加载音源失败：' + (e && e.message ? e.message : '网络错误');
    }
  }

  /// 进入一个已登录源：不显示二维码，展示头像/昵称与退出按钮。
  function enterLoggedIn(source) {
    var acc = accountsById[source];
    var prev = intent;
    // 进入已登录视图也是一次新意图：在途取码回来只许作废自己，不许把二维码
    // 画到账号面板上。
    beginIntent(source, 'qq');
    if (prev.ticket) cancelTicket(prev.source, prev.ticket);
    stopPolling();
    el('qr-title').textContent = sourceLabel(source);
    paintSourceActive();
    // QQ 的 QQ/微信渠道条在已登录态无意义，隐藏。
    el('qr-channels').hidden = true;
    var box = el('qr-canvas');
    box.hidden = false;
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
    var mine = intent;
    var revision = accountRevision(source);
    el('qr-status').textContent = '正在退出…';
    try {
      await T.post('/v1/online/cookie', { source: source, cookie: '' });
    } catch (e) {
      if (!isCurrent(mine.attempt)) return;
      el('qr-status').textContent = '退出失败：' + (e && e.message ? e.message : '网络错误');
      return;
    }
    if (window.OnlinePlaylists) window.OnlinePlaylists.refresh();
    // 已确认注销要同步身份，即使弹窗已关闭/切平台；后来成功的同源登录优先。
    if (revision === accountRevision(source)) {
      accountChanged(source);
      delete accountsById[source];
      if (selectedAvatarSource === source) {
        selectedAvatarSource = null;
        writeSelectedAvatar(null);
      }
      refreshTopAvatar();
    }
    if (!isCurrent(mine.attempt)) return;
    paintSourceTabs();
    // 回到该源的未登录登录取码视图。
    await start(source, 'qq');
  }

  async function start(source, channel) {
    // 账号区按钮直接调 start()（不经 open()），T 必须在这里也绑定一次，
    // 否则首次点「扫码登录」时 T 为 null。
    T = window.VMusicTransport;
    var prev = intent;
    var mine = beginIntent(source, channel);
    // 渠道/音源切换重入：先把上一张票作废，避免服务端留孤儿会话。
    // 作废旧票失败不回滚：服务端会随票据过期自行清理，这里只是尽量不留孤儿会话。
    if (prev.ticket) cancelTicket(prev.source, prev.ticket);
    stopPolling();
    el('qr-title').textContent = sourceLabel(source) + ' 登录';
    el('qr-status').textContent = '正在生成二维码…';
    paintSourceTabs();
    paintSourceActive();
    paintChannels();
    var box = el('qr-canvas');
    box.hidden = false;
    box.style.opacity = '1';
    box.style.cursor = 'default';
    box.onclick = null;
    box.innerHTML = '';
    el('qr-cookie-input').value = '';
    el('qr-cookie-save').disabled = false;
    document.documentElement.classList.add('qr-modal-open');
    el('qr-modal').hidden = false;
    var s;
    try {
      // 直接从账号卡进入时也先取得同一份能力表，不能用一次失败的取码请求
      // 探测登录方式。Cookie-only 平台直接进入表单。
      var definition = loginSources.filter(function (item) { return item.id === source; })[0];
      if (!definition) {
        await loadLoginSources(mine.attempt);
        if (!isCurrent(mine.attempt)) return;
        definition = loginSources.filter(function (item) { return item.id === source; })[0];
      }
      if (!definition) throw new Error('音源暂不可用，请重新打开登录窗口');
      var caps = definition.caps || [];
      var cookiePanel = el('qr-cookie-panel');
      cookiePanel.hidden = caps.indexOf('cookie_login') < 0;
      cookiePanel.open = caps.indexOf('qr_login') < 0;
      if(spaceView){cookiePanel.hidden=spaceView.mode!=='cookie';cookiePanel.open=spaceView.mode==='cookie';spaceView.connect.textContent='刷新二维码';}
      renderLoginGuide(definition);
      if (caps.indexOf('qr_login') < 0 || (spaceView && spaceView.mode==='cookie')) {
        box.hidden = true;
        el('qr-channels').hidden = true;
        el('qr-status').textContent = '此平台使用 cookie 登录，请填写下方表单';
        return;
      }
      s = await T.post('/v1/online/qr/start', {
        source: source,
        channel: mine.channel,
      });
    } catch (e) {
      // 已经被新意图取代（切平台、关窗）：这次的失败不属于当前界面。
      if (!isCurrent(mine.attempt)) return;
      // 该源此刻取不到扫码（平台侧问题/能力闸门）：保留弹窗，引导走 cookie。
      if(spaceView)openCookieFallback();
      el('qr-status').textContent =
        '暂取不到二维码：' + (e && e.message ? e.message : '该平台可能限制了扫码') +
        '；可展开下面的 cookie 登录';
      return;
    }
    renderQr(s, mine);
    if (isCurrent(mine.attempt)) el('qr-status').textContent = '请用' + scanApp(mine.source, mine.channel) + '扫码登录';
  }

  function close() {
    var prev = intent;
    // 关窗即在途失效：迟到的取码不再渲染，也不再注册轮询。
    voidIntent();
    stopPolling();
    el('qr-modal').hidden = true;
    // 解除背景隔离，恢复 .app 显示。
    document.documentElement.classList.remove('qr-modal-open');
    var box = el('qr-canvas');
    box.onclick = null;
    box.style.opacity = '1';
    el('qr-cookie-input').value = '';
    // 传真实票据让服务端立即删掉会话；票据可能为空（start 失败就关窗），
    // 后端对空票按幂等成功处理。
    cancelTicket(prev.source, prev.ticket);
    unmountSpace();
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
    if (intent.channel !== 'qq') start(intent.source, 'qq');
  };
  el('qr-ch-wx').onclick = function () {
    if (intent.channel !== 'wx') start(intent.source, 'wx');
  };
  el('qr-cookie-save').onclick = async function () {
    var mine = intent;
    var source = mine.source;
    var cookie = el('qr-cookie-input').value.trim();
    if (!source || !cookie) return;
    var btn = this;
    btn.disabled = true;
    var res;
    try {
      res = await T.post('/v1/online/cookie', { source: source, cookie: cookie });
    } catch (e) {
      if (!isCurrent(mine.attempt)) return;
      btn.disabled = false;
      el('qr-status').textContent = '保存失败：' + e.message;
      return;
    }
    // 保存端点只检查凭据形状；账号接口才确认平台是否接受这份凭据。
    var hasCredentials = !!(res && res.signedIn);
    accountChanged(source);
    var revision = accountRevision(source);
    var account = null, verificationError = null;
    if (hasCredentials) {
      if (isCurrent(mine.attempt)) el('qr-status').textContent = '凭据已保存，正在验证账号…';
      try {
        account = await T.get('/v1/online/account?source=' + encodeURIComponent(source));
        if (!account || (!account.source && !account.nickname && !account.avatar)) {
          account = null;
          throw new Error('账号响应不完整');
        }
      } catch (e) { verificationError = e; }
    }
    if (revision === accountRevision(source)) {
      if (account) accountsById[source] = account;
      else if (!hasCredentials || accountVerdict(verificationError) === 'signed-out') delete accountsById[source];
      refreshTopAvatar();
    }
    if (!isCurrent(mine.attempt)) {
      if (hasCredentials && window.OnlinePlaylists) window.OnlinePlaylists.refresh();
      return;
    }
    btn.disabled = false;
    if (account) {
      close();
      if (window.OnlinePlaylists) window.OnlinePlaylists.refresh();
      if (window.toast) window.toast(sourceLabel(source) + ' 登录成功');
    } else if (verificationError) {
      el('qr-status').textContent = accountVerdict(verificationError) === 'signed-out'
        ? '凭据已失效或账号未登录，请在官网重新登录后导入 Cookie'
        : '凭据已保存，暂时无法验证账号：' + (verificationError.message || '请稍后重试');
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
  var ready = Promise.resolve();
  function init() {
    ready = restoreAccounts();
    return ready;
  }

  async function restoreAccounts() {
    T = window.VMusicTransport;
    // 启动恢复只是读取，不能抢走用户已经开始的扫码意图。
    var attempt = intent.attempt;
    try {
      var list = await loadLoginSources(attempt);
      if (!isCurrent(attempt) || !list.length) return;
      await loadAccounts(attempt);
      if (!isCurrent(attempt)) return;
      await loadSelectedAvatar(attempt);
      if (!isCurrent(attempt)) return;
      refreshTopAvatar();
    } catch (e) { /* 静默 */ }
  }

  window.OnlineLogin = {
    init: init,
    whenReady: function () { return ready; },
    loggedSources: function () {
      var ids = loginSources.filter(function (s) { return !!accountsById[s.id]; })
        .map(function (s) { return s.id; });
      var selected = ids.indexOf(selectedAvatarSource);
      if (selected > 0) ids.unshift(ids.splice(selected, 1)[0]);
      return ids;
    },
    open: open,
    start: start,
    close: close,
    stopPolling: stopPolling,
    isOpen: function(){return !el('qr-modal').hidden;},
  };
})();
