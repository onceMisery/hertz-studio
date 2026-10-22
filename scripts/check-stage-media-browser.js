// SPDX-License-Identifier: MIT
// Actual service, complete cache and authenticated loopback remote bytes. No
// provider/model calls or real credentials. Native DBX/real NAS are separate.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const http=require('node:http'),crypto=require('node:crypto'),{once}=require('node:events');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {startFixture,writeTaggedWav}=require('./ui-browser-fixture'),{uiToken,uiUrl}=require('./ui-token');
async function main(){
  let body,fixture,browser,context,changed=false;
  const reads=[],errors=[],calls=[];
  const authorization='Basic '+Buffer.from('fixture:only-for-isolated-test').toString('base64');
  const remote=http.createServer((req,res)=>{
    reads.push({method:req.method,path:req.url,authorization:req.headers.authorization || null,range:req.headers.range || null});
    if(req.url.startsWith('/dav/music/') && req.headers.authorization!==authorization){res.writeHead(401).end();return;}
    if(req.url==='/dav/music/redirect.wav'){res.writeHead(302,{Location:'/dav/music-private/leak.wav'}).end();return;}
    const bytes=changed ? Buffer.from(body) : body;if(changed)bytes[bytes.length-1]^=1;
    res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':bytes.length});
    res.end(req.method==='HEAD' ? undefined : bytes);
  });
  remote.listen(0,'127.0.0.1');await once(remote,'listening');
  const origin='http://127.0.0.1:'+remote.address().port;
  try{
    fixture=await startFixture({prepareData(data){
      const cache=path.join(data,'cache','online');fs.mkdirSync(cache,{recursive:true});
      const file=path.join(cache,'ccmixter-media-fixture-standard.wav');writeTaggedWav(file);body=fs.readFileSync(file);
      // A different existing quality must never replace the bytes chosen for playback.
      const other=Buffer.from(body);other[other.length-1]=1;fs.writeFileSync(path.join(cache,'ccmixter-media-fixture-exhigh.wav'),other);
    }});
    process.env.VMUSIC_DATA_DIR=fixture.dataDir;
    const local=await fixture.seed();
    browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
    context=await browser.newContext({viewport:{width:1280,height:850},acceptDownloads:true});await fixture.connect(context);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='POST' && /\/v1\/ai\/jobs$/.test(r.url()))calls.push(r.url());});
    await page.goto(uiUrl(fixture.base));
    const selected=id=>page.waitForFunction(id=>Stage.presentation().track?.id===id && Stage.presentation().mediaTrackId===id,id);
    await selected(local.id);
    await page.evaluate(async()=>{
      const p=CreativeStage.canonicalBaseline('orb');p.director=false;p.look.bloom=0;
      p.cues=[{at:1,len:1000,ease:'linear',set:{'look.bloom':1}}];CreativeStage.setPreset(p);
      CreativeProject.apply(await CreativeProject.capture(true),CreativeStage.revision());
      Workshop.open();Workshop.setTab('io');
    });
    const legacy=await page.evaluate(()=>CreativeStage.preset().project.media);
    assert.equal(legacy.kind,'local-file-sha256-v1');
    await fixture.api('/v1/online/play','POST',{source:'ccmixter',id:'media-fixture',title:'Cached media fixture',duration_ms:30000});
    await fixture.api('/v1/player/pause','POST',{});await selected('online:ccmixter:media-fixture');
    const online=await fixture.api('/v1/stage/project-media','POST',{track_id:'online:ccmixter:media-fixture'});
    assert.equal(online.kind,'file-sha256-v1');assert.equal(online.sha256,legacy.sha256);
    assert.equal(online.sha256,crypto.createHash('sha256').update(body).digest('hex'));
    assert.deepEqual(await fixture.api('/v1/stage/project-media','POST',{track_id:'online:ccmixter:media-fixture'}),online,
      'Another existing quality cannot replace the bytes selected for playback');
    await page.locator('[data-project="bind"]').click();
    await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    const downloads=page.waitForEvent('download');await page.locator('[data-project="save"]').click();
    const projectBytes=fs.readFileSync(await(await downloads).path());
    assert.deepEqual(JSON.parse(projectBytes).media,online);
    assert.equal(reads.length,0,'Cache confirmation never contacts the remote fixture');
    const root=await fixture.api('/v1/remote/roots','POST',{name:'Isolated fixture',base_url:origin+'/dav/music',username:'fixture',password:'only-for-isolated-test'});
    await fixture.api('/v1/remote/roots/'+root.id+'/import','POST',{paths:['same.wav','../music-private/leak.wav','redirect.wav']});
    const tracks=(await fixture.api('/v1/tracks?limit=20')).tracks;
    const track=tracks.find(t=>t.source==='remote' && t.path.endsWith('/same.wav'));
    const leaked=tracks.find(t=>t.source==='remote' && t.path.endsWith('/leak.wav'));
    const redirect=tracks.find(t=>t.source==='remote' && t.path.endsWith('/redirect.wav'));
    assert.ok(track && leaked && redirect);
    const beforeRead=reads.length;
    const headers={Authorization:'Bearer '+uiToken()};
    const denied=await context.request.post(fixture.base+'/v1/stage/project-media',{headers,data:{track_id:track.id}});
    assert.equal(denied.status(),422);assert.equal((await denied.json()).error.code,'project_media_remote_consent');
    assert.equal(reads.length,beforeRead,'No GET/HEAD before explicit remote permission');
    const remoteIdentity=await fixture.api('/v1/stage/project-media','POST',{track_id:track.id,allow_remote_read:true});
    assert.deepEqual(remoteIdentity,online);
    assert.deepEqual(reads.at(-1),{method:'GET',path:'/dav/music/same.wav',authorization,range:null});
    await fixture.api('/v1/stage/project-media','POST',{track_id:leaked.id,allow_remote_read:true});
    assert.equal(reads.at(-1).path,'/dav/music-private/leak.wav');assert.equal(reads.at(-1).authorization,null,'Sibling paths never receive directory credentials');
    const beforeRedirect=reads.length;
    const rejected=await context.request.post(fixture.base+'/v1/stage/project-media',{headers,data:{track_id:redirect.id,allow_remote_read:true}});
    assert.equal(rejected.status(),422);assert.equal(reads.length,beforeRedirect+1,'Redirects are never followed');
    await fixture.api('/v1/player/load','POST',{track_id:track.id});await fixture.api('/v1/player/pause','POST',{});await selected(track.id);
    await page.locator('[data-project="bind"]').click();
    await page.getByText('请先允许读取远程完整音频，再确认媒体内容',{exact:false}).waitFor();
    assert.equal(await page.locator('[data-project="remote-read"]').isChecked(),false);
    await page.locator('[data-project="remote-read"]').check();await page.locator('[data-project="bind"]').click();
    await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    changed=true;await page.locator('[data-project="bind"]').click();
    await page.getByText('当前文件与工程媒体内容不匹配，未绑定',{exact:false}).waitFor();
    assert.match(await page.evaluate(()=>CreativeProject.status()),/等待/);
    changed=false;await page.locator('[data-project="bind"]').click();
    await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    await page.reload();await page.waitForFunction(()=>window.CreativeProject && CreativeStage.preset().project);
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('io');});
    assert.equal(await page.locator('[data-project="remote-read"]').isChecked(),false,'Remote permission is not saved with the project or UI');
    assert.match(await page.evaluate(()=>CreativeProject.status()),/等待/);
    await page.setViewportSize({width:390,height:760});
    await page.waitForFunction(()=>{
      const rect=document.querySelector('#workshop').getBoundingClientRect();
      return rect.x>=0 && rect.right<=391;
    });
    const out=path.resolve(process.env.UI_CHECK_OUT || path.join(__dirname,'../output/stage-media'));fs.mkdirSync(out,{recursive:true});
    await page.screenshot({path:path.join(out,'media-confirmation-390.png')});
    const panel=await page.locator('#workshop').boundingBox();assert.ok(panel.x>=0 && panel.x+panel.width<=391,JSON.stringify(panel));
    assert.ok(!projectBytes.includes(Buffer.from(origin)));assert.ok(!projectBytes.includes(Buffer.from('only-for-isolated-test')));
    assert.deepEqual(errors,[]);assert.deepEqual(calls,[]);
    console.log('PASS real complete cache/exact quality, authenticated remote full GET/permission/no redirects, credential path isolation, legacy/generic project binding, changed-content refusal, reload invalidation and 390px UI; no model calls');
  }finally{
    if(context)await context.close();if(browser)await browser.close();if(fixture)await fixture.close();
    remote.closeAllConnections();await new Promise(resolve=>remote.close(resolve));
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
