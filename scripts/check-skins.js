#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Hertz layout contract: production wiring, responsive surfaces, lifecycle
// rollback, persisted migration and the existing playback/source host.
// No legacy layout implementation is loaded; extension behavior is exercised
// with synthetic lifecycle owners against the real skins.js module.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'plugin', 'ui');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const SKINS_JS = read(path.join(WEB, 'skins/skins.js'));
const HERTZ_JS = read(path.join(WEB, 'skins/skin.hertz.js'));
const HERTZ_CSS = read(path.join(WEB, 'skins/skin.hertz.css'));
const WALL_JS = read(path.join(WEB, 'cover-wall.js'));
const WALL_CSS = read(path.join(WEB, 'cover-wall.css'));
const HTML = read(path.join(WEB, 'index.html'));
const APP = read(path.join(WEB, 'app.js'));
const ASSETS = read(path.join(ROOT, 'crates/hertz-studio/src/assets.rs'));
const LEGACY = ['classic', 'liunian', 'qingfeng', 'heijiao', 'orbit'];
let failures = 0, checks = 0;
function ok(value, label) { checks++; if (!value) { failures++; console.error('  X ' + label); } }
function eq(actual, expected, label) { ok(actual === expected, label + ' (got ' + JSON.stringify(actual) + ')'); }
function section(label) { console.log('\n' + label); }
function cleanCss(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ' '); }
function cleanJs(js) { return js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ''); }

function makeSandbox(cssIds = ['hertz'], carrier = 'link', seed) {
  const store = seed || new Map();
  const root = { attrs: {}, setAttribute(k,v) { this.attrs[k]=String(v); }, getAttribute(k) { return this.attrs[k] || null; } };
  const links = [...new Set(['hertz', ...cssIds])].map(id => ({ disabled: carrier === 'link',
    getAttribute(key) { return key === 'data-skin-css' ? id : null; } }));
  const events = [];
  const nodes = { 'np-modal': { hidden: false }, 'np-scrim': { hidden: false } };
  let created = 0;
  const sandbox = {
    console: {warn() {},log() {}}, Object, Array, JSON, String, Number, Math, Set, Map,
    localStorage: { getItem:k=>store.has(k)?store.get(k):null, setItem:(k,v)=>store.set(k,String(v)) },
    CustomEvent: class { constructor(type, options) { this.type=type;this.detail=options&&options.detail; } },
    addEventListener() {},
    document: { documentElement:root,body:{}, getElementById:id=>nodes[id]||null,
      querySelectorAll: selector => selector.split(',').some(s=>s.trim()===carrier+'[data-skin-css]') ? links : [],
      createElement() { created++; return {}; }, dispatchEvent(event) { events.push(event); return true; }, addEventListener() {} },
  };
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SKINS_JS,sandbox,{filename:'skins/skins.js'});
  return {sandbox,root,links,store,events,nodes,created:()=>created};
}

function checkCatalogAndMigration() {
  section('唯一生产布局：默认、迁移、持久化与插件 CSS');
  for (const carrier of ['link','style']) {
    const env=makeSandbox(['hertz','unused'],carrier);
    const api=env.sandbox.Skins;
    for (const key of ['register','registerLifecycle','connectHost','request','apply','list','current','currentId','onChange','init']) {
      eq(typeof api[key],'function',carrier+' retains '+key);
    }
    eq(api.list().map(d=>d.id).join(','),'hertz','production catalog contains only hertz');
    eq(api.init(),'hertz',carrier+' startup selects hertz without selector DOM');
    eq(env.root.getAttribute('data-skin'),'hertz','DOM surface matches current layout');
    eq(env.links.filter(l=>!l.disabled).map(l=>l.getAttribute('data-skin-css')).join(','),'hertz',carrier+' enables exactly the current CSS');
    eq(env.created(),0,'startup does not reconstruct retired selector UI');
    api.apply('not-installed');
    eq(api.current().id,'hertz','unknown layout resolves to hertz');
    eq(env.store.get('vmusic.skin'),'hertz','fallback persists a valid layout');
  }
  for (const id of LEGACY.concat('not-installed')) {
    for (const marker of [null,'orbit']) {
      const store=new Map([['vmusic.skin',id]]);
      if (marker) store.set('vmusic.skin.default',marker);
      const env=makeSandbox(['hertz'],'link',store);
      env.sandbox.Skins.init();
      eq(env.sandbox.Skins.currentId(),'hertz',id+' migrates with existing marker '+marker);
      eq(store.get('vmusic.skin'),'hertz','migration replaces obsolete saved '+id);
      const reload=makeSandbox(['hertz'],'link',store);reload.sandbox.Skins.init();
      eq(reload.root.getAttribute('data-skin'),'hertz','migrated '+id+' survives reload');
    }
  }
  const privateEnv=makeSandbox();
  privateEnv.sandbox.localStorage={getItem(){throw new Error('private');},setItem(){throw new Error('private');}};
  privateEnv.sandbox.Skins.init();privateEnv.sandbox.Skins.apply('hertz');
  eq(privateEnv.sandbox.Skins.currentId(),'hertz','blocked storage does not break default layout');
}

function checkExtensions() {
  section('扩展接口：描述、验证、晚登记、缺资源回退与请求解绑');
  const env=makeSandbox(['extension','late','hidden']);const api=env.sandbox.Skins;
  eq(api.register({id:'hertz'}),false,'duplicate IDs cannot replace production owner');
  for(const def of [null,{}, {id:'../bad'}, {id:'Upper'}, {id:'has space'}]) eq(api.register(def),false,'invalid registration is rejected');
  ok(api.register({id:'extension',name:'Fixture layout'}),'extension descriptor can register');
  eq(api.register({id:'extension'}),false,'duplicate extension rejected');
  api.init();api.apply('extension');
  eq(env.root.getAttribute('data-skin'),'extension','registered extension remains usable');
  eq(env.store.get('vmusic.skin'),'extension','extension choice persists');
  api.register({id:'missing-css'});api.apply('missing-css');
  eq(api.currentId(),'hertz','extension without stylesheet falls back to hertz');
  api.register({id:'hidden',hidden:true});
  eq(api.list().some(d=>d.id==='hidden'),false,'hidden extension omitted from public list');
  env.store.set('vmusic.skin','hidden');api.init();
  eq(api.currentId(),'hertz','hidden persisted layout cannot trap a user on boot');
  let mounted=0;
  ok(api.registerLifecycle('hertz',{mount(){mounted++;},unmount(){mounted--;}}),'late production lifecycle attaches');
  eq(mounted,1,'late lifecycle mounts current layout immediately');
  api.apply('hertz');eq(mounted,1,'reapplying same layout does not duplicate owner');
  let closeOptions=null;
  env.sandbox.NowPlaying={isOpen:()=>true,close:opts=>{closeOptions=opts;}};
  api.apply('extension');
  eq(mounted,0,'leaving active lifecycle cleans resources');
  ok(closeOptions&&closeOptions.switching,'player closes before layout handoff');
  ok(env.nodes['np-modal'].hidden&&env.nodes['np-scrim'].hidden,'player overlay is hidden on layout handoff');
  let oldCalls=0,newCalls=0;
  const disconnectOld=api.connectHost(()=>oldCalls++);
  const disconnectNew=api.connectHost(d=>{newCalls++;d.source={key:'library'};});
  disconnectOld();
  const extra={action:'spoof',sample:1};
  const result=api.request('source-request',extra);
  eq(result.action,'source-request','request caller cannot overwrite action');
  eq(result.source.key,'library','host responds synchronously on returned envelope');
  eq(extra.action,'spoof','request does not mutate caller envelope');
  eq(oldCalls,0,'replaced host never receives requests');eq(newCalls,1,'stale disconnect does not remove replacement host');
  disconnectNew();api.request('source-request');eq(newCalls,1,'current disconnect removes host');
  let invalid=false;try{api.connectHost(null);}catch(e){invalid=e.name==='TypeError';}ok(invalid,'nonfunction host rejected');
}

function checkProductionWiring() {
  section('生产资源与所有权：hertz 布局、独立封面墙和共用业务');
  const sheets=[...HTML.matchAll(/data-skin-css="([^"]+)"/g)].map(m=>m[1]);
  eq(sheets.join(','),'hertz','HTML declares only hertz layout CSS');
  for(const name of ['skins/skins.js','skins/skin-shared.js','skins/skin.hertz.js','skins/skin.hertz.css','cover-wall.js','cover-wall.css']) {
    ok(fs.existsSync(path.join(WEB,name)),name+' exists');
    ok(HTML.includes('"'+name+'"'),name+' declared in HTML');
    ok(ASSETS.includes('"/'+name+'"'),name+' registered for embedded delivery');
  }
  for(const id of LEGACY) {
    ok(!HTML.includes('skins/skin.'+id+'.'),id+' no longer loaded by HTML');
    ok(!ASSETS.includes('/skins/skin.'+id+'.'),id+' no longer embedded');
    for (const ext of ['js','css']) ok(!fs.existsSync(path.join(WEB,'skins/skin.'+id+'.'+ext)),id+' retired '+ext+' implementation removed');
  }
  for(const name of ['skins/skin-settings-sheet.js','skins/skins.css']) {
    ok(!HTML.includes('"'+name+'"'),name+' retired from HTML');
    ok(!ASSETS.includes('"/'+name+'"'),name+' retired from assets');
  }
  for(const id of ['skins-list','skin-btn','skin-menu']) ok(!HTML.includes('id="'+id+'"'),'removed selector DOM '+id);
  const scripts=[...HTML.matchAll(/<script[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m=>m[1]);
  for(const pair of [['skins/skins.js','cover-wall.js'],['skins/skin-shared.js','cover-wall.js'],['cover-wall.js','skins/skin.hertz.js'],['skins/skin.hertz.js','app.js']]) {
    ok(scripts.indexOf(pair[0])>=0&&scripts.indexOf(pair[0])<scripts.indexOf(pair[1]),pair.join(' before '));
  }
  const hz=cleanJs(HERTZ_JS), wall=cleanJs(WALL_JS);
  ok(/registerLifecycle\('hertz'/.test(hz),'hertz registers its lifecycle');
  ok(/HertzCoverWall\.mount\(\)/.test(hz)&&/HertzCoverWall\.unmount\(\)/.test(hz),'layout owns wall lifecycle');
  ok(!/registerLifecycle|Skins\.register\(/.test(wall),'cover wall is not another layout');
  ok(/beginLayout\('hertz'\)/.test(hz)&&/layout\.restore\(\)/.test(hz)&&/releaseLayout\('hertz'\)/.test(hz),'layout assembly has symmetric restoration');
  ok(/window\.Skins\.request\(/.test(hz)&&/window\.Skins\.request\(/.test(wall),'both surfaces use shared request bridge');
  for(const [name,source] of [['hertz',hz],['wall',wall]]) {
    ok(!/new Audio\(|AudioContext\(|fetch\(|\/v1\/player\//.test(source),name+' does not create another playback/network owner');
    ok(!/localStorage\.setItem\([^,]*(?:theme|look)/i.test(source),name+' does not bypass appearance persistence owner');
  }
  const sandbox=makeSandbox().sandbox;
  sandbox.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  sandbox.SkinShared={createBuilt:()=>({make(){throw new Error('DOM mutation before mount');},remove(){}}),applyImg(){}};
  vm.runInContext(WALL_JS,sandbox,{filename:'cover-wall.js'});
  for(const method of ['mount','open','close','toggle','unmount','isOpen']) eq(typeof sandbox.HertzCoverWall[method],'function','wall public API '+method);
  eq(sandbox.HertzCoverWall.isOpen(),false,'wall evaluation stays closed');
  vm.runInContext(HERTZ_JS,sandbox,{filename:'skins/skin.hertz.js'});
  eq(sandbox.Skins.registerLifecycle('hertz',{mount(){},unmount(){}}),false,'production module already owns lifecycle without eager DOM mutations');
}

function checkResponsiveSurfaces() {
  section('响应式与输入：内容收缩、滚动、安全区、键盘与减弱动效');
  const css=cleanCss(HERTZ_CSS), wall=cleanCss(WALL_CSS);
  ok(/grid-template-columns:\s*var\(--hz-rail-space,\s*var\(--rail-w\)\) minmax\(0,\s*1fr\)/.test(css),'desktop content can shrink beside responsive navigation');
  ok(/@media\s*\(max-width:\s*899px\)/.test(css),'touch layout has an explicit breakpoint');
  ok(/@media\s*\(max-width:\s*359px\)/.test(css),'small-phone controls have a compact layout');
  ok(/\.hz-workspace\s*\{[^}]*min-width:\s*0/.test(css)&&/\.hz-workspace[^}]*min-height:\s*0/.test(css),'workspace can shrink in both dimensions');
  ok(/\.hz-workspace > \.column\s*\{[^}]*overflow-y:\s*auto/.test(css),'content owns vertical scrolling');
  ok(/\.hz-mobile-nav\s*\{[^}]*position:\s*fixed/.test(css),'touch navigation remains reachable');
  ok(/env\(safe-area-inset-bottom\)/.test(css)&&/env\(safe-area-inset-top\)/.test(css),'mobile surfaces reserve safe areas');
  ok(/#playback-bar\s*\{[^}]*bottom:\s*calc\(77px \+ env/.test(css),'mobile player clears bottom navigation');
  ok(/prefers-reduced-motion/.test(css)&&/prefers-reduced-motion/.test(wall),'both surfaces honor reduced motion');
  ok(/:focus-visible/.test(css)&&/:focus-visible/.test(wall),'keyboard focus remains visible');
  const globalPalette = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => !match[1].includes('#np-modal'))
    .some(match => /(?:^|;)\s*--(?:bg|text|accent|muted|brand|highlight)\s*:/.test(match[2]));
  ok(!globalPalette,'layout does not overwrite shared theme colors outside the dedicated player surface');
  ok(/\.qf-lattice-field\s*\{[^}]*touch-action:\s*none/.test(wall),'wall field owns touch drag and pinch');
  ok(/\.qf-wall-sources\s*\{[^}]*overflow-x:\s*auto/.test(wall)&&/touch-action:\s*pan-x/.test(wall),'source navigation can scroll independently on phones');
  ok(/height:\s*calc\(44px \/ var\(--qf-scale\)\)/.test(wall),'scaled posters keep 44px touch targets');
  ok(/hertz:cover-wall/.test(WALL_JS)&&/hertz:cover-wall/.test(HERTZ_JS),'cover mode publishes state to the layout');
  const stage=cleanCss(read(path.join(WEB,'stage.css')));
  ok(/\.stage-lyrics\s*\{[^}]*overflow:\s*hidden/.test(stage),'shared stage lyrics retain clipping');
  ok(/\.stage-modes\s*\{[^}]*min-width:\s*0/.test(stage),'shared stage modes can shrink');
  ok(/\.stage-mode\s*\{[^}]*text-overflow:\s*ellipsis/.test(stage),'shared stage mode titles remain bounded');
}

function checkCoverWallGeometry() {
  section('独立封面墙：密排和展开让位没有空洞或重叠');
  const start=WALL_JS.indexOf('  var LATTICE_TEMPLATES =');
  const end=WALL_JS.indexOf('  function mixBlockCoords(',start);
  ok(start>=0&&end>start,'wall owns the retained lattice data');
  if(start<0||end<=start)return;
  const data=vm.runInNewContext(WALL_JS.slice(start,end)+'; ({templates:LATTICE_TEMPLATES,reflows:LATTICE_REFLOWS})');
  function tilesBlock(rectangles) {
    if(!Array.isArray(rectangles)||rectangles.length!==12)return false;
    const occupied=new Set();
    for(const rectangle of rectangles) {
      if(!Array.isArray(rectangle)||rectangle.length!==4||!rectangle.every(Number.isInteger))return false;
      const [x,y,w,h]=rectangle;
      if(x<0||y<0||w<=0||h<=0||x+w>12||y+h>8)return false;
      for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++) {
        const key=row*12+col;if(occupied.has(key))return false;occupied.add(key);
      }
    }
    return occupied.size===96;
  }
  ok(data.templates.length>=4&&data.templates.every(tilesBlock),'every template exactly covers one 12×8 block with twelve cards');
  ok(data.reflows.length===data.templates.length&&data.reflows.every(rows=>rows.length===12),'every template supplies a reflow for every possible expanded card');
  ok(data.reflows.every(rows=>rows.every(tilesBlock)),'every expanded layout still covers the same block without overlaps or gaps');
  ok(data.reflows.every(rows=>rows.every((cards,slot)=>cards[slot][2]===6&&cards[slot][3]===6)),'each selected card receives the 6×6 expanded slot');
}

function checkLifecycleAndHost() {
  section('扩展生命周期：有序切换、重复选择、失败还原与通用业务请求');
  const { sandbox, root, store } = makeSandbox(['a', 'b', 'bad']);
  const api = sandbox.Skins;
  const calls = [];
  let owner = null;
  function lifecycle(id) {
    return {
      mount() { eq(owner, null, '新皮肤挂载前旧皮肤已释放'); owner = id; calls.push('+' + id); },
      unmount() { eq(owner, id, '卸载的是正在持有节点的皮肤'); owner = null; calls.push('-' + id); }
    };
  }
  ok(api.register({ id: 'a', lifecycle: lifecycle('a') }), '可直接登记带生命周期的新皮肤');
  ok(api.register({ id: 'b' }), '可先登记描述');
  ok(api.registerLifecycle('b', lifecycle('b')), '实现可以附着到已登记描述');
  eq(api.registerLifecycle('b', lifecycle('b')), false, '重复生命周期不覆盖 owner');
  eq(api.register({ id: 'invalid', lifecycle: { mount() {} } }), false, '拒绝缺少清理钩子的实现');
  store.set('vmusic.skin', 'b');
  api.init();
  api.apply('b');
  eq(calls.join(','), '+b', '恢复偏好与重复选择只挂载一次');
  const unsubscribe = api.onChange(() => calls.push('event:' + owner));
  api.apply('a');
  eq(calls.slice(-3).join(','), '-b,+a,event:a', '先卸载再挂载，之后广播新布局');
  unsubscribe();
  api.apply('b');
  eq(calls.slice(-2).join(','), '-a,+b', '反向切换与取消订阅生效');
  api.register({ id: 'bad', lifecycle: {
    mount() { owner = 'bad'; throw new Error('mount failure'); },
    unmount() { owner = null; calls.push('-bad'); }
  } });
  let failure = null;
  try { api.apply('bad'); } catch (error) { failure = error.message; }
  eq(failure, 'mount failure', '挂载错误可见');
  eq(owner, 'b', '失败后旧皮肤重新取得节点');
  eq(root.getAttribute('data-skin'), 'b', '失败后 CSS 与皮肤 ID 还原');
  eq(store.get('vmusic.skin'), 'b', '失败不污染保存的选择');

  // 原皮肤恢复时也可能分配到一半失败；再次离开仍须找到它的清理钩子。
  const recovery = makeSandbox(['a', 'bad']).sandbox.Skins;
  let recoveryOwner = null, mounts = 0;
  recovery.register({ id: 'a', lifecycle: {
    mount() { recoveryOwner = 'a'; if (++mounts > 1) throw new Error('restore failure'); },
    unmount() { recoveryOwner = null; }
  } });
  recovery.register({ id: 'bad', lifecycle: {
    mount() { throw new Error('new failure'); }, unmount() {}
  } });
  recovery.apply('a');
  try { recovery.apply('bad'); } catch (error) { failure = error.message; }
  eq(failure, 'restore failure', '恢复挂载失败不会被静默吞掉');
  recovery.apply('hertz');
  eq(recoveryOwner, null, '恢复中途失败的 owner 仍能在离开时释放');

  const business = [];
  Object.assign(sandbox, {
    state: { queue: ['local-a'], snapshot: { track_id: 'online:test:1' } },
    queueSnapshot: () => ['queue-snapshot'], viewSnapshot: () => ({ key: 'library' }),
    playTrack: (id, queue) => business.push(['local', id, queue]),
    playQueueStep: delta => business.push(['step', delta]),
    post: url => business.push(['post', url]),
    togglePlay: () => business.push(['toggle']),
    loadDiagnostics: () => business.push(['diagnostics']),
    __loadCacheStats: () => business.push(['cache'])
  });
  // 动作门面（skinActions）与 initSkinBridge 一起切片：处理器引用门面常量。
  const start = APP.indexOf('const skinActions = {');
  const hostAt = APP.indexOf('function initSkinBridge()', start);
  const end = APP.indexOf('\n}', hostAt) + 2;
  vm.runInContext(APP.slice(start, end) + '\ninitSkinBridge();', sandbox);
  eq(api.request('source-request').source.key, 'library', '快照经真实宿主同步返回');
  eq(api.request('queue-request').queue[0], 'queue-snapshot', '队列请求经原队列快照入口返回');
  eq(business.length, 0, '只读来源与队列请求不触发播放动作');
  api.request('step-track', { delta: 1 });
  eq(business[0][1], '/v1/player/next', '在线下一曲复用服务端播放意图');
  sandbox.state.snapshot.track_id = 'local-a';
  api.request('step-track', { delta: -1 });
  eq(business[1][0], 'step', '本地下一曲保留原队列入口');
  api.request('play-local', { id: 'local-a' });
  ok(business[2][2] !== sandbox.state.queue, '播放使用队列快照，皮肤不持有业务状态');
  api.request('settings-enter');
  eq(business.slice(-1)[0][0], 'diagnostics', '普通设置入口保持原刷新范围');
  api.request('settings-enter', { sections: ['cache'] });
  eq(business.slice(-1)[0][0], 'cache', '扩展设置刷新由请求声明，不按皮肤名分支');
  const activations = [];
  const drillResult = Promise.resolve({ tracks: [{ id: 'fixture-song' }] });
  Object.assign(sandbox, {
    activateSourceItem: detail => activations.push(detail),
    openNowPlaying: () => business.push(['open-player']),
    OnlinePlaylists: { drillTracks(source, playlistId) { activations.push({ source, playlistId }); return drillResult; } },
  });
  const item = { id: 'fixture-song', source: 'netease' }, list = [item];
  api.request('activate', { item, list });
  ok(activations[0].item === item && activations[0].list === list, '封面墙激活保留整项与源列表，不混用队列下标');
  eq(api.request('playlist-drill', { source: 'netease', playlistId: 'fixture-list' }).result, drillResult, '歌单钻取返回原异步结果');
  eq(activations[1].playlistId, 'fixture-list', '歌单钻取保留平台歌单身份');
  api.request('open-player');
  eq(business.at(-1)[0], 'open-player', '普通播放页沿用现有业务入口');
  const disconnect = api.connectHost(() => business.push(['new-host']));
  disconnect();
  const before = business.length;
  api.request('toggle-play');
  eq(business.length, before, '宿主可清理且不残留旧处理器');
}

function checkLanFavoriteSourceDispatch() {
  section('收藏来源：皮肤与封面墙保留局域网引用');
  const ref = 'ab'.repeat(32) + ':' + 'cd'.repeat(32);
  const favorites = [
    { id: 'track:local:local-one', kind: 'track', source: 'local', ref_id: 'local-one', title: 'Local' },
    { id: 'track:lan:' + ref, kind: 'track', source: 'lan', ref_id: ref, title: 'LAN snapshot', artist: 'LAN artist', cover: 'blob:must-not-use' },
    { id: 'track:netease:online-one', kind: 'track', source: 'netease', ref_id: 'online-one', title: 'Online' },
  ];
  const roomActivations = [], onlinePlays = [], localPlays = [], notices = [];
  let adapted = [];
  const sandbox = {
    window: {
      Favorites: { state: { items: favorites }, activate: favorite => roomActivations.push(favorite) },
      Online: { state: { source: 'netease' }, safeCoverUrl: value => value, playAll: (tracks, at) => onlinePlays.push({ tracks, at }) },
    },
    state: { snapshot: {}, view: 'favorites', queue: [] },
    transport: { coverUrl: id => '/cover/' + id, post: (url, body) => localPlays.push({ url, body }) },
    toast: message => notices.push(message),
    viewSourceDef: () => ({ items: () => adapted }),
  };
  vm.createContext(sandbox);
  const adapters = APP.slice(APP.indexOf('function localSourceItem('), APP.indexOf('function playlistSourceItems('));
  const dispatcher = APP.slice(APP.indexOf('function queueForSourceItem('), APP.indexOf('function drillIntoPlaylist('));
  vm.runInContext(adapters + '\n' + dispatcher, sandbox);
  adapted = sandbox.favoriteSourceItems();
  eq(adapted.length, 3, '所有收藏仍可展示，包含局域网收藏');
  eq(adapted[1].source, 'lan', '封面墙项目保留局域网来源');
  eq(adapted[1].id, favorites[1].id, '项目身份沿用收藏身份，未伪造在线虚拟 ID');
  eq(adapted[1].title, 'LAN snapshot', '持久化标题仍可展示');
  eq(adapted[1].cover, null, '封面墙不使用局域网旧封面 capability');
  sandbox.playSourceItem(adapted[1], adapted);
  eq(roomActivations.length, 1, '皮肤单项激活走同一个 Favorites.activate 入口');
  eq(roomActivations[0].ref_id, ref, '分派保留完整房主与稳定歌曲身份');
  eq(localPlays.length + onlinePlays.length, 0, '局域网单项不进入本地或在线播放');
  sandbox.playSourceItem(adapted[0], adapted);
  eq(localPlays[0].body.queue.join(','), 'local-one', '本地收藏上下文队列排除 LAN 引用');
  sandbox.playSourceItem(adapted[2], adapted);
  eq(onlinePlays[0].tracks.length, 1, '混合收藏墙只把可在线播放的曲目交给 Online');
  eq(onlinePlays[0].tracks[0].id, 'online-one', '在线播放保留真实平台曲目身份');
  ok(notices.some(message => /已跳过 1 首局域网收藏/.test(message)), '混合收藏在线播放告知跳过的局域网引用');
  const legacy = { id: 'online:lan:' + ref, source: 'lan', favSource: 'lan', favRefId: ref };
  sandbox.playOnlineItem(adapted[2], adapted.concat(legacy));
  ok(onlinePlays.at(-1).tracks.every(track => track.source !== 'lan' && !String(track.id).startsWith('online:lan:')), '旧虚拟 LAN 形式也无法混入在线集合');
}

function luminance(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrastOf(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function checkChaoxiThemes() {
  section('主题：潮汐·夜 / 潮汐·昼 的对比度');

  // 主题数据已迁到 design/definition.json（生成目录的单源）；这里读源文件本身。
  const definition = JSON.parse(read(path.join(WEB, 'design', 'definition.json')));
  const night = (definition.themes.find((t) => t.id === 'chaoxi-night') || {}).tokens;
  const day = (definition.themes.find((t) => t.id === 'chaoxi-day') || {}).tokens;
  ok(night && day, 'definition.json 登记了 chaoxi-night / chaoxi-day 两套主题');

  if (night) {
    const cText = contrastOf(night['--text'], night['--bg']);
    const cMuted = contrastOf(night['--muted'], night['--bg']);
    const cBrand = contrastOf(night['--brand'], night['--bg']);
    ok(cText !== null && cText >= 4.5, `夜：正文对比度 ${cText && cText.toFixed(1)}（≥4.5）`);
    ok(cMuted !== null && cMuted >= 3, `夜：次要文字对比度 ${cMuted && cMuted.toFixed(1)}（≥3）`);
    ok(cBrand !== null && cBrand >= 3, `夜：品牌色对比度 ${cBrand && cBrand.toFixed(1)}（≥3）`);
    ok(night['--accent'] !== night['--accent-2'],
      '夜：accent 与 accent-2 不同（两者相同时频谱柱全染一色，加性混合叠成实心白）');
  }

  if (day) {
    const cText = contrastOf(day['--text'], day['--bg']);
    const cMuted = contrastOf(day['--muted'], day['--bg']);
    const cInk = contrastOf(day['--brand-ink'], day['--bg']);
    ok(cText !== null && cText >= 4.5, `昼：正文对比度 ${cText && cText.toFixed(1)}（≥4.5）`);
    ok(cMuted !== null && cMuted >= 4.5, `昼：次要文字对比度 ${cMuted && cMuted.toFixed(1)}（≥4.5）`);
    ok(cInk !== null && cInk >= 4.5,
      `昼：--brand-ink 对比度 ${cInk && cInk.toFixed(1)}（≥4.5，铜色承载文字必须换这档）`);
    // 铜色在浅底上只有 3.3:1，所以必须分两档：图形用 --brand、文字用 --brand-ink。
    // 两个值若写成一样，等于把不达标的那个用在了文字上——这是设计稿里最容易漏的一条。
    ok(day['--brand'] !== day['--brand-ink'],
      '昼：--brand 与 --brand-ink 是两档（图形一档、文字一档）');
    ok(day['--accent'] !== day['--accent-2'], '昼：accent 与 accent-2 不同');

    // 浅色必须自带玻璃令牌覆盖：design-base.css 的玻璃体系是为暗底写的（靠叠白提亮），
    // 翻到浅底后白叠白等于什么都没叠 —— 卡片糊成一片、描边消失、轨道看不见。
    for (const k of ['--glass-bg', '--glass-border', '--glass-bg-strong', '--surface-line', '--track', '--field-bg']) {
      ok(!!day[k], `昼：自带 ${k} 覆盖（浅底上的白叠层必须翻转）`);
    }
    // 但别一刀切禁白：面板/表面在浅色下本就该是白的，只有分隔类必须压暗。
    ok(/^#(F|E)/i.test(day['--panel-solid']), '昼：--panel-solid 仍是白的（浅色下本就该白）');
  }
}


checkCatalogAndMigration();
checkExtensions();
checkLifecycleAndHost();
checkProductionWiring();
checkResponsiveSurfaces();
checkCoverWallGeometry();
checkLanFavoriteSourceDispatch();
checkChaoxiThemes();
console.log('\n界面布局契约检查：'+(checks-failures)+'/'+checks+(failures?' 通过，'+failures+' 项失败':' 全部通过'));
process.exitCode=failures?1:0;
