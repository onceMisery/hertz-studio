/* =============================================================================
   Hertz Studio — desktop prototype
   Screen set: overview (首页) · list (音乐库) · list (收藏) · list (电台) ·
   list (播客) · analytics (收听统计) · detail (专辑详情)

   The data below is sample data that reconciles: every total is computed from the
   rows, the week is the last seven days of the trend, and the console asserts it.
   ============================================================================= */
'use strict';

/* ---------------------------------------------------------------- 1. data ---*/

// 曲名 · 歌手 · 专辑 · 流派 · 格式 · 码率 · 时长(秒) · 来源 · 封面 · 图形 · 播放次数 · 喜欢 · 几天前加入
const RAW = [
  ['夜航西飞','林知遥','夜航西飞','民谣','FLAC','24/96',252,'本机目录','teal','hill',128,1,3],
  ['潮汐信号','海岸线乐团','蓝调假日','摇滚','FLAC','24/96',228,'本机目录','indigo','wave',96,0,5],
  ['白噪城市','沈屿','霓虹切片','电子','MP3','320k',306,'本机目录','plum','grid',214,1,2],
  ['山谷回声','木川','山鸣','民谣','FLAC','24/96',273,'本机目录','olive','hill',187,0,8],
  ['雨落东京','陈亦','雨天备忘录','流行','MP3','320k',237,'本机目录','teal','wave',302,1,1],
  ['玻璃海岸','苏晚','泡泡里的生活','流行','FLAC','24/48',265,'WebDAV','rust','disc',64,0,12],
  ['群山之南','远山计划','群山','摇滚','FLAC','24/96',291,'本机目录','olive','hill',73,0,21],
  ['边界之外','约翰·瓦茨','边界','爵士','FLAC','24/192',244,'WebDAV','grey','disc',41,1,15],
  ['午夜蓝调','海岸线乐团','蓝调假日','蓝调','DSF','DSD64',312,'本机目录','indigo','wave',58,0,26],
  ['霓虹尾巴','沈屿','霓虹切片','电子','MP3','320k',198,'本机目录','plum','bars',265,0,4],
  ['一路向北','林知遥','夜航西飞','民谣','FLAC','24/96',226,'本机目录','teal','star',151,1,9],
  ['雪落无声','木川','山鸣','民谣','FLAC','24/96',283,'本机目录','grey','hill',88,0,31],
  ['八十年代','肖恩·斯沃德勒','黄金年代','流行','MP3','320k',254,'Jamendo','amber','bars',322,0,6],
  ['雷鬼午后','DJ VK·穆勒','雷鬼与布鲁斯','雷鬼','AAC','256k',209,'Jamendo','olive','wave',139,1,11],
  ['明日曲调','欧西·达蒂','明日精选','电子','FLAC','24/48',231,'Jamendo','plum','star',276,0,7],
  ['一切皆黑','黑鸦','一切皆黑','摇滚','FLAC','24/96',268,'本机目录','grey','grid',92,0,18],
  ['漫游者','苏晚','泡泡里的生活','电子','FLAC','24/48',302,'WebDAV','rust','star',47,0,24],
  ['深蓝信号','沈屿','霓虹切片','电子','MP3','320k',187,'本机目录','indigo','grid',198,0,14],
  ['山雨欲来','远山计划','群山','摇滚','FLAC','24/96',275,'本机目录','olive','wave',66,0,29],
  ['老唱片','陈亦','雨天备忘录','爵士','FLAC','24/96',246,'本机目录','amber','disc',112,1,16],
  ['城市夜航','林知遥','夜航西飞','民谣','MP3','320k',214,'本机目录','teal','star',174,0,10],
  ['第七个夏天','苏晚','泡泡里的生活','流行','FLAC','24/48',258,'WebDAV','rust','hill',83,0,33],
  ['铁轨尽头','木川','山鸣','民谣','FLAC','24/96',296,'本机目录','olive','bars',101,0,23],
  ['逆光','约翰·瓦茨','边界','爵士','DSF','DSD64',263,'WebDAV','plum','disc',38,1,19],
  ['停电之夜','黑鸦','一切皆黑','摇滚','MP3','320k',232,'本机目录','grey','grid',79,0,27],
  ['海雾','海岸线乐团','蓝调假日','蓝调','FLAC','24/96',288,'Jamendo','indigo','wave',54,0,35],
  ['深夜书房','编辑部','深夜书房','轻音乐','FLAC','24/48',271,'本机目录','teal','star',143,1,13],
  ['归途','陈亦','雨天备忘录','流行','FLAC','24/96',249,'本机目录','amber','hill',221,0,17],
  ['河流的声音','远山计划','群山','民谣','FLAC','24/96',268,'本机目录','olive','hill',61,0,38],
  ['雨刷','沈屿','霓虹切片','电子','MP3','320k',176,'本机目录','plum','grid',132,0,20],
  ['站台','林知遥','夜航西飞','民谣','FLAC','24/96',243,'本机目录','teal','hill',97,0,22],
  ['玻璃动物园','苏晚','泡泡里的生活','流行','MP3','320k',224,'WebDAV','rust','disc',58,0,41],
  ['蓝调午夜场','海岸线乐团','蓝调假日','蓝调','FLAC','24/96',259,'Jamendo','indigo','wave',71,0,25],
  ['山行者','木川','山鸣','民谣','FLAC','24/96',281,'本机目录','olive','hill',84,1,36],
  ['无名路口','黑鸦','一切皆黑','摇滚','FLAC','24/96',277,'本机目录','grey','grid',45,0,30],
  ['南方以南','陈亦','雨天备忘录','流行','FLAC','24/96',236,'本机目录','amber','hill',168,0,28],
  ['合成器的第一性问题','沈屿','霓虹切片','电子','FLAC','24/48',293,'本机目录','plum','bars',121,0,32],
  ['河岸','约翰·瓦茨','边界','爵士','FLAC','24/96',251,'WebDAV','grey','disc',33,0,44],
  ['旧磁带','肖恩·斯沃德勒','黄金年代','流行','MP3','320k',218,'Jamendo','amber','bars',145,1,37],
  ['夜班公交','远山计划','群山','摇滚','MP3','320k',229,'本机目录','olive','grid',92,0,39],
  ['灯塔','苏晚','泡泡里的生活','流行','FLAC','24/48',274,'WebDAV','rust','star',67,0,46],
  ['雪线以上','木川','山鸣','民谣','FLAC','24/96',287,'本机目录','grey','hill',76,0,42],
  ['未能送达','黑鸦','一切皆黑','摇滚','FLAC','24/96',241,'本机目录','grey','grid',52,0,34],
  ['长夜将尽','林知遥','夜航西飞','民谣','FLAC','24/96',269,'本机目录','teal','star',133,1,40],
  ['暗房','苏晚','泡泡里的生活','流行','FLAC','24/48',262,'WebDAV','rust','disc',49,0,47],
  ['冬至','陈亦','雨天备忘录','流行','MP3','320k',231,'本机目录','amber','hill',158,0,43],
  ['未命名 demo','沈屿','霓虹切片','电子','MP3','320k',203,'本机目录','plum','grid',88,0,45],
  ['尾声','木川','山鸣','民谣','FLAC','24/96',279,'本机目录','olive','hill',57,0,48]
];

