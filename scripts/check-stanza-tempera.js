'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.join(__dirname, '../plugin/ui');
const source = fs.readFileSync(path.join(web, 'stanza/stanza-tempera.js'), 'utf8');
const util = require(path.join(web, 'stanza/stanza-util.js'));
const effects = require(path.join(web, 'stanza/stanza-sonnet-fx.js'));

function element() {
  return { hidden: false, style: {}, append() {}, remove() {} };
}

async function main() {
  let finishInit;
  let destroyed = 0;
  let applications = 0;
  const ready = new Promise(resolve => { finishInit = resolve; });
  const context = {
    module: { exports: {} }, console,
    StanzaUtil: util, StanzaSonnetFx: effects,
    document: { createElement: element },
    Stage: { kick() {} },
    StanzaSonnet: {
      buildFrame: () => ({ reduced: false }),
      loadPixi: async () => ({
        Application: class {
          constructor() { applications += 1; }
          init() { return ready; }
          destroy() { destroyed += 1; }
        }
      })
    }
  };
  vm.runInNewContext(source, context);
  const tempera = context.module.exports;
  const theme = { backgroundColor: '#14100c', primaryColor: '#f5ead9', accentColor: '#d9ad61', secondaryColor: '#b46e4c' };
  for (const mode of tempera.COLOR_MODES) {
    const colors = tempera.palette(theme, mode);
    assert.equal(colors.tones.length, 4);
    assert.ok(colors.tones.every(color => /^#[a-f\d]{6}$/i.test(color)));
    assert.equal(colors.ink, theme.primaryColor);
  }
  for (const kind of tempera.COMPOSITION_KINDS) {
    assert.equal(tempera.compositionKind('track:12', { composition: kind }), kind);
    for (const [width, height] of [[320, 740], [1440, 900], [844, 390]]) {
      const panels = tempera.buildPanels(kind, width, height, 'track:12');
      assert.ok(panels.length >= 2);
      assert.ok(panels.every(panel => panel.poly.every(Number.isFinite)));
      assert.deepEqual(panels, tempera.buildPanels(kind, width, height, 'track:12'));
    }
  }
  assert.ok(tempera.COMPOSITION_KINDS.includes(tempera.compositionKind('track:12', { composition: 'unknown' })));
  const row = { glyphs: [{left:10, width:40, start:1, end:2}, {left:50, width:40, start:2, end:3}] };
  assert.equal(tempera.sweepExtent(row, 0), null);
  assert.equal(tempera.sweepExtent(row, 1.5).right, 30);
  assert.equal(tempera.sweepExtent(row, 2.5).right, 70);
  assert.equal(tempera.sweepExtent(row, 20).right, 90);
  assert.equal(tempera.sweepExtent(row, 0.5), null);

  const renderer = tempera.init(element(), () => {});
  assert.equal(applications, 0);
  renderer.setVisible(true);
  await Promise.resolve();
  assert.equal(applications, 1);
  renderer.destroy();
  assert.equal(destroyed, 0);
  finishInit();
  await ready;
  await Promise.resolve();
  assert.equal(destroyed, 1);
  renderer.destroy();
  assert.equal(destroyed, 1);

  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  const host = fs.readFileSync(path.join(web, 'stage3d.js'), 'utf8');
  assert.ok(html.indexOf('src="stanza/stanza-tempera.js"') > html.indexOf('src="stanza/stanza-sonnet.js"'));
  assert.ok(html.indexOf('src="stanza/stanza-tempera.js"') < html.indexOf('src="stage3d.js"'));
  assert.match(html, /option value="tempera"/);
  for (const id of ['composition', 'color-mode', 'screens', 'inversion']) {
    assert.ok(html.includes('id="s3d-fl-' + id + '"'));
    assert.ok(host.includes("'s3d-fl-" + id + "'"));
  }
  console.log('凝彩检查通过：构图、色彩、扫光时间轴、惰性初始化取消与资源接线');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
