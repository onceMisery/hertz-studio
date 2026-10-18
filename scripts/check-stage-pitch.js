// SPDX-License-Identifier: MIT
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),window={};
vm.runInNewContext(fs.readFileSync(path.join(root,'plugin/ui/creative-pitch.js'),'utf8'),{window});
const P=window.CreativePitch;
function fixture(){return {cached:false,media:{kind:'local-file-sha256-v1',sha256:'0'.repeat(64),byteLength:'64'},
  map:{version:1,algorithm:'nsdf-lowpass-v1',analyzedMs:208,truncated:false,points:[
    {t:64,hz:220,confidence:.99},{t:104,hz:null,confidence:0},{t:144,hz:440,confidence:.98}]}};}
const valid=fixture();assert.equal(P.validate(valid),valid.map);
const curve=P.curve(valid.map);assert.equal((curve.match(/M/g)||[]).length,2);assert.equal((curve.match(/L/g)||[]).length,0,'unvoiced gaps never become a line');
valid.map.points.forEach(p=>p.hz=null);assert.equal(P.curve(valid.map),'','No amplitude-shaped or synthetic fallback');
for(const mutate of [r=>r.map.version=99,r=>r.map.algorithm='unknown',r=>r.map.analyzedMs=720001,
  r=>r.media.sha256='private',r=>r.media.byteLength='2147483649',r=>r.map.points[1].t=64,
  r=>r.map.points[1].t=106,r=>r.map.points[0].hz=54,r=>r.map.points[0].hz=Infinity,
  r=>r.map.points[1].confidence=NaN,r=>r.map.points[0].confidence=1.1,r=>r.map.points.pop()]){
  const bad=fixture();mutate(bad);assert.throws(()=>P.validate(bad));
}
const full=fixture();full.map.analyzedMs=720000;
full.map.points=Array.from({length:17997},(_,i)=>({t:64+i*40,hz:i===700?null:220,confidence:.99}));
P.validate(full);assert.ok(P.curve(full.map).length<30000,'Plot uses a bounded vertex budget');
full.map.points.forEach((p,i)=>p.hz=i%2?null:220);
assert.ok((P.curve(full.map).match(/[ML]/g)||[]).length<=1200,'Many null gaps cannot bypass the vertex budget');
const app=fs.readFileSync(path.join(root,'plugin/ui/app.js'),'utf8');
const block=app.slice(app.indexOf('window.VMusicTransport ='),app.indexOf('async function chooseTransport'));
const ctx={window:{},transport:{post:(...args)=>args}};vm.runInNewContext(block,ctx);
const options={signal:{aborted:false}};
assert.equal(ctx.window.VMusicTransport.post('/v1/stage/pitch',{track_id:'a'},options)[2],options,'Shared transport must forward cancellation options');
const html=fs.readFileSync(path.join(root,'plugin/ui/index.html'),'utf8');
assert.ok(html.indexOf('src="creative-pitch.js"')<html.indexOf('src="workshop.js"'));
assert.ok(fs.readFileSync(path.join(root,'crates/hertz-studio/src/assets.rs'),'utf8').includes('edition_ui!("creative-pitch.js")'));
console.log('Pitch inspector: strict version/time/frequency bounds, null gaps, bounded plot, cancellation transport and shared asset wiring passed');