const TRACKS = RAW.map(function (r, i) {
  return { id: i + 1, t: r[0], a: r[1], al: r[2], g: r[3], f: r[4], br: r[5], d: r[6],
           src: r[7], art: r[8], motif: r[9], plays: r[10], liked: !!r[11], ago: r[12] };
});

// 入库链路: 扫描扩展名、读到标签、能解码、真出声是四件事。前三档是扫描结果，最后一档由曲目算出。
const CHAIN = { scanned: 63, tagged: 51, decodable: 48 };

const SOURCES = ['本机目录', 'WebDAV', 'Jamendo'];

// 近 30 日每日收听（小时），10/3 起，11/1 止。近 7 天就是它的最后七天，不另写一份。
const TREND = [1.8,2.4,0.6,1.2,3.1,2.8,1.1, 0.4,1.9,2.2,3.4,1.6, 2.7,0.8,1.4,2.9,
               3.2,1.1,0.7,2.3, 1.5,2.6,3.8,2.0, 0.9,1.7,2.5,3.0, 1.3,2.1];

const STATIONS = [
  { t:'城市频率 88.9', band:'城市', br:'128 kbps', live:true,  art:'indigo', motif:'grid' },
  { t:'深夜爵士',      band:'爵士', br:'192 kbps', live:false, art:'grey',   motif:'disc' },
  { t:'合成器黎明',    band:'电子', br:'192 kbps', live:false, art:'plum',   motif:'bars' },
  { t:'民谣公路',      band:'城市', br:'96 kbps',  live:false, art:'teal',   motif:'hill' },
  { t:'蓝调午夜场',    band:'爵士', br:'160 kbps', live:true,  art:'indigo', motif:'wave' },
  { t:'山间电台',      band:'电子', br:'160 kbps', live:false, art:'olive',  motif:'star' }
];

const EPISODES = [
  { t:'第 42 期 · 冬天读什么',       p:'深夜书房', d:3124, at:1937, art:'teal',   motif:'star' },
  { t:'山谷里的录音棚',              p:'声音地理', d:2718, at:489,  art:'olive',  motif:'hill' },
  { t:'关于解码器的十个误解',        p:'器材闲谈', d:3480, at:0,    art:'grey',   motif:'disc' },
  { t:'母带是怎么做出来的',          p:'编码与黑胶', d:2260, at:2124, art:'rust', motif:'disc' },
  { t:'夜班公交上的城市',            p:'城市漫步', d:1890, at:661,  art:'indigo', motif:'grid' },
  { t:'合成器的第一性问题',          p:'午夜频率', d:2960, at:0,    art:'plum',   motif:'bars' },
  { t:'第 41 期 · 短篇三则',         p:'深夜书房', d:3300, at:3300, art:'teal',   motif:'star' },
  { t:'河流的声音地图',              p:'声音地理', d:2410, at:1205, art:'olive',  motif:'hill' }
];

/* ------------------------------------------------------------- 2. derived ---*/

const sum = (a) => a.reduce((x, y) => x + y, 0);
const nf = new Intl.NumberFormat('zh-CN');
const num = (v) => nf.format(v);
const hrs = (v) => (Math.round(v * 10) / 10).toFixed(1);
const dur = (s) => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const long = (s) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? h + ' 小时 ' + m + ' 分' : m + ' 分';
};
const dayLabel = (ago) => {                       // 30 个连续日期，11/1 是今天
  const d = new Date(2026, 9, 3); d.setDate(d.getDate() + ago);
  return (d.getMonth() + 1) + '/' + d.getDate();
};
const DAYS = TREND.map((_, i) => dayLabel(i));

const WEEK = TREND.slice(-7);
const WEEK_DAYS = DAYS.slice(-7);
const PREV = TREND.slice(-14, -7);

const TOTAL      = TRACKS.length;
const TOTAL_SEC  = sum(TRACKS.map((t) => t.d));
const LIKED      = TRACKS.filter((t) => t.liked);
const HEARD      = TRACKS.filter((t) => t.plays >= 100).length;
const BY_SRC     = (s) => TRACKS.filter((t) => t.src === s).length;
const formats    = ['FLAC', 'MP3', 'AAC', 'DSF'].map((f) => ({ f: f, n: TRACKS.filter((t) => t.f === f).length }));
const genres     = Object.values(TRACKS.reduce((m, t) => { (m[t.g] = m[t.g] || { g: t.g, n: 0 }).n++; return m; }, {}))
                         .sort((a, b) => b.n - a.n);

const ALBUMS = Object.values(TRACKS.reduce((m, t) => {
  if (!m[t.al]) m[t.al] = { al: t.al, a: t.a, art: t.art, motif: t.motif, n: 0, sec: 0, ago: t.ago };
  m[t.al].n++; m[t.al].sec += t.d; m[t.al].ago = Math.min(m[t.al].ago, t.ago);
  return m;
}, {})).sort((a, b) => a.ago - b.ago);

// the numbers on the screen have to agree; say so where a reader can check
console.assert(TOTAL === CHAIN.decodable, '可解码曲目数应等于曲库曲目数');
console.assert(sum(SOURCES.map(BY_SRC)) === TOTAL, '各来源曲目数之和应等于曲库曲目数');
console.assert(Math.abs(sum(WEEK) - sum(TREND.slice(-7))) < 1e-9, '本周收听应是趋势的最后七天');

/* --------------------------------------------------------------- 3. marks ---*/

const MOTIF = {
  wave:'<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M-6 62C16 44 30 78 50 60S84 42 106 60"/><path d="M-6 78C18 62 32 92 52 76S86 60 106 76" opacity=".55"/></svg>',
  hill:'<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><circle cx="68" cy="30" r="12"/><path d="M-6 104 32 54 58 104Z"/><path d="M40 104 70 60 106 104Z" opacity=".5"/></svg>',
  disc:'<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="50" cy="50" r="34"/><circle cx="50" cy="50" r="22" opacity=".55"/><circle cx="50" cy="50" r="5" fill="currentColor" stroke="none"/></svg>',
  grid:'<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M-6 72H106M-6 84H106M-6 96H106" opacity=".5"/><path d="M50 64-32 104M50 64 132 104M50 64 22 68M50 64 78 68" opacity=".45"/><circle cx="50" cy="58" r="9"/></svg>',
  bars:'<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" fill="currentColor" stroke="none"><rect x="12" y="54" width="8" height="30" rx="3" opacity=".75"/><rect x="26" y="40" width="8" height="44" rx="3" opacity=".9"/><rect x="40" y="60" width="8" height="24" rx="3" opacity=".65"/><rect x="54" y="32" width="8" height="52" rx="3"/><rect x="68" y="48" width="8" height="36" rx="3" opacity=".8"/><rect x="82" y="62" width="8" height="22" rx="3" opacity=".6"/></svg>',
  star:'<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 74 36 40 58 56 78 22" opacity=".6"/><circle cx="18" cy="74" r="3.6" fill="currentColor" stroke="none"/><circle cx="36" cy="40" r="3" fill="currentColor" stroke="none"/><circle cx="58" cy="56" r="4.2" fill="currentColor" stroke="none"/><circle cx="78" cy="22" r="3.6" fill="currentColor" stroke="none"/><circle cx="88" cy="64" r="2.4" fill="currentColor" stroke="none" opacity=".7"/></svg>'
};
const cover = (art, motif, size) =>
  '<span class="cover art-' + art + ' ' + (size || 'sq') + '">' + (MOTIF[motif] || MOTIF.wave) + '</span>';
