// SPDX-License-Identifier: MIT
// Real UI + isolated service. Catalog candidates are not human acceptance.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {startFixture}=require('./ui-browser-fixture'),{uiUrl}=require('./ui-token');
async function main(){
  const fixture=await startFixture();process.env.VMUSIC_DATA_DIR=fixture.dataDir;
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:850}});await fixture.connect(context);
  const page=await context.newPage(),errors=[];let aiRequests=0;
  const output=path.resolve('output/playwright/stage-templates');fs.mkdirSync(output,{recursive:true});
  page.on('pageerror',e=>errors.push(e.message));
  try{
    const track=await fixture.seed();await page.goto(uiUrl(fixture.base));
    await page.waitForFunction(()=>window.CreativeTemplates && window.Workshop);
    await page.route('**/v1/ai/**',route=>{aiRequests++;return route.abort();});
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');
      const shelfMode=document.getElementById('s3d-shelf-mode');
      shelfMode.value='side';shelfMode.dispatchEvent(new Event('change',{bubbles:true}));
      const p=CreativeStage.canonicalBaseline('lyric');p.name='Original editable piece';
      p.cues=[{at:1,len:500,set:{'look.bloom':1}}];CreativeStage.setPreset(p);
    });
    assert.equal(await page.locator('.s3d[data-shelf-mode="side"]').count(),1,'The real side-shelf mode must be active');
    async function checkSideShelf(viewport){
      await page.setViewportSize(viewport);await page.waitForTimeout(400);
      await page.locator('.s3d-sc').first().hover();await page.waitForTimeout(700);
      const layout=await page.evaluate(()=>{
        const card=document.querySelector('.s3d-sc:hover')||document.querySelector('.s3d-sc');
        const rectOf=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        const visible=el=>{
          if(!el.textContent.trim()||!el.getClientRects().length)return false;
          for(let node=el;node;node=node.parentElement){
            const style=getComputedStyle(node);
            if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)<=.02)return false;
            if(node.id==='s3d')break;
          }
          return true;
        };
        const text=[...document.querySelectorAll('.s3d-reading .sl-empty strong,.s3d-reading .sl-empty span,.s3d-reading .sl-line[aria-current="true"],#s3d-stanza .fl-classic .fl-cword[data-st="active"] .fl-body,#s3d-stanza .fl-classic .fl-cword[data-st="passed"] .fl-body,#s3d-stanza .fl-classic .fl-empty')].filter(visible);
        const cardRect=rectOf(card),controls=[...document.querySelectorAll('#s3d-settings-toggle,#s3d-player')].filter(visible).map(rectOf);
        const safeArea=document.createElement('div');safeArea.style.cssText='position:absolute;visibility:hidden;padding-bottom:env(safe-area-inset-bottom, 0px)';
        document.body.appendChild(safeArea);const safeBottom=parseFloat(getComputedStyle(safeArea).paddingBottom)||0;safeArea.remove();
        return{card:cardRect,text:text.map(el=>({value:el.textContent.trim(),rect:rectOf(el)})),controls,safeBottom};
      });
      assert.ok(layout.card.x>=0&&layout.card.right<=viewport.width+1,'Hovered side card must stay inside '+viewport.width+'px viewport: '+JSON.stringify(layout.card));
      const bottomClearance=viewport.height<=560?120:180;
      assert.ok(layout.card.bottom<=viewport.height-bottomClearance-layout.safeBottom,
        'Hovered side card must stay above the portrait bottom safe area at '+viewport.width+'x'+viewport.height+': '+JSON.stringify({card:layout.card,safeBottom:layout.safeBottom,bottomClearance}));
      assert.ok(layout.text.length>0,'A visible song/lyric text target must be present');
      const overlaps=layout.text.filter(item=>item.rect.x<layout.card.right&&item.rect.right>layout.card.x&&item.rect.y<layout.card.bottom&&item.rect.bottom>layout.card.y);
      assert.deepEqual(overlaps,[],'Hovered side card must not cover visible song/lyric text at '+viewport.width+'x'+viewport.height+': '+JSON.stringify({card:layout.card,overlaps}));
      const controlOverlaps=layout.controls.filter(rect=>rect.x<layout.card.right&&rect.right>layout.card.x&&rect.y<layout.card.bottom&&rect.bottom>layout.card.y);
      assert.deepEqual(controlOverlaps,[],'Hovered side card must not cover the settings button or player at '+viewport.width+'x'+viewport.height+': '+JSON.stringify({card:layout.card,controlOverlaps}));
      return layout;
    }
    const catalog=await page.evaluate(()=>CreativeTemplates.list());assert.equal(catalog.length,3);
    // Leaving while asynchronous validation is pending cannot publish a late
    // candidate or replace the committed preset.
    const original=await page.evaluate(()=>CreativeStage.preset());
    await page.evaluate(()=>{
      window.realTemplatePrepare=CreativeTemplates.prepare;
      CreativeTemplates.prepare=id=>new Promise((resolve,reject)=>{
        window.finishTemplate=()=>realTemplatePrepare(id).then(resolve,reject);
      });
    });
    await page.locator('[data-template="quiet-orb"]').click();
    await page.waitForFunction(()=>typeof window.finishTemplate==='function');
    await page.evaluate(()=>Workshop.close());
    await page.evaluate(async()=>{await finishTemplate();CreativeTemplates.prepare=realTemplatePrepare;});
    assert.equal(await page.evaluate(()=>CreativeStage.preview()),null);
    assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),original);
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');});
    for(const template of catalog){
      const before=await page.evaluate(()=>({preset:CreativeStage.preset(),library:CreativeStage.library()}));
      await page.locator('[data-template="'+template.id+'"]').click();
      await page.getByRole('button',{name:'取消预览',exact:true}).waitFor();
      await page.waitForTimeout(550);
      assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),before.preset);
      assert.deepEqual(await page.evaluate(()=>CreativeStage.library()),before.library);
      assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('vmusic.creative.preset'))),before.preset);
      assert.equal(await page.evaluate(()=>CreativeStage.scene()),template.scene);
      await page.getByRole('button',{name:'取消预览',exact:true}).click();
      assert.equal(await page.evaluate(()=>CreativeStage.scene()),before.preset.scene);
      await page.locator('[data-template="'+template.id+'"]').click();
      await page.getByRole('button',{name:'应用到当前舞台',exact:true}).waitFor();
      const expected=await page.evaluate(async id=>(await CreativeTemplates.prepare(id)).preset,template.id);
      await page.getByRole('button',{name:'应用到当前舞台',exact:true}).click();
      await page.waitForFunction(name=>!CreativeStage.preview() && CreativeStage.preset().name===name,template.title);
      assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),expected);
      assert.deepEqual(await page.evaluate(()=>CreativeStage.library()),before.library,'Template apply never creates a collection');
      await page.evaluate(()=>Workshop.close());
      await page.waitForFunction(()=>!!CreativeStage.recordingSurface());
      for(const [suffix,viewport]of [['wide',{width:1280,height:850}],['portrait-390',{width:390,height:760}],['portrait-320',{width:320,height:760}],['short-390',{width:390,height:500}],['short-320',{width:320,height:500}]]){
        // Resize and workshop transitions replace WebGL render targets. Check
        // actual scene pixels after they settle, rather than treating a canvas
        // with nonzero dimensions as proof that it has rendered.
        if(viewport.width<=390)await checkSideShelf(viewport);
        else{await page.setViewportSize(viewport);await page.waitForTimeout(400);}
        await page.waitForFunction(async()=>{
          const data=CreativeStage.capture();if(!data)return false;
          const bitmap=await createImageBitmap(await (await fetch(data)).blob());
          const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;
          const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
          const pixels=ctx.getImageData(0,0,c.width,c.height).data;let visible=0;
          for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>16)visible++;
          return visible>8;
        },null,{polling:100,timeout:10000});
        await page.screenshot({path:path.join(output,template.id+'-'+suffix+'.png')});
      }
      await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');});
      const card=page.locator('[data-template-card="'+template.id+'"]');
      assert.equal(await card.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.setViewportSize({width:1280,height:850});
    }
    // Incompatible fixed catalog data must not be re-stamped from the active
    // manifest just to make it appear current.
    await page.evaluate(()=>{window.originalSchemaHash=CreativeStageContract.schemaHash;
      CreativeStageContract.schemaHash='0'.repeat(64);Workshop.render();});
    assert.equal(await page.locator('[data-template]:disabled').count(),3);
    await page.evaluate(()=>{CreativeStageContract.schemaHash=originalSchemaHash;Workshop.render();});
    await page.getByRole('button',{name:'存进工坊',exact:true}).click();
    const saved=await page.evaluate(()=>CreativeStage.library()[0]);assert.equal(saved.name,'墨线地形');
    await page.reload();await page.waitForFunction(()=>window.CreativeTemplates && CreativeStage.preset().name==='墨线地形');
    assert.equal(await page.evaluate(()=>CreativeStage.preview()),null);
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('presets');});
    await page.getByRole('button',{name:'载入并应用',exact:true}).first().click();
    assert.equal(await page.evaluate(()=>CreativeStage.preset().scene),'terrain');
    await page.setViewportSize({width:390,height:760});await page.evaluate(()=>Workshop.setTab('scene'));
    await page.locator('.ws-template-catalog').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,'catalog-390.png')});
    await fixture.api('/v1/tracks/'+encodeURIComponent(track.id)+'/lyrics','PUT',{content:'[00:00.00]第一句歌词保持清晰\n[00:04.00]第二句歌词不被卡片遮住'});
    await page.reload();await page.waitForFunction(()=>window.CreativeTemplates&&window.Workshop);
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');});
    await page.waitForFunction(()=>Stage.lyrics()?.lines?.length===2);
    await page.evaluate(()=>Workshop.close());
    await page.waitForFunction(()=>!!CreativeStage.recordingSurface());
    await fixture.api('/v1/player/seek','POST',{position_ms:3800});
    await page.waitForFunction(()=>Stage.position()>=3800);
    const firstLyric=await page.evaluate(()=>Stage.lyrics().lines[0].text);
    assert.ok(firstLyric.includes('第一句歌词'),'The isolated service must supply the active lyric fixture');
    for(const viewport of [{width:390,height:760},{width:320,height:760},{width:390,height:500},{width:320,height:500}]){
      const layout=await checkSideShelf(viewport);
      assert.ok(layout.text.some(item=>item.value.includes('第一句歌词')),'The active stage lyric must be the checked text target');
      if(viewport.width===390)await page.screenshot({path:path.join(output,'lyrics-stage-390x'+viewport.height+'.png')});
    }
    await page.evaluate(()=>{const visual=document.getElementById('s3d-lyric-visual');visual.value='classic';visual.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelector('#s3d-stanza .fl-classic .fl-cword[data-st="active"] .fl-body'));
    for(const viewport of [{width:390,height:760},{width:320,height:760},{width:390,height:500},{width:320,height:500}]){
      const layout=await checkSideShelf(viewport);
      assert.ok(layout.text.map(item=>item.value).join('').includes('第一句歌词'),'The visible stanza line must contain the checked lyric: '+JSON.stringify(layout.text));
      if(viewport.width===390)await page.screenshot({path:path.join(output,'lyrics-stanza-390x'+viewport.height+'.png')});
    }
    assert.deepEqual(errors,[]);assert.equal(aiRequests,0);
    console.log('PASS 3 template candidates, real preview/cancel/apply, late validation isolation, persistence/collection, fixed-version rejection, hovered side-shelf clearance for empty state, active stage lyrics and stanza lyrics at 320/390px and 500/760px; no AI calls or human acceptance claimed');
  }finally{await context.close();await browser.close();await fixture.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
