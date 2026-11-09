// SPDX-License-Identifier: MIT
// Run the real raster adapter with observable shaping/drawing boundaries.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'tools/space-stage/src/composition/nodes.js'), 'utf8');
const checks = [];
async function raster(text, width, options = {}) {
  const draws = [], measured = [], signal = new AbortController();
  let releases = 0, textures = 0;
  const ctx = { scale() {}, measureText(value) {
    measured.push(value);
    if (options.cancelOnMeasure) signal.abort();
    return { width: (options.measure || (value => [...value].length))(value) };
  }, fillText(value, x, y) { draws.push({ value, x, y, align: this.textAlign }); } };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const realm = { document: { createElement: () => canvas }, DOMException };
  vm.createContext(realm);
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.adapter = loadTextRaster;', realm);
  const font = { family: 'qualified-font', font: { status: 'loaded' } };
  const pool = { has: () => true, acquire: () => ({ ready: Promise.resolve(font), release() { releases++; } }), markOwned: value => value };
  const THREE = { CanvasTexture: class { constructor() { textures++; } dispose() {} }, SRGBColorSpace: 1, LinearFilter: 1 };
  const requirement = { fontRequirement: { identity: 'font' }, widthPx: 64, heightPx: 64,
    scale: 1, fontSize: 10, color: '#ffffff', align: options.align || 'left',
    logicalWidth: width, text, lineHeight: options.lineHeight || 1.2 };
  if (options.cancelInitially) signal.abort();
  let error;
  try { const value = await realm.adapter(THREE, {pool}, requirement, signal.signal, 1); value.release(); value.release(); }
  catch (reason) { error = reason; }
  return { draws, measured, releases, textures, canvas, error };
}
(async () => {
  for (const text of ['Hertz '.repeat(683).slice(0,4096), '\u200e'.repeat(4091) + 'Hertz', '\t'.repeat(4096)]) {
    const result = await raster(text, 16384, { measure: value => [...value].filter(char => char !== '\u200e').length });
    assert(!result.error);
    const normalized = text.replace(/\t/g, '    ');
    assert.equal(result.draws.map(row => row.value).join(''), normalized);
    assert(result.measured.length <= 16, 'a full long row has logarithmically bounded shaping calls');
    assert(result.measured.reduce((sum,value) => sum + [...value].length, 0) <= 4 * [...normalized].length);
    assert.equal(result.releases,1); assert.equal(result.canvas.width,0);
    checks.push('long row preserves every scalar and bounds total shaping work');
  }
  const wrapped = await raster('Hertz Studio Hertz',5);
  assert.deepEqual(wrapped.draws.map(row => row.value),['Hertz',' Stud','io He','rtz']);
  assert(wrapped.measured.reduce((sum,value)=>sum + value.length,0) < 32*18);
  assert.deepEqual(wrapped.draws.map(row=>row.y),[0,12,24,36]);
  checks.push('wrapping consumes all text with bounded work and original line spacing');
  for (const [align,x] of [['left',0],['center',5],['right',10]]) {
    const result=await raster('Hertz\r\n\r\tStudio',10,{align,lineHeight:2});
    assert.deepEqual(result.draws.map(row=>row.value),['Hertz','','    Studio']);
    assert.deepEqual(result.draws.map(row=>row.x),[x,x,x]);
    assert.deepEqual(result.draws.map(row=>row.y),[0,20,40]);
  }
  checks.push('alignment, empty paragraphs, CRLF, TAB and line height remain exact');
  const scalar=await raster('\u{10348}H',0);
  assert.deepEqual(scalar.draws.map(row=>row.value),['\u{10348}','H']);
  checks.push('overwide Unicode scalars are kept whole for clipping');
  const shaped=await raster('AVAVAV',3,{measure:value=>value.length-(value.match(/AV/g)||[]).length*.5});
  assert.equal(shaped.draws.map(row=>row.value).join(''),'AVAVAV');
  for(const row of shaped.draws) assert(row.value.length-(row.value.match(/AV/g)||[]).length*.5<=3);
  checks.push('complete prefixes retain nonadditive shaping measurements');
  const nonmonotonicMeasure=value=>value.length===3?10:value.length;
  const nonmonotonic=await raster('HertzS',5,{measure:nonmonotonicMeasure});
  assert.equal(nonmonotonic.draws.map(row=>row.value).join(''),'HertzS');
  for(const row of nonmonotonic.draws) {
    assert(nonmonotonicMeasure(row.value)<=5);
    assert(nonmonotonic.measured.includes(row.value));
  }
  checks.push('nonmonotonic advances keep only actually measured fitting prefixes');
  for(const options of [{cancelInitially:true},{cancelOnMeasure:true}]) {
    const result=await raster('Hertz',20,options);
    assert.equal(result.error?.name,'AbortError'); assert.equal(result.textures,0);
    assert.equal(result.canvas.width,0); assert.equal(result.draws.length,0);
  }
  checks.push('cancellation before or during layout publishes no raster or partial drawing');
  for(const check of checks) console.log('PASS '+check);
  console.log('text layout checks passed: '+checks.length);
})().catch(error=>{console.error(error);process.exitCode=1;});