const ic = (id, cls) => '<svg class="' + (cls || '') + '"><use href="#i-' + id + '"/></svg>';

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function toast(msg, icon) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = ic(icon || 'check') + '<span>' + esc(msg) + '</span>';
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; }, 2600);
  setTimeout(() => el.remove(), 2900);
}

/* --------------------------------------------------------- 4. the player ---*/

const P = { i: -1, playing: false, t: 0, vol: 0.72, mute: false, shuffle: false, repeat: 0, queue: [] };

function nowPlaying() { return P.i >= 0 ? P.queue[P.i] || TRACKS[P.i] : null; }

function setTrack(track, list) {
  if (list) P.queue = list;
  if (!P.queue.length) P.queue = TRACKS.slice();
  const j = P.queue.findIndex((t) => t.id === track.id);
  P.i = j >= 0 ? j : 0;
  P.t = 0; P.playing = true;
  paintPlayer(); paintRows();
}
function step(dir) {
  if (!P.queue.length) P.queue = TRACKS.slice();
  if (P.i < 0) { setTrack(P.queue[0]); return; }
  let n = P.shuffle ? Math.floor(Math.random() * P.queue.length) : P.i + dir;
  if (n >= P.queue.length) n = P.repeat === 1 ? 0 : n;
  if (n >= P.queue.length) { P.playing = false; P.t = P.queue[P.i].d; paintPlayer(); return; }
  if (n < 0) n = P.queue.length - 1;
  P.i = n; P.t = 0; P.playing = true;
  paintPlayer(); paintRows();
}

function paintPlayer() {
  const t = nowPlaying();
  $('#p-cover').innerHTML = t ? cover(t.art, t.motif, 's40') : cover('grey', 'disc', 's40');
  $('#p-title').textContent = t ? t.t : '未在播放';
  $('#p-artist').textContent = t ? t.a + ' · ' + t.al : 'Hertz Studio';
  $('#p-dur').textContent = t ? dur(t.d) : '0:00';
  $('#p-cur').textContent = dur(P.t);
  $('#p-bar').firstElementChild.style.width = (t ? Math.min(1, P.t / t.d) * 100 : 0) + '%';
  $('#p-play').innerHTML = ic(P.playing ? 'pause' : 'play');
  $('#p-play').setAttribute('aria-label', P.playing ? '暂停' : '播放');
  $('#p-like').classList.toggle('on', !!(t && t.liked));
  $('#p-like').innerHTML = ic(t && t.liked ? 'heart-fill' : 'heart');
  $('#p-mute').innerHTML = ic(P.mute || P.vol === 0 ? 'mute' : 'volume');
  const vp = (P.mute ? 0 : P.vol) * 100;
  $('#p-vol').firstElementChild.style.height = vp + '%';
  $('#p-vol').lastElementChild.style.bottom = vp + '%';
  $('#p-vol-num').textContent = Math.round(vp);
  $('#p-shuffle').classList.toggle('on', P.shuffle);
  $('#p-repeat').classList.toggle('on', P.repeat > 0);

  $('#np-cover').innerHTML = t ? cover(t.art, t.motif, 's56') : cover('grey', 'disc', 's56');
  $('#np-title').textContent = t ? t.t : '未在播放';
  $('#np-artist').textContent = t ? t.a + ' · ' + t.al : '从音乐库挑一首开始';
  $('#np-dur').textContent = t ? dur(t.d) : '0:00';
  $('#np-cur').textContent = dur(P.t);
  $('#np-bar').firstElementChild.style.width = (t ? Math.min(1, P.t / t.d) * 100 : 0) + '%';
  $('#np-state').textContent = P.playing ? '播放中' : (t ? '已暂停' : '');
}
function paintRows() {
  const t = nowPlaying();
  $$('tbody tr').forEach((r) => r.classList.remove('on'));
  if (!t) return;
  $$('tbody tr[data-id="' + t.id + '"]').forEach((r) => r.classList.add('on'));
}

setInterval(() => {
  if (!P.playing || P.i < 0) return;
  const t = nowPlaying(); if (!t) return;
  P.t += 0.25;
  if (P.t >= t.d) {
    if (P.repeat === 2) { P.t = 0; }
    else { step(1); return; }
  }
  paintPlayer();
}, 250);

// 64 段 FFT 推到界面，这里用一段合成波形代表它
(function spectrum() {
  const host = $('#spectrum'), n = 18, bars = [];
  for (let i = 0; i < n; i++) { const b = document.createElement('i'); host.appendChild(b); bars.push(b); }
  (function loop(now) {
    const tt = now / 1000;
    bars.forEach((b, i) => {
      const v = 0.28 + 0.26 * Math.sin(tt * 2.3 + i * 0.52) + 0.18 * Math.sin(tt * 3.9 + i * 1.21) + 0.1 * Math.sin(tt * 7.3 + i * 2.07);
      b.style.height = (P.playing ? Math.max(8, Math.min(100, v * 100)) : 10 + (i % 4) * 4) + '%';
      b.style.opacity = P.playing ? 0.85 : 0.3;
    });
    requestAnimationFrame(loop);
  })(0);
})();

/* ------------------------------------------------- 5. overview (首页) ------*/

function paintChain() {
  $('#chain').innerHTML = [
    ['扫描到的文件', CHAIN.scanned], ['读到标签', CHAIN.tagged],
    ['能解码', CHAIN.decodable], ['真出过声', HEARD]
  ].map(([k, v]) => '<div class="step"><b>' + v + '</b><span>' + k + '</span></div>').join('');

  const parts = [
    { k: '能解码', v: CHAIN.decodable, c: 'var(--accent)' },
    { k: '有标签但没有解码器', v: CHAIN.tagged - CHAIN.decodable, c: 'var(--chart-muted)' },
    { k: '读不出标签', v: CHAIN.scanned - CHAIN.tagged, c: 'var(--border)' }
  ];
  $('#chain-share').innerHTML = parts.map((p) =>
    '<i style="width:' + (p.v / CHAIN.scanned * 100).toFixed(2) + '%;background:' + p.c + '"></i>').join('');
  $('#chain-legend').innerHTML = parts.map((p) =>
    '<span><i style="background:' + p.c + '"></i>' + p.k + ' <span class="v">' + p.v + '</span></span>').join('');
  $('#chain-note').textContent =
    'Opus、APE、WMA 共 ' + (CHAIN.tagged - CHAIN.decodable) + ' 个文件读到了标签，但当前没有对应解码器；' +
    (CHAIN.scanned - CHAIN.tagged) + ' 个读不出标签的文件留在扫描结果里，不进曲库。';
}

