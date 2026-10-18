// SPDX-License-Identifier: MIT
// Controlled lifecycle faults against the actual exporter. Browser codec and
// canvas capture are verified separately by check-video-export-browser.js.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let clock = 1, serial = 0;
  const timers = new Map(), frames = new Map(), tracks = [], recorders = [], requests = [], urls = new Set();
  const env = {displayCalls:0,draws:[],downloads:[],track:{id:'track-a',title:'Fixture'},fail:'',media:null};
  class Events {
    constructor() { this.events = new Map(); }
    addEventListener(name,fn) { const set = this.events.get(name) || new Set(); set.add(fn); this.events.set(name,set); }
    removeEventListener(name,fn) { this.events.get(name)?.delete(fn); }
    emit(name,data={}) { for(const fn of [...(this.events.get(name) || [])]) fn(data); }
  }
  class Track extends Events {
    constructor(kind) { super(); this.kind=kind; this.readyState='live'; tracks.push(this); }
    stop() { this.readyState='ended'; }
    end() { this.stop(); this.emit('ended'); }
  }
  class Stream {
    constructor(items=[]) { this.items=items.slice(); }
    getTracks() { return this.items.slice(); }
    getVideoTracks() { return this.items.filter(t=>t.kind==='video'); }
    getAudioTracks() { return this.items.filter(t=>t.kind==='audio'); }
    addTrack(track) { this.items.push(track); }
  }
  const timeout = (fn,ms,interval=0) => { const id=++serial; timers.set(id,{fn,at:clock+ms,interval}); return id; };
  class Element extends Events {
    constructor(tag) { super(); this.tagName=tag; this.style={}; this.children=[]; this.hidden=false; this.nodes=new Map();
      this.value=''; this.width=320; this.height=180; this.videoWidth=320; this.videoHeight=180; }
    set innerHTML(text) { this.html=text; this.nodes.clear(); }
    get innerHTML() { return this.html || ''; }
    querySelector(selector) {
      const value = selector.startsWith('#') ? selector.slice(1) : selector.startsWith('.') ? selector.slice(1)
        : selector.match(/data-vex="([^"]+)"/)?.[1];
      if(!value || !this.innerHTML.includes(value)) return null;
      if(!this.nodes.has(selector)) {
        const node=new Element('control');
        node.value=selector==='#vex-preset'?'720p':selector==='#vex-origin'?'current':'';
        node.checked=true; node.disabled=/data-vex="stop" disabled/.test(this.innerHTML);
        this.nodes.set(selector,node);
      }
      return this.nodes.get(selector);
    }
    appendChild(node) { this.children.push(node); node.parentNode=this; return node; }
    removeChild(node) { this.children=this.children.filter(child=>child!==node); node.parentNode=null; }
    remove() { this.parentNode?.removeChild(this); }
    setAttribute() {}
    click() { if(this.tagName==='a') { if(env.fail==='download') throw Error('download denied'); env.downloads.push(this.download); } else this.onclick?.(); }
    set srcObject(value) { this.stream=value; if(value && env.fail!=='decode') timeout(()=>this.onloadeddata?.(),0); }
    play() { return env.fail==='play-video'?Promise.reject(Error('video denied')):Promise.resolve(); }
    pause() {}
    captureStream() { const track=new Track('video'); this.lastStream=new Stream([track]); return this.lastStream; }
    getContext() {
      if(env.fail==='context') return null;
      return {fillRect(){},drawImage(){if(env.fail==='draw') throw Error('draw failed');},save(){},restore(){},
        fillText(text){env.draws.push(text);}};
    }
  }
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('video/webm'); }
    constructor(stream,opts) { if(env.fail==='constructor') throw Error('encoder unavailable');
      this.stream=stream; this.mimeType=opts.mimeType; this.state='inactive'; recorders.push(this); }
    start() {
      if(env.fail==='start') throw Error('encoder start failed'); this.state='recording';
      if(env.fail!=='encoder-timeout') timeout(()=>this.onstart?.(),env.encoderDelay || 0);
    }
    stop() {
      if(this.state==='inactive') throw Error('inactive');
      this.state='inactive';
      if(env.fail==='stop-event') return;
      timeout(()=>{this.ondataavailable?.({data:new Blob(['final'])});this.onstop?.();},0);
    }
    chunk(text) { this.ondataavailable?.({data:new Blob([text])}); }
  }
  const document = new Events(); document.body=new Element('body'); document.hidden=false;
  document.createElement=tag=>new Element(tag);
  const window=new Events(); window.window=window;
  const source=new Element('canvas');
  env.surface={canvas:source,source:'creative',ownsLyrics:false};
  const sandbox={window,document,console,Blob,Set,Promise,AbortController,HTMLCanvasElement:Element,MediaStream:Stream,MediaRecorder:Recorder,
    URL:{createObjectURL(){const url='blob:'+ ++serial;urls.add(url);return url;},revokeObjectURL(url){urls.delete(url);}},
    localStorage:{getItem(){return null;},setItem(){}},performance:{now:()=>clock},Date:{now:()=>clock},
    navigator:{mediaDevices:{getDisplayMedia(){env.displayCalls++;return env.media || Promise.resolve(new Stream([new Track('video'),new Track('audio')]));}}},
    setTimeout:timeout,clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>timeout(fn,ms,ms),clearInterval:id=>timers.delete(id),
    requestAnimationFrame:fn=>{const id=++serial;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
    Stage3D:{open(){},recordingSurface:()=>env.surface},Stage:{presentation:()=>({track:env.track}),position:()=>1200},
    fetch:async(route,opts)=>{
      requests.push({route,opts});
      if(env.fetch) return env.fetch(route,opts);
      return {ok:env.fail!=='seek',status:503,json:async()=>({track_id:env.track?.id || null,title:'Fresh title',artist:'Fixture',
        lines:[{startTime:0,endTime:10,text:'Fresh lyric'}],position_ms:1200,playing:false})};
    }};
  window.Stage3D=sandbox.Stage3D; window.Stage=sandbox.Stage;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin/ui/video-export.js'),'utf8'),sandbox);
  const flush=async()=>{for(let i=0;i<20;i++) await Promise.resolve();};
  async function advance(ms) {
    await flush(); const end=clock+ms;
    for(let turns=0;turns<10000;turns++) {
      const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next) {clock=end;await flush();return;}
      const [id,timer]=next; clock=timer.at;
      if(timer.interval) timer.at+=timer.interval; else timers.delete(id);
      timer.fn(); await flush();
    }
    throw Error('Unbounded timer loop');
  }
  const api=window.VideoExport;
  return {api,env,tracks,recorders,requests,document,window,urls,timers,frames,Track,Stream,flush,advance,
    async start(opts={}) { const done=api.begin({preset:{id:'720p'},...opts}); await advance(1200); await advance(1);
      assert.equal(api.status().phase,'recording'); return {done}; },
    async frame(){clock+=16;const entries=[...frames];frames.clear();for(const [,fn]of entries)fn();await flush();},
    async ended(done){await advance(1);const result=await done;assert.equal(api.status().phase,'idle');
      assert.ok(tracks.every(t=>t.readyState==='ended'),'Every owned capture track is stopped');
      assert.equal(document.body.children.filter(node=>node.tagName==='video').length,0);
      assert.equal(frames.size,0);await advance(30001);assert.equal(urls.size,0);assert.equal(timers.size,0);return result;}
  };
}

