// SPDX-License-Identifier: MIT
// 曲库行操作区实测：把 createTrackRow 的真实 DOM 结构 + style.css 的真实规则
// 摆进一个页面，量每个控件的几何与命中归属。
//
// 为什么绕开服务：当前工作区的鉴权改造（token → ticket）未完成，
// `/` 与 `/?ticket=` 都只返回「需要凭据」页，页面里没有业务脚本。
// 但这次改的是**纯 CSS 几何**，与鉴权无关 —— 行的 DOM 由 createTrackRow
// 产出、样式全部来自 style.css，两者都能离线取到，所以离线量到的
// 宽度/重叠/命中结论与线上一致。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.SKIN_SHOT_DIR || 'output/verify-librow';
let pass = 0, fail = 0;
const failures = [];
function ok(c, n, d) { if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); } else { fail++; failures.push(n); console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); } }

// 从 app.js 里抠出 createTrackRow 的 innerHTML 模板，保持与线上同一份产物。
function rowTemplate() {
  const src = fs.readFileSync(path.join(ROOT, 'plugin/ui/app.js'), 'utf8');
  const i = src.indexOf('function createTrackRow(track)');
  if (i < 0) throw new Error('找不到 createTrackRow');
  const s = src.indexOf('row.innerHTML = `', i);
  const e = src.indexOf('`;', s);
  return src.slice(s + 'row.innerHTML = `'.length, e);
}

// 把 index.html 里的真实图标 sprite 抠出来注入测试页。
// 少了它，`<use href="#i-skip-next">` 引用不到任何 symbol 就渲染成空 ——
// 截图上表现为「两个按钮不见了」，看起来像布局把按钮藏了，其实是环境缺件。
function iconSprite() {
  const html = fs.readFileSync(path.join(ROOT, 'plugin/ui/index.html'), 'utf8');
  const s = html.indexOf('<svg id="icon-sprite"');
  if (s < 0) throw new Error('找不到 icon-sprite');
  const e = html.indexOf('</svg>', s);
  return html.slice(s, e + 6);
}