function paintHome() {
  $('#home-sub').textContent =
    TOTAL + ' 首现在真的能出声。' + (CHAIN.scanned - CHAIN.tagged) + ' 个文件读不出标签，' +
    (CHAIN.tagged - CHAIN.decodable) + ' 个卡在解码器上。';
  $('#home-stamp').textContent = '上次扫描 今天 14:02';
  paintChain();

  $('#fmt-share').innerHTML = formats.map((f) =>
    '<i style="width:' + (f.n / TOTAL * 100).toFixed(2) + '%;background:' +
    (f.f === 'FLAC' ? 'var(--accent)' : 'var(--chart-muted)') + '"></i>').join('');
  $('#fmt-legend').innerHTML = formats.map((f) =>
    '<span><i style="background:' + (f.f === 'FLAC' ? 'var(--accent)' : 'var(--chart-muted)') + '"></i>' +
    f.f + ' <span class="v">' + f.n + '</span></span>').join('') +
    '<span style="flex-basis:100%;color:var(--faint)">无损（FLAC / DSD）' +
    formats.filter((f) => f.f === 'FLAC' || f.f === 'DSF').reduce((a, f) => a + f.n, 0) +
    ' 首，有损 ' + formats.filter((f) => f.f === 'MP3' || f.f === 'AAC').reduce((a, f) => a + f.n, 0) + ' 首</span>';

  $('#recent-albums').innerHTML = ALBUMS.slice(0, 6).map((a, i) =>
    '<div class="album" data-album="' + a.al + '">' + cover(a.art, a.motif, 'sq') +
    '<div class="name">' + esc(a.al) + '</div><div class="sub">' + esc(a.a) + ' · ' + a.n + ' 首</div></div>').join('');

  $('#top-list').innerHTML = TRACKS.slice().sort((x, y) => y.plays - x.plays).slice(0, 5).map((t, i) =>
    '<div class="row" data-id="' + t.id + '"><span class="t-sm" style="width:14px">' + (i + 1) + '</span>' +
    '<span class="media" style="flex:1;min-width:0">' + cover(t.art, t.motif, 's40') +
    '<span class="body"><div class="name">' + esc(t.t) + '</div><div class="sub">' + esc(t.a) + '</div></span></span>' +
    '<span class="num" style="font-size:13px;color:var(--muted)">' + num(t.plays) + '</span></div>').join('');

  const playsOf = (name) => TRACKS.filter((t) => t.al === name).reduce((a, t) => a + t.plays, 0);
  const f = ALBUMS.slice().sort((a, b) => playsOf(b.al) - playsOf(a.al))[0];
  const fPlays = playsOf(f.al);
  $('#featured').innerHTML =
    '<div class="feat">' +
      '<div class="media">' + cover(f.art, f.motif, 's96') +
        '<span class="body" style="min-width:0"><div class="feat-name">' + esc(f.al) + '</div>' +
        '<div class="sub">' + esc(f.a) + ' · ' + f.n + ' 首 · ' + long(f.sec) + '</div></span></div>' +
      '<p class="feat-note">曲库里累计播放最多的一张，共 ' + num(fPlays) + ' 次。' +
        '整张连着放正好 ' + long(f.sec) + '，适合当一整段背景。</p>' +
      '<div class="feat-acts">' +
        '<button class="btn primary" data-play-album="' + esc(f.al) + '">' + ic('play') + '播放全部</button>' +
        '<button class="btn ghost" data-queue-album="' + esc(f.al) + '">' + ic('plus') + '加入队列</button>' +
      '</div></div>';
}

function paintWeekChart(days) {
  const n = days;
  const labels = DAYS.slice(-n), values = TREND.slice(-n);
  Charts.bars($('#ch-week'), { labels: labels, values: values, format: (v) => v.toFixed(1), xAt: xTicks(n) });
  const cur = sum(values), prev = sum(TREND.slice(-2 * n, -n));
  const d = Math.round((cur - prev) * 10) / 10;
  $('#week-note').textContent = '近 ' + n + ' 天合计 ' + hrs(cur) + ' 小时，比前一个 ' + n + ' 天 ' +
    (d === 0 ? '持平' : (d > 0 ? '多 ' : '少 ') + Math.abs(d).toFixed(1) + ' 小时') + '。';
}
function xTicks(n) {                       // 4–8 labels, one step, landing on the end
  const step = Math.max(1, Math.ceil(n / 6));
  const out = []; for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

/* ----------------------------------------------------- 6. list (音乐库) ----*/

const lib = { src: '全部', sort: 'added', size: 12, page: 1, q: '' };

function filtered() {
  let rows = TRACKS.filter((t) => (lib.src === '全部' || t.src === lib.src));
  const q = lib.q.trim().toLowerCase();
  if (q) rows = rows.filter((t) => (t.t + t.a + t.al + t.g).toLowerCase().includes(q));
  const key = lib.sort;
  rows.sort((x, y) => {
    if (key === 'plays' || key === 'dur') return y[key] - x[key];
    if (key === 'added') return x.ago - y.ago;
    return String(x[key]).localeCompare(String(y[key]), 'zh-Hans-CN');
  });
  return rows;
}

function paintLibrary() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / lib.size));
  if (lib.page > pages) lib.page = pages;
  const slice = rows.slice((lib.page - 1) * lib.size, lib.page * lib.size);

  $('#src-counts').innerHTML = [['全部', TOTAL]].concat(SOURCES.map((s) => [s, BY_SRC(s)])).map(([k, v]) =>
    '<button class="count" data-src="' + k + '" aria-pressed="' + (lib.src === k) + '">' +
    '<div class="k">' + k + '</div><div class="v">' + v + '<small> 首</small></div></button>').join('');

  $('#lib-sub').textContent = TOTAL + ' 首 · ' + long(TOTAL_SEC) + ' · 来源 ' + SOURCES.length + ' 个';
  $('#lib-stamp').textContent = '当前筛选 ' + rows.length + ' 首';
  $('#pg-info').textContent = '第 ' + lib.page + ' / ' + pages + ' 页';
  $('#pg-prev').disabled = lib.page === 1;
  $('#pg-next').disabled = lib.page === pages;

  $('#lib-rows').innerHTML = slice.length ? slice.map(trackRow).join('')
    : emptyRow(7, '这个来源下还没有曲目。换一个来源，或者先扫描一次音乐目录。');
  paintRows();
}

function trackRow(t) {
  const on = nowPlaying() && nowPlaying().id === t.id;
  return '<tr data-id="' + t.id + '"' + (on ? ' class="on"' : '') + '>' +
    '<td><span class="media">' + cover(t.art, t.motif, 's40') +
      '<span class="body"><div class="name">' + esc(t.t) + '</div><div class="sub">' + esc(t.a) + '</div></span></span></td>' +
    '<td class="truncate">' + esc(t.al) + '</td>' +
    '<td class="sub">' + esc(t.g) + '</td>' +
    '<td><span class="tag' + (t.f === 'FLAC' || t.f === 'DSF' ? ' hi' : '') + '">' + t.f + ' ' + t.br + '</span></td>' +
    '<td class="n num">' + dur(t.d) + '</td>' +
    '<td class="n num sub">' + num(t.plays) + '</td>' +
    '<td><span class="row-act"><button class="icon-btn' + (t.liked ? ' on' : '') + '" data-like="' + t.id +
      '" aria-label="收藏">' + ic(t.liked ? 'heart-fill' : 'heart') + '</button></span></td></tr>';
}
function emptyRow(cols, msg) {
  return '<tr><td colspan="' + cols + '"><div class="empty">' + esc(msg) + '</div></td></tr>';
}

/* ------------------------------------------------------- 7. 收藏 / 电台 / 播客 ---*/

const col = { tab: 'album' };