async function main() {
  let h=harness();
  let {done}=await h.start({systemAudio:true});
  assert.equal(h.env.displayCalls,1);
  assert.equal(h.api.status().audioMode,'system');
  assert.equal(h.recorders[0].stream.getAudioTracks().length,1);
  await assert.rejects(()=>h.api.begin({}),/准备、进行或保存/);
  h.api.open(); assert.ok(h.document.body.children.find(node=>node.className==='vex-scrim')
    .querySelector('.vex-body').querySelector('[data-vex="stop"]'));
  h.recorders[0].chunk('first');
  const staleStop=h.recorders[0].onstop;
  const stopping=h.api.stop(); assert.equal(h.api.status().phase,'stopping');
  await assert.rejects(()=>h.api.begin({}),/准备、进行或保存/);
  const result=await h.ended(done); await stopping;
  assert.equal(result.bytes,10,'Final dataavailable must be included before download');
  assert.equal(result.downloadRequested,true);
  assert.ok(result.filename.endsWith('.webm'));
  ({done}=await h.start()); staleStop(); assert.equal(h.api.status().phase,'recording');
  h.api.stop(); await h.ended(done);

  h=harness();h.env.encoderDelay=2400;
  done=h.api.begin({preset:{id:'720p'}});await h.advance(1201);
  assert.equal(h.api.status().phase,'starting','start() alone does not prove the native encoder is ready');
  await h.frame();await h.advance(2400);assert.equal(h.api.status().phase,'recording');
  h.api.stop();await h.ended(done);
  h=harness();h.env.encoderDelay=2400;
  done=h.api.begin({preset:{id:'720p'},systemAudio:true});await h.advance(1201);
  await h.api.stop();await h.ended(done);
  h=harness();h.env.fail='encoder-timeout';
  const encoderFailure=h.api.begin({preset:{id:'720p'},systemAudio:true}).catch(error=>error);
  await h.advance(11201);assert.match((await encoderFailure).message,/编码器启动超时/);
  assert.ok(h.tracks.every(track=>track.readyState==='ended'));

  h=harness();let grant;
  h.env.media=new Promise(resolve=>{grant=resolve;});
  const cancelled=h.api.begin({systemAudio:true});
  assert.equal(h.env.displayCalls,1,'Display capture is requested before the first await');
  await h.api.stop(); assert.equal((await cancelled).bytes,0);
  ({done}=await h.start());
  const late=new h.Stream([new h.Track('audio'),new h.Track('video')]);grant(late);await h.flush();
  assert.ok(late.getTracks().every(t=>t.readyState==='ended'));
  assert.equal(h.api.status().phase,'recording','Late permission never replaces a new session');
  h.api.stop();await h.ended(done);

  for(const failure of ['constructor','context','start','seek','play-video','draw']) {
    h=harness();h.env.fail=failure;
    const failed=h.api.begin({systemAudio:true,fromStart:failure==='seek'});
    const caught=failed.catch(error=>error);
    await h.advance(1200);await h.advance(1);
    assert.ok(await caught instanceof Error || (await caught)?.message);
    assert.equal(h.api.status().phase,'idle',failure);
    assert.ok(h.tracks.every(t=>t.readyState==='ended'),failure+' releases audio and video');
    assert.equal(h.env.downloads.length,0,'Startup failure must not download an empty file');
    await h.advance(30001);assert.equal(h.timers.size,0,failure);
  }
  h=harness();h.env.media=Promise.reject(Error('permission denied'));
  ({done}=await h.start({systemAudio:true}));assert.equal(h.api.status().audioMode,'silent');
  h.api.stop();assert.match((await h.ended(done)).filename,/-silent\.webm$/);

  for(const interruption of ['visibility','track','source','context','audio','draw','recorder']) {
    h=harness();({done}=await h.start({systemAudio:true}));h.recorders[0].chunk('part');
    if(interruption==='visibility'){h.document.hidden=true;h.document.emit('visibilitychange');}
    if(interruption==='track'){h.env.track={id:'track-b'};await h.frame();}
    if(interruption==='source'){h.env.surface=null;await h.frame();}
    if(interruption==='context')h.env.surface.canvas.emit('webglcontextlost');
    if(interruption==='audio')h.recorders[0].stream.getAudioTracks()[0].end();
    if(interruption==='draw'){h.env.fail='draw';await h.frame();}
    if(interruption==='recorder'){
      const recorder=h.recorders[0];recorder.state='inactive';recorder.onerror();
      recorder.chunk('last');recorder.onstop();
    }
    const partial=await h.ended(done);assert.ok(partial.bytes>=4,interruption+' preserves existing chunks');
  }
  h=harness();({done}=await h.start());h.recorders[0].chunk('part');h.env.fail='stop-event';h.api.stop();
  await h.advance(5000);assert.equal((await h.ended(done)).bytes,4,'Missing stop event has a bounded partial-save path');
  h=harness();({done}=await h.start());h.recorders[0].chunk('part');
  h.recorders[0].ondataavailable({data:{size:256*1024*1024+1}});
  assert.ok(h.api.status().bytes<=256*1024*1024);
  assert.match((await h.ended(done)).message,/缓冲已满/);
  h=harness();({done}=await h.start());await h.advance(10*60*1000+1);
  assert.match((await h.ended(done)).message,/10 分钟/);

  h=harness();let lateLyrics;
  h.env.fetch=async()=>({ok:true,json:()=>new Promise(resolve=>{lateLyrics=resolve;})});
  ({done}=await h.start());await h.advance(1000);assert.equal(h.requests.length,1,'Lyric polls never overlap');
  h.api.stop();await h.ended(done);
  h.env.fetch=async()=>({ok:true,json:async()=>({track_id:'track-a',title:'Fresh',lines:[{startTime:0,text:'Fresh lyrics'}]})});
  ({done}=await h.start());lateLyrics({title:'OLD SESSION',lines:[{startTime:0,text:'OLD LYRICS'}]});await h.flush();
  await h.frame();assert.ok(!h.env.draws.some(text=>text.includes('OLD')),'Late old lyrics never enter the next recording');
  h.api.stop();await h.ended(done);

  h=harness();h.env.fail='decode';
  const decodeFailure=h.api.begin({systemAudio:true}).catch(error=>error);
  await h.advance(6201);assert.match((await decodeFailure).message,/未收到舞台画面/);
  assert.ok(h.tracks.every(track=>track.readyState==='ended'));
  h=harness();({done}=await h.start());h.recorders[0].chunk('part');h.env.fail='download';h.api.stop();
  const undownloaded=await h.ended(done);assert.equal(undownloaded.bytes,9);assert.equal(undownloaded.downloadRequested,false);
  h.env.fail='';h.api.open();const scrim=h.document.body.children.find(node=>node.className==='vex-scrim');
  scrim.querySelector('.vex-body').querySelector('[data-vex="download"]').onclick();
  assert.equal(h.env.downloads.length,1,'Generated content remains available for a manual download retry');
  await h.advance(30001);
  console.log('Video export lifecycle: startup/stop isolation, late permission, final chunks, real audio-track facts, all failure cleanup, interruptions, bounded stop and download retry passed');
}
if(require.main===module) main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={harness};
