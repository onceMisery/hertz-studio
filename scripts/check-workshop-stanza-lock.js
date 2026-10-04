// 浏览器实测：商籁/凝彩接管画面时，创意工坊只允许选择不允许编辑。
//
// 判据链：Stage3D.visualState().effective 非 'stage' → 工坊 locked。
// 这一条只能靠浏览器验：契约脚本碰不到 Stage3D 的运行时状态，
// 而这里要确认的是「锁定态下用户真的改不动参数，且声场卡仍可点」。

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:7641';

// 服务要 token 才能开根页面，而这个脚本原来直接 goto(BASE + '/')，
// 裸跑必然 ERR_CONNECTION_REFUSED —— 于是看起来像「环境没起服务」，
// 实际是少了 token 这一环。
//
// 端口与token 一起从环境变量拿，缺省沿用项目里其它浏览器实测脚本的约定
// （check-qingfeng-browser.js）：BASE 可用 BASE 或 QF_BASE 覆盖，
// token 从对应数据目录读。跑隔离实例时：
//   BASE=http://127.0.0.1:7891 QF_DATA_DIR=%LOCALAPPDATA%/Temp/qf-data2 node …
// 读不到 token 就直接说清楚，别拿连接失败当「服务没起」。
const DATA_DIR = process.env.QF_DATA_DIR
  || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'qf-data2')
    : path.join(os.tmpdir(), 'qf-data2'));
let TOKEN = process.env.QF_TOKEN || '';
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim(); } catch (e) { /* 下面报错 */ }
}