function paintCollection() {
  const likedAlbums = ALBUMS.filter((a) => TRACKS.some((t) => t.al === a.al && t.liked));
  $('#col-sub').textContent = LIKED.length + ' 首喜欢 · ' + likedAlbums.length + ' 张专辑里有喜欢的曲目';
  $('#col-stamp').textContent = col.tab === 'album' ? likedAlbums.length + ' 张专辑' : LIKED.length + ' 首';
  $('#col-albums').hidden = col.tab !== 'album';
  $('#col-tracks').hidden = col.tab !== 'track';
  if (col.tab === 'album') {
    $('#col-albums').innerHTML = likedAlbums.length ? likedAlbums.map((a) =>
      '<div class="album" data-album="' + esc(a.al) + '">' + cover(a.art, a.motif, 'sq') +
      '<div class="name">' + esc(a.al) + '</div><div class="sub">' + esc(a.a) + ' · ' + a.n + ' 首</div></div>').join('')
      : '<div class="empty" style="grid-column:1/-1">还没有喜欢的专辑。在曲目表里点心形试试。</div>';
  } else {
    $('#col-rows').innerHTML = LIKED.map((t) => trackRow(t)).join('');
  }
  paintRows();
}

function paintRadio() {
  $('#radio-rows').innerHTML = STATIONS.map((s) =>
    '<tr><td><span class="media">' + cover(s.art, s.motif, 's40') +
      '<span class="body"><div class="name">' + esc(s.t) + '</div>' +
      '<div class="sub">' + (s.live ? '正在直播' : '可回听') + '</div></span></span></td>' +
    '<td class="sub">' + esc(s.band) + '</td><td class="num sub">' + s.br + '</td>' +
    '<td><span class="pill' + (s.live ? ' pos' : '') + '">' + (s.live ? '直播中' : '已缓存') + '</span></td>' +
    '<td><button class="icon-btn" data-station="' + esc(s.t) + '" aria-label="收听">' + ic('play') + '</button></td></tr>').join('');
}

function paintPodcast() {
  $('#pod-rows').innerHTML = EPISODES.map((e) => {
    const ratio = e.at / e.d;
    return '<tr><td><span class="media">' + cover(e.art, e.motif, 's40') +
      '<span class="body"><div class="name">' + esc(e.t) + '</div>' +
      '<div class="sub">' + (e.at >= e.d ? '已听完' : e.at > 0 ? '听到 ' + dur(e.at) : '未收听') + '</div></span></span></td>' +
    '<td class="truncate">' + esc(e.p) + '</td>' +
    '<td><span class="progress"><span class="track"><i style="width:' + (ratio * 100).toFixed(1) + '%"></i></span>' +
      '<span class="v">' + Math.round(ratio * 100) + '%</span></span></td>' +
    '<td class="n num">' + dur(e.d) + '</td>' +
    '<td><button class="icon-btn" data-ep="' + esc(e.t) + '" aria-label="继续播放">' + ic('play') + '</button></td></tr>';
  }).join('');
}

/* --------------------------------------------------- 8. analytics (统计) ---*/

const stats = { range: 7 };

function kpi(label, value, unit, note) {
  return '<div class="kpi"><div class="kpi-label">' + label + '</div>' +
    '<div class="kpi-value">' + value + (unit ? '<small>' + unit + '</small>' : '') + '</div>' +
    (note ? '<div class="delta">' + note + '</div>' : '') + '</div>';
}

function paintStats() {
  const n = stats.range;
  const cur = sum(TREND.slice(-n)), prev = sum(TREND.slice(-2 * n, -n));
  const d = Math.round((cur - prev) * 10) / 10;
  const note = d === 0 ? '与前 ' + n + ' 天持平' : '比前 ' + n + ' 天 ' + (d > 0 ? '多 ' : '少 ') + Math.abs(d).toFixed(1) + ' 小时';
  const plays = sum(TRACKS.map((t) => t.plays));

  $('#stats-kpis').innerHTML =
    kpi('收听时长', hrs(cur), ' 小时', note) +
    kpi('播放次数', num(Math.round(plays / 30 * n)), ' 次', '按近 ' + n + ' 天的日均折算') +
    kpi('日均', hrs(cur / n), ' 小时', '近 ' + n + ' 天平均') +
    kpi('最常听', esc(TRACKS.slice().sort((a, b) => b.plays - a.plays)[0].t), '', num(plays) + ' 次累计');

  $('#stats-stamp').textContent = '近 ' + n + ' 天 · 数据全部存在本机';
  $('#stats-top').innerHTML = TRACKS.slice().sort((x, y) => y.plays - x.plays).slice(0, 6).map((t, i) =>
    '<div class="row" data-id="' + t.id + '"><span class="t-sm" style="width:14px">' + (i + 1) + '</span>' +
    '<span class="media" style="flex:1;min-width:0">' + cover(t.art, t.motif, 's40') +
    '<span class="body"><div class="name">' + esc(t.t) + '</div><div class="sub">' + esc(t.a) + '</div></span></span>' +
    '<span class="num" style="font-size:13px;color:var(--muted)">' + num(t.plays) + '</span></div>').join('');
}

function paintStatsCharts() {
  const n = stats.range;
  const labels = DAYS.slice(-n), values = TREND.slice(-n);
  Charts.bars($('#ch-daily'), { labels: labels, values: values, format: (v) => v.toFixed(1), xAt: xTicks(n) });
  let acc = 0;
  const cum = values.map((v) => (acc += v));
  Charts.line($('#ch-cum'), { labels: labels, series: [{ name: '累计收听', values: cum }], format: (v) => v.toFixed(0), xAt: xTicks(n) });
  Charts.barList($('#ch-genre'), genres.map((g) => ({ label: g.g, value: g.n })), { format: (v) => v + ' 首' });
}

/* ------------------------------------------------------ 9. detail (详情) ---*/

let current = null;

function openAlbum(name) {
  const a = ALBUMS.find((x) => x.al === name); if (!a) return;
  current = a;
  const rows = TRACKS.filter((t) => t.al === a.al);
  const lossless = rows.filter((t) => t.f === 'FLAC' || t.f === 'DSF').length;

  $('#detail-header').innerHTML =
    cover(a.art, a.motif, 'detail') +
    '<div style="min-width:0"><div class="title">' + esc(a.al) + '</div>' +
    '<div class="meta">' + esc(a.a) + ' · ' + rows.length + ' 首 · ' + long(rows.reduce((s, t) => s + t.d, 0)) +
    ' · ' + dayLabel(a.ago) + ' 加入</div></div>' +
    '<span class="grow"></span><div class="acts">' +
    '<button class="btn" data-play-album="' + esc(a.al) + '">' + ic('play') + '播放全部</button>' +
    '<button class="btn" data-queue-album="' + esc(a.al) + '">' + ic('plus') + '加入队列</button></div>';

  $('#detail-kpis').innerHTML =
    kpi('曲目', rows.length, ' 首', '') +
    kpi('总时长', long(rows.reduce((s, t) => s + t.d, 0)), '', '') +
    kpi('无损', Math.round(lossless / rows.length * 100) + '%', '', lossless + ' / ' + rows.length + ' 首');

  $('#detail-rows').innerHTML = rows.map((t) =>
    '<tr data-id="' + t.id + '"><td><span class="media">' + cover(t.art, t.motif, 's40') +
      '<span class="body"><div class="name">' + esc(t.t) + '</div><div class="sub">' + esc(t.a) + '</div></span></span></td>' +
    '<td class="sub">' + esc(t.g) + '</td>' +
    '<td><span class="tag' + (t.f === 'FLAC' || t.f === 'DSF' ? ' hi' : '') + '">' + t.f + ' ' + t.br + '</span></td>' +
    '<td class="n num">' + dur(t.d) + '</td><td class="n num sub">' + num(t.plays) + '</td>' +
    '<td><button class="icon-btn' + (t.liked ? ' on' : '') + '" data-like="' + t.id + '" aria-label="收藏">' +
      ic(t.liked ? 'heart-fill' : 'heart') + '</button></td></tr>').join('');

  show('detail'); paintRows();
}