(async () => {
  const css = fs.readFileSync(path.join(ROOT, 'plugin/ui/style.css'), 'utf8');
  const tpl = rowTemplate();
  fs.mkdirSync(OUT, { recursive: true });

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${css}
/* 测试台：给行一个确定的宽度，不依赖视口 */
body { width: 1080px; margin: 0; padding: 20px; background: #141416; }
.track { background: #1c1c20; }
</style></head><body>
${iconSprite()}
<div class="lib-head"><span>#</span><span></span><span>标题</span><span>专辑</span><span>音质</span><span>时长</span><span></span></div>
<div class="lib-list" id="lib"></div>
</body></html>`;

  const file = path.resolve(OUT, 'librow.html');
  fs.writeFileSync(file, html);

  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // file:// 必须绝对路径：相对路径在 Windows 上会解析成盘符根目录下的
  // output/…，报 ERR_FILE_NOT_FOUND（看起来像文件没生成，其实是路径没解析对）。
  await page.goto('file:///' + file.replace(/\\/g, '/'));
  await page.waitForTimeout(500);

  // 按真实结构造 3 行（含红心，红心由 favorites.js 追加在末尾）
  await page.evaluate((tpl) => {
    const lib = document.getElementById('lib');
    const titles = ['夜机', '夜机, 枕星侧', '界面验收 · 01'];
    titles.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'track';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.dataset.id = 'probe-' + idx;
      row.innerHTML = tpl;
      row.querySelector('.t-title').textContent = t;
      row.querySelector('.t-sub').textContent = '张悬';
      row.querySelector('.t-album').textContent = 'Pink Dahlia';
      row.querySelector('.t-quality').textContent = '无损';
      row.querySelector('.t-dur').textContent = '4:10';
      row.querySelector('.t-num').textContent = String(idx + 1);
      // 红心：favorites.js 的 attachHeart 是 appendChild 到 .t-actions 末尾
      const fav = document.createElement('button');
      fav.className = 't-act fav-act';
      fav.dataset.act = 'fav';
      fav.type = 'button';
      fav.title = '加入我的收藏';
      fav.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-heart"/></svg>';
      row.querySelector('.t-actions').appendChild(fav);
      lib.appendChild(row);
    });
  }, tpl);
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const row = document.querySelector('.track');
    const acts = row.querySelector('.t-actions');
    const ar = acts.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const cs = getComputedStyle(acts);
    const kids = [...acts.children].map((c) => {
      const b = c.getBoundingClientRect();
      const ccs = getComputedStyle(c);
      // 命中测试：中心点归属
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return {
        sel: c.tagName.toLowerCase() + (c.className ? '.' + String(c.className).trim().split(/\s+/).join('.') : ''),
        title: c.title || c.getAttribute('aria-label') || '',
        x: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height),
        // 是否越出操作区（= 被挤压的信号）
        overflowRight: Math.round(b.right - ar.right),
        overflowLeft: Math.round(ar.left - b.left),
        display: ccs.display,
        // 命中归属：自己 / 别人（说明被盖住）
        hitsSelf: !!(at && (at === c || c.contains(at))),
        hitBy: at ? at.tagName.toLowerCase() + (at.className ? '.' + String(at.className).split(' ')[0] : '') : null,
      };
    });
    // 相邻控件是否重叠 + 间隙（用于判「勾选框有没有多出一截」）
    const overlaps = [];
    const gaps = [];
    for (let i = 0; i + 1 < kids.length; i += 1) {
      const a = kids[i], b = kids[i + 1];
      gaps.push(b.x - (a.x + a.w));
      if (a.x + a.w > b.x) overlaps.push(`${a.sel}(右${a.x + a.w}) 压 ${b.sel}(左${b.x}) 重叠 ${a.x + a.w - b.x}px`);
    }
    const selCs = getComputedStyle(row.querySelector('.t-select'));
    const selBg = selCs.backgroundColor;
    return {
      row: { w: Math.round(rr.width), h: Math.round(rr.height) },
      acts: { w: Math.round(ar.width), x: Math.round(ar.left), right: Math.round(ar.right),
        display: cs.display, overflow: cs.overflow, scrollW: acts.scrollWidth, clientW: acts.clientWidth },
      kids, overlaps, gaps,
      sel: {
        appearance: selCs.appearance,
        bg: selBg,
        // rgba(0,0,0,0) 的 alpha 是 0；实测未剥掉白块时这里是 1
        bgAlpha: (() => {
          const mm = selBg.match(/rgba?\(([^)]+)\)/);
          if (!mm) return null;
          const parts = mm[1].split(',').map((x) => x.trim());
          return parts.length >= 4 ? Number(parts[3]) : 1;
        })(),
      },
      // 行内容是否横向溢出（挤到看不见）
      rowScrollW: row.scrollWidth, rowClientW: row.clientWidth,
      gridCols: getComputedStyle(row).gridTemplateColumns,
    };
  });

  console.log('\n操作区几何:');
  console.log('  行宽 ' + m.row.w + '  操作区 x=' + m.acts.x + ' w=' + m.acts.w + ' scrollW=' + m.acts.scrollW + '/clientW=' + m.acts.clientW);
  console.log('  栅格: ' + m.gridCols);
  m.kids.forEach((k) => console.log(`  · ${k.sel.padEnd(22)} w=${String(k.w).padStart(3)} h=${String(k.h).padStart(3)} x=${String(k.x).padStart(4)} 越右=${k.overflowRight} 命中=${k.hitsSelf ? '自己' : '被' + k.hitBy}`));
  if (m.overlaps.length) { console.log('  重叠:'); m.overlaps.forEach((o) => console.log('    ! ' + o)); }
  // 截图两张：静息态与 hover 态。操作区是 hover 才显形的（.t-actions
  // opacity:0），只截静息态会看不到那几个按钮 —— 而它们恰恰是这次要验的。
  await page.screenshot({ path: path.join(OUT, 'librow.png'), clip: { x: 700, y: 0, width: 400, height: 200 } });
  // 把 hover 态「定格」再截：直接给操作区写死 opacity，而不是靠鼠标悬停
  // —— 悬停截图在元素移开时容易拍到中间态。
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '.t-actions{opacity:1 !important;}';
    document.head.appendChild(st);
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'librow-hover.png'), clip: { x: 700, y: 0, width: 400, height: 200 } });
  // 勾选态截图：上面判据 10 已经用真实点击勾好了，这里直接拍。
  await page.screenshot({ path: path.join(OUT, 'librow-checked.png'), clip: { x: 700, y: 0, width: 400, height: 200 } });

  // 判据 1：操作区装得下（内容不超容器）
  ok(m.acts.scrollW <= m.acts.clientW + 1,
    '操作区装得下所有控件（没有内容溢出）',
    `scrollW=${m.acts.scrollW} clientW=${m.acts.clientW}`);
  // 判据 2：控件之间不重叠
  ok(m.overlaps.length === 0, '控件之间不重叠', m.overlaps.join('; ') || 'ok');
  // 判据 3：每个控件的命中点都落在自己身上（单击能中）
  const missed = m.kids.filter((k) => !k.hitsSelf);
  ok(missed.length === 0, '每个控件单击都能命中自己',
    missed.length ? missed.map((k) => `${k.sel}→${k.hitBy}`).join(', ') : '全部命中');
  // 判据 4：勾选框在最前
  const first = m.kids[0];
  ok(!!first && first.sel.indexOf('t-select') >= 0, '勾选框排在第一个', first ? first.sel : '(无)');
  // 判据 5：勾选框是方形的（之前是浏览器默认 13px 小方块）
  const sel = m.kids.find((k) => k.sel.indexOf('t-select') >= 0);
  ok(sel && sel.w >= 18 && Math.abs(sel.w - sel.h) <= 2,
    '勾选框尺寸接近正方且 ≥18px（不再是浏览器默认 13px）',
    sel ? `${sel.w}×${sel.h}` : '(无)');
  // 判据 6：图标按钮保持 28px 见方
  const icons = m.kids.filter((k) => k.sel.indexOf('t-act') >= 0);
  const badIcon = icons.filter((k) => k.w < 24 || k.h < 24);
  ok(badIcon.length === 0, '图标按钮未被压扁（≥24px）',
    icons.map((k) => `${k.w}×${k.h}`).join(' '));
  // 判据 7：行没有横向溢出
  ok(m.rowScrollW <= m.rowClientW + 1, '行内容不横向溢出',
    `scrollW=${m.rowScrollW} clientW=${m.rowClientW}`);
  // 判据 8：勾选框未勾选时是**透明底**，不是浏览器默认的白块。
  // appearance:auto 下 Chrome 会拿 accent-color 画未勾选态的底色 ——
  // 实测在 accent-color 偏亮的主题下就是一个刺眼的白方块。
  ok(!!m.sel && m.sel.appearance === 'none' && m.sel.bgAlpha === 0,
    '勾选框自绘外观（未勾选时透明底，不是白方块）',
    m.sel ? `appearance=${m.sel.appearance} bg=${m.sel.bg}` : '(无)');
  // 判据 9：三个间隙大致相等。勾选框多给一截 margin 时它会明显更宽，
  // 整排控件看上去像多了一列空位。
  const gaps = m.gaps || [];
  const spread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0;
  ok(gaps.length >= 2 && spread <= 2, '控件间隙均匀（勾选框没有多出一截）',
    'gaps=' + JSON.stringify(gaps));

  // 判据 10：勾选后**看得见对勾**。这是纯几何量不到的一层 ——
  // 对勾是 ::after 画的，得量它的实际盒子与不透明度。
  // 判据 10：勾选后**看得见对勾**。对勾是 ::after 画的，得量它的实际盒子与不透明度。
  //
  // 必须用**真实点击**而不是 `el.checked = true`：设属性不触发样式重算，
  // 读回来的 opacity 永远是未勾选那档（实测 0），会让人以为对勾没渲染。
  // 「设属性」与「点一下」在这里表现不同，本身就是容易骗过自己的地方。
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '.t-actions{opacity:1 !important;}';
    document.head.appendChild(st);
    document.querySelectorAll('.track')[0].classList.add('hover-for-shot');
  });
  const firstBox = await page.evaluate(() => {
    const b = document.querySelector('.t-select').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(firstBox.x, firstBox.y);
  await page.waitForTimeout(300);
  const tick = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.t-select')];
    const cs = (el, pseudo) => getComputedStyle(el, pseudo);
    const on = cs(boxes[0], '::after');   // 刚点过，已勾选
    // 顺带把勾选态那几行截下来（含坐标，便于对照截图）
    const off = cs(boxes[1], '::after');  // 没点过，未勾选
    return {
      checked: boxes[0].checked,
      onW: parseFloat(on.width) || 0,
      onH: parseFloat(on.height) || 0,
      onOpacity: Number(on.opacity),
      // 对勾是「右边 + 下边」两条边转 45° 画出来的，上/左刻意是 0 ——
      // 所以量描边要看 right/bottom，量 borderTopWidth 永远是 0，
      // 会让人以为整个对勾没渲染出来（我第一版就写错了这一列）。
      onBorderRight: parseFloat(on.borderRightWidth) || 0,
      onBorderBottom: parseFloat(on.borderBottomWidth) || 0,
      onBorderColor: on.borderRightColor,
      offOpacity: Number(off.opacity),
      anchorPosition: cs(boxes[0], null).position,
    };
  });
  ok(tick.checked, '单击勾选框真的切到了勾选态（不是只点了没反应）');
  ok(tick.anchorPosition === 'relative', '勾选框是 ::after 的定位锚点（position:relative）',
    'position=' + tick.anchorPosition);
  ok(tick.onOpacity > 0.9 && tick.offOpacity < 0.1, '对勾只在勾选态显形',
    `on=${tick.onOpacity} off=${tick.offOpacity}`);
  ok(tick.onW >= 4 && tick.onH >= 8
    && tick.onBorderRight >= 1.5 && tick.onBorderBottom >= 1.5,
    '对勾有实际笔画（右边+下边各 ≥1.5px，不是空盒子）',
    `${tick.onW}×${tick.onH} 右${tick.onBorderRight} 下${tick.onBorderBottom}`);
  ok(!!tick.onBorderColor && tick.onBorderColor !== 'rgba(0, 0, 0, 0)',
    '对勾笔画有颜色（不是透明）', tick.onBorderColor);

  console.log('\n' + '─'.repeat(56));
  console.log(`结果：${pass} PASS / ${fail} FAIL`);
  if (failures.length) failures.forEach((f) => console.log('  - ' + f));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });