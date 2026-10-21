// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
async function main() {
  const source = path.join(root, 'tools/space-stage/src');
  const { createRegistry } = await import(pathToFileURL(path.join(source, 'registry.js')));
  const { createScope } = await import(pathToFileURL(path.join(source, 'scope.js')));
  const { createQuality } = await import(pathToFileURL(path.join(source, 'quality.js')));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/space-stage/.build-manifest.json')));
  for (const [file, expected] of Object.entries(manifest)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex').slice(0,16), expected, 'Stale space bundle: ' + file);
  const bundle = fs.readFileSync(path.join(root, 'plugin/ui/vendor/space-stage.js'), 'utf8');
  assert.ok(bundle.length < 1.6 * 1024 * 1024, 'shared stage bundle size');
  const sandbox = { Math, console, AbortController, setTimeout, clearTimeout };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const api = vm.runInNewContext(fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8') + '\n' + bundle + ';SpaceStagePure', sandbox, { timeout: 15000 });
  for (const key of ['catalog','register','normalizeState','create','effectCatalog']) assert.equal(typeof api[key], 'function');
  const catalog = api.catalog();
  assert.ok(catalog.length > 2); assert.ok(Object.isFrozen(catalog));
  for (const id of ['aurora-dome', 'sound-terrain', 'resonant-rings', 'immersive/aurora', 'aurora', 'immersive/terrain', 'immersive/resonance', 'resonance']) {
    assert.equal(api.resolveId(id), null, 'Removed preset/alias ' + id);
    assert.throws(() => api.normalizeState(id), /Unavailable/);
  }
  assert.ok(catalog.every(def => Object.isFrozen(def) && Object.isFrozen(def.params) && def.capabilities.threejs));
  assert.ok(!catalog.some(def => /anime-svg/.test(def.id + def.aliases.join(' '))));
  const definition = { apiVersion: 1, id: 'contract-orbit', stateVersion: 2, label: 'Contract orbit', category: 'test', preview: '/contract-orbit.webp',
    aliases: ['legacy-contract-orbit'], params: { count: { type:'number',default:20,min:1,max:50,step:1 }, active:{type:'boolean',default:true},
      shape:{type:'select',default:'ring',options:['ring','helix']} }, camera:{radius:8},capabilities:{threejs:true},quality:{},
    create: () => ({ update(){},dispose(){} }), migrateState: value => ({stateVersion:2,params:{count:value.params.oldCount}}) };
  api.register(definition);
  assert.equal(api.catalog().at(-1).id, definition.id);
  assert.equal(api.normalizeState('legacy-contract-orbit').params.count,20);
  assert.equal(api.normalizeState('contract-orbit',{stateVersion:1,params:{oldCount:7}}).params.count,7);
  assert.throws(() => api.register(definition), /Duplicate/);
  assert.throws(() => api.register({...definition,id:'bad-api',apiVersion:99}), /version/);
  assert.throws(() => api.register({...definition,id:'bad-range',aliases:[],params:{count:{type:'number',default:10,min:20,max:1}}}), /range/);
  assert.throws(() => api.register({...definition,id:'bad-camera',aliases:[],camera:{radius:NaN}}), /camera/);
  assert.throws(() => api.register({...definition,id:'bad-camera-bounds',aliases:[],camera:{minRadius:10,maxRadius:1}}), /bounds/);
  assert.throws(() => api.register({...definition,id:'bad-options',aliases:[],params:{item:{type:'select',default:'x',options:['x','x']}}}), /options/);
  assert.throws(() => api.register({...definition,id:'bad-alias',aliases:['coast']}), /Duplicate/);
  assert.throws(() => api.normalizeState('anime-svg'), /Unavailable/);
  assert.throws(() => api.normalizeState('contract-orbit',{params:{count:100}}), /range/);
  assert.throws(() => api.normalizeState('contract-orbit',{params:{active:'yes'}}), /boolean/);
  assert.throws(() => api.normalizeState('contract-orbit',{params:{unknown:1}}), /Unknown/);
  assert.throws(() => api.normalizeState('contract-orbit',{stateVersion:3}), /version/);
  const registry = createRegistry(); registry.register({...definition,aliases:[]});
  assert.deepEqual(registry.validateParams(definition.id,{shape:'helix'},{count:5,active:false}),{count:5,active:false,shape:'helix'});
  const scope = createScope(); let releases=0, callbacks=0;
  const resource={dispose(){releases++;}};
  scope.track(resource);scope.track(resource);scope.defer(()=>callbacks++);
  const target=new EventTarget(); let events=0;scope.listen(target,'sample',()=>events++);
  const child=scope.abortController();scope.timeout(()=>callbacks+=100,1);
  scope.dispose();scope.dispose();target.dispatchEvent(new Event('sample'));
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(releases,1);assert.equal(callbacks,1);assert.equal(events,0);assert.ok(child.signal.aborted);assert.ok(scope.signal.aborted);
  scope.track({dispose(){releases++;}});assert.equal(releases,2,'late allocation released immediately');assert.equal(scope.stats().resources,0);
  const weak=createQuality('high',0);assert.equal(weak.profile().mode,'low');assert.equal(weak.status().qualityMode,'high');
  const detected=createQuality('high',2);assert.ok(detected.setDeviceTier(1));assert.equal(detected.profile().mode,'medium');detected.setMode('high');assert.equal(detected.profile().mode,'medium');assert.equal(detected.setDeviceTier(2),false);
  const quality=createQuality('high',2);assert.equal(quality.profile().mode,'high');assert.ok(quality.dpr(1920,1080,2)<=1.25);
  for(let now=0;now<16000;now+=50) quality.sample(now,{drawCalls:0,points:0,triangles:0,estimatedBytes:0},1);
  assert.notEqual(quality.profile().mode,'high','sustained pressure lowers effective quality');assert.equal(quality.status().qualityMode,'high');
  const lowered=quality.profile().mode;for(let now=16000;now<30000;now+=16.7) quality.sample(now,{drawCalls:0,points:0,triangles:0,estimatedBytes:0},1);
  assert.equal(quality.profile().mode,lowered,'session never automatically upgrades');
  quality.setMode('medium');assert.equal(quality.profile().mode,'medium');assert.equal(quality.status().qualityMode,'medium');
  for(const directory of ['scenes','effects']) {
    for(const file of fs.readdirSync(path.join(source,directory))) {
      if(!file.endsWith('.js'))continue;
      const content=fs.readFileSync(path.join(source,directory,file),'utf8');
      assert.ok(!/requestAnimationFrame|new\s+(?:THREE\.)?WebGLRenderer|new\s+(?:window\.)?AudioContext/.test(content),'plugin owns only world work: '+file);
    }
  }
  console.log(`check-space-stage: registry extension, migration, validation, cleanup, quality, ${catalog.length} scenes and manifest passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