/* ------------------------------------------------------ 10. navigation ----*/

function show(name) {
  $$('.screen').forEach((s) => s.classList.toggle('on', s.id === 's-' + name));
  $$('[data-go]').forEach((n) => {
    if (n.classList.contains('nav-item')) n.setAttribute('aria-current', n.dataset.go === name ? 'page' : 'false');
  });
  $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('on');
  if (name === 'home') paintWeekChart(+$('#range button[aria-pressed="true"]').dataset.range || 7);
  if (name === 'stats') paintStatsCharts();
  if (name === 'collection') paintCollection();
  if (name === 'library') paintLibrary();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0); $('.canvas').scrollTop = 0;
}

/* ------------------------------------------------------ 11. wiring --------*/

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-go]');
  if (nav) { e.preventDefault(); show(nav.dataset.go); return; }

  const like = e.target.closest('[data-like]');
  if (like) {
    e.stopPropagation();
    const t = TRACKS.find((x) => x.id === +like.dataset.like);
    t.liked = !t.liked; like.classList.toggle('on', t.liked);
    like.innerHTML = ic(t.liked ? 'heart-fill' : 'heart');
    toast(t.liked ? '已加入喜欢：' + t.t : '已取消喜欢：' + t.t, t.liked ? 'heart-fill' : 'heart');
    if ($('#s-collection').classList.contains('on')) paintCollection();
    return;
  }

  const src = e.target.closest('[data-src]');
  if (src) { lib.src = src.dataset.src; lib.page = 1; paintLibrary(); return; }

  const album = e.target.closest('[data-album]');
  if (album) { openAlbum(album.dataset.album); return; }

  const playAlbum = e.target.closest('[data-play-album]');
  if (playAlbum) {
    e.stopPropagation();
    const rows = TRACKS.filter((t) => t.al === playAlbum.dataset.playAlbum);
    setTrack(rows[0], rows); toast('播放专辑：' + playAlbum.dataset.playAlbum, 'play'); return;
  }
  const queueAlbum = e.target.closest('[data-queue-album]');
  if (queueAlbum) { toast('已把 ' + queueAlbum.dataset.queueAlbum + ' 加入队列', 'plus'); return; }

  const station = e.target.closest('[data-station]');
  if (station) { toast('正在连接电台：' + station.dataset.station, 'radio'); return; }
  const ep = e.target.closest('[data-ep]');
  if (ep) { toast('继续播放：' + ep.dataset.ep, 'mic'); return; }

  const row = e.target.closest('tbody tr[data-id]');
  if (row) {
    const t = TRACKS.find((x) => x.id === +row.dataset.id);
    const cur = nowPlaying();
    if (cur && cur.id === t.id) { P.playing = !P.playing; paintPlayer(); }
    else setTrack(t, filtered().length ? filtered() : null);
    return;
  }
  const listRow = e.target.closest('.row[data-id]');
  if (listRow) { setTrack(TRACKS.find((x) => x.id === +listRow.dataset.id)); return; }
});

// title-row actions
$('#btn-resume').addEventListener('click', () => {
  const t = TRACKS.slice().sort((a, b) => a.ago - b.ago)[0];
  setTrack(t); toast('继续播放：' + t.t + ' — ' + t.a, 'play');
});
$('#btn-play-all').addEventListener('click', () => {
  const rows = filtered(); if (!rows.length) return toast('当前筛选没有曲目', 'dots');
  setTrack(rows[0], rows); toast('已按当前筛选建立队列：' + rows.length + ' 首', 'play');
});
$('#btn-play-liked').addEventListener('click', () => {
  if (!LIKED.length) return toast('还没有喜欢的曲目', 'heart');
  setTrack(LIKED[0], LIKED); toast('播放喜欢：' + LIKED.length + ' 首', 'play');
});
function doScan() {
  toast('正在扫描音乐目录…', 'scan');
  setTimeout(() => { $('#stamp').textContent = '上次扫描 刚刚'; toast('扫描完成：新增 4 首，2 个文件读不出标签', 'check'); }, 1200);
}
$('#switcher').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('#sw').classList.toggle('open');
  $('#switcher').setAttribute('aria-expanded', String(open));
});
$('#sw').addEventListener('click', (e) => {
  const it = e.target.closest('[data-act]'); if (!it) return;
  $('#sw').classList.remove('open'); $('#switcher').setAttribute('aria-expanded', 'false');
  ({
    scan: doScan,
    manage: () => toast('音乐目录：3 个启用，1 个停用', 'list'),
    open:   () => toast('数据目录 C:////Users////miracle////HertzStudio', 'folder'),
    backup: () => toast('已导出：歌单 / 收藏 / 设置（JSON，不含凭据）', 'download'),
    settings: () => toast('设置：音效、外观、歌词、在线音源', 'settings')
  }[it.dataset.act] || (() => {}))();
});
$('#nav-logout').addEventListener('click', (e) => { e.preventDefault(); toast('原型不真的退出；播放与曲库都留在本机。', 'logout'); });
$('#btn-add-station').addEventListener('click', () => toast('粘贴电台地址即可添加（原型演示）', 'plus'));
$('#btn-add-pod').addEventListener('click', () => toast('粘贴 RSS 地址即可订阅（原型演示）', 'plus'));

document.addEventListener('click', () => {
  $('#sw').classList.remove('open'); $('#switcher').setAttribute('aria-expanded', 'false');
});

// filters
$('#sort-by').addEventListener('change', (e) => { lib.sort = e.target.value; lib.page = 1; paintLibrary(); });
$('#page-size').addEventListener('change', (e) => { lib.size = +e.target.value; lib.page = 1; paintLibrary(); });
$('#pg-prev').addEventListener('click', () => { lib.page = Math.max(1, lib.page - 1); paintLibrary(); });
$('#pg-next').addEventListener('click', () => { lib.page++; paintLibrary(); });
let qt;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qt);
  qt = setTimeout(() => {
    lib.q = e.target.value; lib.page = 1;
    if (e.target.value.trim()) show('library');
    paintLibrary();
  }, 160);
});

$$('#range button').forEach((b) => b.addEventListener('click', () => {
  $$('#range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  paintWeekChart(+b.dataset.range);
}));
$$('#stats-range button').forEach((b) => b.addEventListener('click', () => {
  $$('#stats-range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  stats.range = +b.dataset.sr; paintStats(); paintStatsCharts();
}));
$$('#col-tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#col-tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  col.tab = b.dataset.col; paintCollection();
}));

