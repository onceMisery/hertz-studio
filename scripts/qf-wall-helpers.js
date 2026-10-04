// 清风海报墙的浏览器实测公用件。
//
// 为什么单独抽出来：`check-qingfeng-browser.js` 与 `check-qingfeng-wall.js`
// 都要真的去点墙上的卡片，而**这件事不能用 playwright 的 locator.click /
// page.click** —— 两份脚本各写一遍踩同一个坑的话，修一次只救一处，
// 另一处会以「莫名其妙的红」形式回来。所以把坑和正确写法写在一处。
'use strict';

/// 真的点墙上那张卡。
///
/// **不能用 locator.click / page.click**：它会先 scrollIntoViewIfNeeded，
/// 而海报墙是「transform 相机 + 自己滚动的 field 容器」，滚一下相机偏移就变，
/// playwright 随后按旧坐标点下去 —— 实测事件落在 `.qf-lattice-field` 上，
/// 卡片纹丝不动，而且**不报任何错**。
///
/// 用 `page.mouse.click(x, y)`：命中点在页面里算（坐标是相机变换后的视口坐标，
/// 外面算不出来），它走 CDP 派发**真实输入**且**不做滚动**。
///
/// 也不能自己在页面里 dispatchEvent 派合成 PointerEvent —— 那种事件没有
/// active pointer，墙的 setPointerCapture 会抛 NotFoundError，
/// 还会污染「运行期无报错」那条断言。
async function clickPoster(page, selector) {
  const hit = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { err: 'no element' };
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const target = document.elementFromPoint(x, y);
    if (!target) return { err: 'no hit', x, y };
    // 点没落在自己（或自己的子节点）身上就别硬点 —— 那样测的是
    // 「点在了遮挡物上时会发生什么」，不是「点这张卡会发生什么」。
    if (!(target === el || el.contains(target))) {
      return { err: 'covered', by: target.tagName + '.' + (target.className || '') };
    }
    return { x, y, hit: target.tagName };
  }, selector);
  if (hit.err) throw new Error('clickPoster: ' + JSON.stringify(hit));
  await page.mouse.click(hit.x, hit.y);
  return { x: Math.round(hit.x), y: Math.round(hit.y), hit: hit.hit };
}

/// 在候选里挨个试，直到有一个点得着（返回成功的那个）。
///
/// 为什么需要「挨个试」：墙上开了展开卡之后，它会占住视口中心并盖住
/// 邻近的卡；而 lattice 是密排的，卡与卡之间没有「空白」可点。
/// 只挑一个候选的话，很可能正好挑到被展开卡盖住的那张 ——
/// clickPoster 会因为「命中点不在自己身上」而拒绝（covered），
/// 那不是缺陷，是选点选错了，得换一张。
async function clickFirstPoster(page, selectors) {
  const tried = [];
  for (const sel of selectors) {
    try {
      const r = await clickPoster(page, sel);
      return { selector: sel, ...r };
    } catch (err) {
      tried.push(sel + ' -> ' + err.message.replace('clickPoster: ', ''));
    }
  }
  throw new Error('clickFirstPoster: 全部候选都点不着\n    ' + tried.join('\n    '));
}

module.exports = { clickPoster, clickFirstPoster };