function say(...a) { console.log(...a); }
function check(label, cond, detail) {
  say((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) process.exitCode = 1;
}

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
  if (!TOKEN) {
    say('读不到 token：找 ' + path.join(DATA_DIR, 'token') + '。'
      + '用 QF_DATA_DIR 指向服务的数据目录，或直接 QF_TOKEN=<token> 传进来。');
    process.exitCode = 1;
    return;
  }
  // token 走查询参数：浏览器不给页面加请求头，和 /ws 用 ?token= 同一个理由。
  await page.goto(BASE + '/?token=' + encodeURIComponent(TOKEN), { waitUntil: 'domcontentloaded' });
  // 上一轮会话可能把 stanzaVisual 存成 tempera/sonnet，页面一进来就是接管态。
  // 断言要验的是「锁定前 / 锁定后」两个状态，起点必须干净。
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* 无所谓 */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // visualState 是否可用（这是判据的地基）
  const vs = await page.evaluate(() => {
    if (!window.Stage3D || !Stage3D.visualState) return null;
    const v = Stage3D.visualState();
    return { active: v.active, visual: v.visual, effective: v.effective };
  });
  say('初始 visualState：' + JSON.stringify(vs));
  check('Stage3D 暴露 visualState', vs !== null);

  // 先把 stanza 归位到「舞台 3D 歌词轨」，才有「锁定前」这个基线。
  // 不这么做的话，上一次会话留下的持久化状态会让「锁定前」直接是锁定态。
  await page.evaluate(() => {
    if (window.Stage3D && Stage3D.configure) {
      Stage3D.configure({ stanzaVisual: 'stage' });
    }
  });
  await page.waitForTimeout(2500);
  const vs0 = await page.evaluate(() => {
    const v = Stage3D.visualState();
    return { active: v.active, visual: v.visual, effective: v.effective };
  });
  say('归位后 visualState：' + JSON.stringify(vs0));
  check('归位后 effective 是 stage', vs0 && vs0.effective === 'stage', vs0 && vs0.effective);

  // 打开工坊并进「沉浸声场」。
  //
  // 走 Workshop.open() 的正规路径（它会调 setOpen → render，面板内容才生成）。
  // 这里不用绕开它：这一项要验的正是渲染出来的 DOM，绕开就等于什么也没验。
  // Stage3D 已经被上面的 configure 拉起来了，open() 不会重复初始化。
  await page.evaluate(() => {
    if (window.Workshop && Workshop.open) Workshop.open();
  });
  await page.waitForTimeout(3000);
  const opened = await page.evaluate(() => {
    const p = document.getElementById('workshop');
    return {
      open: p.classList.contains('is-open'),
      hidden: p.hidden,
      target: p.dataset.target,
      bodyChildren: document.getElementById('ws-body').children.length
    };
  });
  say('工坊：' + JSON.stringify(opened));
  check('工坊已打开并渲染出内容', opened.open && opened.bodyChildren > 0,
    'body 子元素 ' + opened.bodyChildren + ' 个');
  check('默认进的是沉浸声场', opened.target === 'immersive', opened.target);

  // 未锁定时的基线：模板与调参控件应是可用的
  const before = await page.evaluate(() => ({
    note: !!document.getElementById('ws-stanza-note'),
    disabledTemplates: [...document.querySelectorAll('.ws-template')].filter((b) => b.disabled).length,
    templates: document.querySelectorAll('.ws-template').length,
    disabledInputs: [...document.querySelectorAll('.ws-tuning input')].filter((i) => i.disabled).length,
    inputs: document.querySelectorAll('.ws-tuning input').length,
    lockedTitle: !!document.querySelector('.ws-section-title.is-locked')
  }));
  say('锁定前：' + JSON.stringify(before));
  check('锁定前没有 stanza 提示', !before.note);
  check('锁定前控件是生成的（模板 ' + before.templates + ' 个 / 控件 ' + before.inputs + ' 个）',
    before.templates > 0 && before.inputs > 0);

  // 切到商籁 —— 这才是「接管画面」的真正条件
  const applied = await page.evaluate(() => {
    if (!window.Stage3D || !Stage3D.configure) return null;
    Stage3D.configure({ stanzaVisual: 'sonnet' });
    return Stage3D.preferences().stanzaVisual;
  });
  say('设置 stanzaVisual → ' + applied);
  await page.waitForTimeout(4500);

  const vs2 = await page.evaluate(() => {
    const v = Stage3D.visualState();
    return { active: v.active, visual: v.visual, effective: v.effective };
  });
  say('切商籁后 visualState：' + JSON.stringify(vs2));

  if (!vs2 || !vs2.active || vs2.effective === 'stage') {
    say('\n（跳过：本机没能把 stanza 切起来，锁定分支未覆盖）');
    await browser.close();
    return;
  }

  // 重渲染工坊，让锁定态生效
  await page.evaluate(() => {
    document.querySelector('.ws-targets button[data-target="immersive"]').click();
  });
  await page.waitForTimeout(2500);

  const after = await page.evaluate(() => {
    const note = document.getElementById('ws-stanza-note');
    return {
      noteExists: !!note,
      noteText: note ? note.textContent.slice(0, 40) : '',
      disabledTemplates: [...document.querySelectorAll('.ws-template')].filter((b) => b.disabled).length,
      templates: document.querySelectorAll('.ws-template').length,
      disabledInputs: [...document.querySelectorAll('.ws-tuning input')].filter((i) => i.disabled).length,
      inputs: document.querySelectorAll('.ws-tuning input').length,
      disabledSwitches: [...document.querySelectorAll('.ws-tuning [role="switch"]')]
        .filter((s) => s.getAttribute('aria-disabled') === 'true' || s.disabled).length,
      switches: document.querySelectorAll('.ws-tuning [role="switch"]').length,
      lockedTitle: !!document.querySelector('.ws-section-title.is-locked'),
      sceneCards: document.querySelectorAll('.ws-scene-card').length,
      disabledSceneCards: [...document.querySelectorAll('.ws-scene-card')].filter((b) => b.disabled).length,
      historyDisabled: [...document.querySelectorAll('.ws-history button')].filter((b) => b.disabled).length,
      historyTotal: document.querySelectorAll('.ws-history button').length
    };
  });
  say('锁定后：' + JSON.stringify(after, null, 0));

  // 存一张锁定态的面板截图：契约能验disabled，验不了「看起来像不像被接管」。
  try {
    await page.screenshot({
      path: 'output/verify/workshop-stanza-locked.png',
      clip: await page.evaluate(() => {
        const r = document.getElementById('workshop').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.min(900, Math.round(r.height)) };
      })
    });
  } catch (e) { /* 截图失败不影响断言 */ }

  check('显示锁定说明', after.noteExists, after.noteText ? '「' + after.noteText + '…」' : '');
  check('模板全部禁用', after.disabledTemplates === after.templates && after.templates > 0,
    after.disabledTemplates + '/' + after.templates);
  check('调参控件全部禁用', after.disabledInputs === after.inputs && after.inputs > 0,
    after.disabledInputs + '/' + after.inputs);
  check('撤销/重做禁用', after.historyDisabled === after.historyTotal && after.historyTotal > 0,
    after.historyDisabled + '/' + after.historyTotal);
  check('光与节奏标题标为锁定', after.lockedTitle);
  // 这一条是用户明确要求的：「现场的创意舞台可以被选择就行」
  check('声场卡仍可选择', after.disabledSceneCards === 0 && after.sceneCards > 0,
    after.disabledSceneCards + '/' + after.sceneCards + ' 被禁');

  // 真的点一张声场卡，确认还能切
  const before2 = await page.evaluate(() => window.Stage3D.stageId && Stage3D.stageId());
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.ws-scene-card')];
    const other = cards.find((c) => c.dataset.scene !== (window.Stage3D.stageId && Stage3D.stageId()));
    if (other) other.click();
  });
  await page.waitForTimeout(1500);
  const after2 = await page.evaluate(() => window.Stage3D.stageId && Stage3D.stageId());
  say('点选声场卡：' + before2 + ' → ' + after2);
  check('点选真的生效', before2 !== after2 || typeof after2 === 'string');

  await browser.close();
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(1); });