// player
$('#p-play').addEventListener('click', () => {
  if (P.i < 0) { setTrack(TRACKS[0]); return; }
  P.playing = !P.playing; paintPlayer(); paintRows();
});
$('#p-prev').addEventListener('click', () => step(-1));
$('#p-next').addEventListener('click', () => step(1));
$('#p-shuffle').addEventListener('click', () => { P.shuffle = !P.shuffle; paintPlayer(); toast(P.shuffle ? '随机播放已开启' : '随机播放已关闭', 'shuffle'); });
$('#p-repeat').addEventListener('click', () => { P.repeat = (P.repeat + 1) % 3; paintPlayer(); toast(['循环已关闭', '循环：整个列表', '循环：单曲'][P.repeat], 'repeat'); });
$('#p-mute').addEventListener('click', () => { P.mute = !P.mute; paintPlayer(); });
$('#p-like').addEventListener('click', () => {
  const t = nowPlaying(); if (!t) return;
  t.liked = !t.liked; paintPlayer(); toast(t.liked ? '已加入喜欢' : '已取消喜欢', t.liked ? 'heart-fill' : 'heart');
});
$('#p-queue').addEventListener('click', () => toast('播放队列：' + (P.queue.length || TOTAL) + ' 首', 'list'));

function seekBar(el, onSet) {
  const ratio = (e) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); onSet(ratio(e)); });
  el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) onSet(ratio(e)); });
}
seekBar($('#p-bar'), (r) => { const t = nowPlaying(); if (!t) return; P.t = r * t.d; paintPlayer(); });
seekBar($('#np-bar'), (r) => { const t = nowPlaying(); if (!t) return; P.t = r * t.d; paintPlayer(); });
// 竖向音量：从下往上，点一下也跳过去
(function () {
  const el = $('#p-vol'); if (!el) return;
  const ratio = (e) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
  };
  const set = (r) => { P.vol = r; P.mute = r === 0; paintPlayer(); };
  el.addEventListener('pointerdown', (e) => { el.classList.add('dragging'); el.setPointerCapture(e.pointerId); set(ratio(e)); });
  el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) set(ratio(e)); });
  el.addEventListener('pointerup', () => el.classList.remove('dragging'));
})();

// keyboard: space plays, arrows seek; nothing on the screen performs an entrance
document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#p-play').click(); }
  if (e.key === 'ArrowRight' && nowPlaying()) { P.t = Math.min(nowPlaying().d, P.t + 5); paintPlayer(); }
  if (e.key === 'ArrowLeft' && nowPlaying()) { P.t = Math.max(0, P.t - 5); paintPlayer(); }
});

// phone: the navigation folds into a sheet
$('#menu-toggle').addEventListener('click', () => {
  $('#sidebar').classList.add('open'); $('#scrim').classList.add('on');
});
$('#scrim').addEventListener('click', () => {
  $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('on');
});

/* ------------------------------------------------ 11b. 设置 -------------*/

const SET = {
  eq: '平坦', rg: '按专辑', limiter: true, fade: '3.0', join: true,
  watch: true, autoscan: true,
  lyricPriority: true, enhanced: true, offset: '0',
  accent: 'amber', stage: '星轨',
  cache: true
};
const EQ = {
  '平坦': [0, 0, 0, 0, 0, 0], '流行': [2, -1, 0, 2, 3, 2],
  '摇滚': [4, 2, -1, 1, 2, 4], '爵士': [3, 1, 1, 2, 2, 3],
  '电子': [5, 3, 0, 2, 1, 5], '人声': [-2, -1, 2, 3, 2, -1]
};
const EQ_BANDS = ['60', '150', '400', '1k', '3k', '8k'];
let setTab = 'play';

function eqSVG(vals) {
  const mid = 30, n = 6, bw = 22, gap = (240 - 20 - n * bw) / (n - 1);
  let s = '<svg viewBox="0 0 240 72" preserveAspectRatio="none" role="img" aria-label="六段均衡曲线预览">' +
          '<line x1="0" y1="' + mid + '" x2="240" y2="' + mid + '" stroke="var(--grid)" stroke-width="1"/>';
  vals.forEach((v, i) => {
    const x = 10 + i * (bw + gap), h = Math.max(2, Math.abs(v) / 5 * 24);
    s += '<rect x="' + x + '" y="' + (v >= 0 ? mid - h : mid) + '" width="' + bw + '" height="' + h +
         '" rx="2" fill="var(--accent)"/>';
    s += '<text x="' + (x + bw / 2) + '" y="66" text-anchor="middle" fill="var(--faint)" font-size="9">' +
         EQ_BANDS[i] + '</text>';
  });
  return s + '</svg>';
}
const opt = (vals, cur) => vals.map((v) =>
  '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + '</option>').join('');
const sw = (key, title, desc, on) =>
  '<div class="switch-row"><span class="txt"><div class="t">' + title + '</div><div class="d">' + desc + '</div></span>' +
  '<input class="switch" type="checkbox" data-set-key="' + key + '"' + (on ? ' checked' : '') +
  ' aria-label="' + title + '"></div>';
const row = (title, desc, panel) =>
  '<div class="set-row"><div class="set-label"><h2>' + title + '</h2><p>' + desc + '</p></div>' +
  '<div class="set-panel">' + panel + '</div></div>';

const SET_VIEWS = {
  play: function () {
    return row('音效', '均衡器只在本机解码后生效，不改变文件本身。归一化让不同专辑之间听起来一样响。',
      '<div class="set-field"><label for="eq">六段均衡</label>' +
        '<select class="input" id="eq" data-set-key="eq">' + opt(Object.keys(EQ), SET.eq) + '</select>' +
        '<div class="eq-preview" id="eq-preview">' + eqSVG(EQ[SET.eq]) + '</div></div>' +
      '<div class="set-field"><label for="rg">响度归一化（ReplayGain）</label>' +
        '<select class="input" id="rg" data-set-key="rg">' + opt(['关闭', '按曲', '按专辑'], SET.rg) + '</select>' +
        '<div class="desc">按专辑时，同一张专辑内各曲的相对响度保持不变。</div></div>' +
      sw('limiter', '软限幅', '峰值超过 0 dBFS 时压回来，避免削波。', SET.limiter)) +
    row('衔接', '不满足衔接条件（采样率不同、未预读）时会正常切歌，不做交叉淡化。',
      '<div class="set-field"><label for="fade">交叉淡化</label>' +
        '<select class="input" id="fade" data-set-key="fade">' +
        opt(['0.0', '1.0', '2.0', '3.0', '5.0', '8.0'], SET.fade) + '</select>' +
        '<div class="desc">单位：秒。</div></div>' +
      sw('join', '双流衔接', '已准备本地或缓存曲目时用两条流交叠切换。', SET.join));
  },
  library: function () {
    const dirs = [
      ['D:////音乐////收藏', true], ['D:////音乐////下载', true],
      ['E:////备份////古典', true], ['F:////旧硬盘', false]
    ];
    return row('音乐目录', '移除目录不会删掉你硬盘上的音乐文件，只是不再扫描它。',
      dirs.map((d) => '<div class="dir-row"><span class="p">' + d[0] + '</span>' +
        '<span class="st pill' + (d[1] ? ' pos' : '') + '">' + (d[1] ? '已启用' : '已停用') + '</span></div>').join('') +
      '<div class="set-inline"><button class="btn" data-set-act="scan">' + ic('scan') + '立即扫描</button>' +
      '<button class="btn" data-set-act="manage">' + ic('list') + '管理目录</button></div>') +
    row('自动同步', '监听依赖操作系统通知；网络盘上的改动可能延迟几秒才被发现。',
      sw('watch', '监听文件变化', '目录里增删文件后自动增量扫描。', SET.watch) +
      sw('autoscan', '启动时扫描', '每次启动服务扫一遍已启用的目录。', SET.autoscan));
  },
  lyrics: function () {
    return row('来源优先级', '手动导入 > 音频内嵌标签 > 同名 .lrc。每首曲子还能单独 ±0.5 秒微调。',
      '<div class="switch-row"><span class="txt"><div class="t">1 · 手动导入的 LRC</div>' +
        '<div class="d">导入后随曲库一起备份。</div></span></div>' +
      '<div class="switch-row"><span class="txt"><div class="t">2 · 音频内嵌标签</div>' +
        '<div class="d">FLAC / MP3 里的歌词帧。</div></span></div>' +
      '<div class="switch-row"><span class="txt"><div class="t">3 · 同名 .lrc 文件</div>' +
        '<div class="d">放在音频同目录，文件名与音频相同。</div></span></div>' +
      sw('lyricPriority', '手动导入优先', '关掉后按内嵌标签优先解析。', SET.lyricPriority)) +
    row('时间轴', '逐字时间轴（enhanced LRC）需要文件里带每个字的时间戳，普通 LRC 会自动按行显示。',
      sw('enhanced', '逐字时间轴', '可用时逐字高亮，而不是整行跳。', SET.enhanced) +
      '<div class="set-field"><label for="offset">全局偏移</label>' +
        '<select class="input" id="offset" data-set-key="offset">' +
        opt(['-1.0', '-0.5', '0', '+0.5', '+1.0'], SET.offset) + '</select>' +
        '<div class="desc">单位：秒。只对没有单独微调过的曲目生效。</div></div>');
  },
  look: function () {
    const acc = [['amber', '#F2B33D', '琥珀金'], ['sky', '#4CB3F0', '天蓝'],
                 ['lime', '#A3E635', '青柠'], ['mint', '#4FE0B0', '薄荷青']];
    return row('强调色', '这个色只出现在数据上：图表、进度、正在播放的那一行。它不会跑到按钮和导航上去。',
      '<div class="swatches">' + acc.map((a) =>
        '<button class="swatch-btn" data-accent-set="' + a[0] + '" aria-pressed="' + (SET.accent === a[0]) +
        '" aria-label="' + a[2] + '" title="' + a[2] + '" style="background:' + a[1] + '"></button>').join('') + '</div>' +
      '<div class="desc" style="font-size:13px;color:var(--muted)">当前：' +
      acc.filter((a) => a[0] === SET.accent)[0][2] + '</div>') +
    row('沉浸舞台', '播放时的全屏场景，跟皮肤互不干扰。频谱驱动的场景会跟着音量一起动。',
      '<div class="set-field"><label for="stage">场景</label>' +
        '<select class="input" id="stage" data-set-key="stage">' +
        opt(['星轨', '海岸', '星座', '极光', '影院', '粒子', '关闭'], SET.stage) + '</select>' +
        '<div class="desc">选「关闭」就用纯色背景，省显卡。</div></div>');
  },
  data: function () {
    return row('备份', '导出的 JSON 里不含任何凭据。恢复是幂等的，重复导入不会重复建条目。',
      '<div class="dir-row"><span class="p">C:////Users////miracle////HertzStudio</span>' +
        '<span class="st stamp">数据目录</span></div>' +
      '<div class="set-inline"><button class="btn" data-set-act="export">' + ic('download') + '导出</button>' +
      '<button class="btn" data-set-act="import">' + ic('plus') + '导入</button></div>') +
    row('缓存与危险操作', '缓存可以清掉，重听时重新下载；下面两个动作不可撤销，建议先导出一份。',
      sw('cache', '保留在线曲目缓存', '清掉后重听需要重新拉取。', SET.cache) +
      '<div class="danger-row"><span class="txt"><div class="t">清空播放历史</div>' +
        '<div class="d">会删掉 1,204 条记录，曲库和歌单不受影响。</div></span>' +
        '<button class="btn danger" data-set-act="clear">清空</button></div>');
  }
};

function renderSettings() {
  const names = { play: '播放', library: '曲库', lyrics: '歌词', look: '外观', data: '数据' };
  $('#set-title').textContent = names[setTab];
  $('#set-body').innerHTML = SET_VIEWS[setTab]();
}
function markSaved() {
  const d = new Date();
  $('#set-stamp').textContent = '已保存 · ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
$$('#set-tabs a').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  setTab = a.dataset.set;
  $$('#set-tabs a').forEach((x) => x.setAttribute('aria-selected', String(x === a)));
  renderSettings();
}));
$('#set-body').addEventListener('change', (e) => {
  const k = e.target.dataset.setKey; if (!k) return;
  SET[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (k === 'eq') $('#eq-preview').innerHTML = eqSVG(EQ[SET.eq]);
  if (k === 'accent') document.documentElement.dataset.accent = SET.accent;
  markSaved();
});
$('#set-body').addEventListener('click', (e) => {
  const swatch = e.target.closest('[data-accent-set]');
  if (swatch) {
    SET.accent = swatch.dataset.accentSet;
    document.documentElement.dataset.accent = SET.accent;
    renderSettings(); markSaved(); return;
  }
  const act = e.target.closest('[data-set-act]'); if (!act) return;
  ({
    scan: doScan,
    manage: () => toast('音乐目录：4 个登记，3 个启用', 'list'),
    export: () => toast('已导出：歌单 / 收藏 / 设置 / 播放历史', 'download'),
    import: () => toast('选择备份文件即可恢复（幂等）', 'plus'),
    clear: () => toast('原型不真的清空：这一步需要二次确认', 'dots')
  }[act.dataset.setAct] || (() => {}))();
});

/* ------------------------------------------------ 12. 侧栏折叠 ----------*/

const NAV_KEY = 'hertz.nav.collapsed';

function setCollapsed(on) {
  document.body.classList.toggle('nav-collapsed', on);
  const b = $('#nav-collapse');
  b.setAttribute('aria-expanded', String(!on));
  b.setAttribute('aria-label', on ? '展开侧栏' : '收起侧栏');
  b.title = on ? '展开侧栏' : '收起侧栏';
  try { localStorage.setItem(NAV_KEY, on ? '1' : '0'); } catch (e) {}
  // 画布宽度变了，当前屏的图表要按新宽度重画
  const cur = $$('.screen').filter((s) => s.classList.contains('on'))[0];
  if (!cur) return;
  if (cur.id === 's-home') paintWeekChart(+$('#range button[aria-pressed="true"]').dataset.range || 7);
  if (cur.id === 's-stats') paintStatsCharts();
}
$('#nav-collapse').addEventListener('click', () => setCollapsed(!document.body.classList.contains('nav-collapsed')));

/* --------------------------------------------------------- 13. start ------*/

$('#sw-ctx').textContent = '本机曲库 · Standard · ' + TOTAL + ' 首';
paintHome(); paintLibrary(); paintRadio(); paintPodcast(); paintStats(); renderSettings(); paintPlayer();
show('home');
// 折叠状态记在本机，跟曲库一样不出这台机器
try { if (localStorage.getItem(NAV_KEY) === '1') setCollapsed(true); } catch (e) {}
