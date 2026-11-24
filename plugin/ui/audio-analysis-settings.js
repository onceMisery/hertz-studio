// SPDX-License-Identifier: MIT
(function(){
  'use strict';
  function requestId(){
    if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
    var bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    var hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  }
  function init(options){
    var form=document.getElementById('audio-analysis-settings'),impulse=document.getElementById('audio-impulse-import');
    if(!form||!impulse)return;
    var status=document.getElementById('loudness-state'),busy=false;
    async function current(){var snapshot=await options.transport.get('/v1/state');if(!snapshot.track_id)throw new Error('当前没有曲目');return snapshot.track_id;}
    async function perform(action){
      if(busy)return;busy=true;form.setAttribute('aria-busy','true');form.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{await action();}catch(error){status.textContent=String(error&&error.message||error);}finally{busy=false;form.setAttribute('aria-busy','false');form.querySelectorAll('button').forEach(b=>b.disabled=false);}
    }
    form.addEventListener('submit',function(event){event.preventDefault();var album=event.submitter&&event.submitter.value==='album';perform(async function(){
      var id=await current(),ids=[id];
      if(album){
        var track=await options.transport.get('/v1/tracks/'+encodeURIComponent(id));
        if(!track.album)throw new Error('当前曲目没有明确的专辑信息');
        var result=await options.transport.get('/v1/tracks?album='+encodeURIComponent(track.album)+'&limit=129');
        if(result.total>128)throw new Error('专辑超过单次 128 曲预算');ids=(result.tracks||[]).map(t=>t.id);
      }
      status.textContent='正在分析'+(album?'完整专辑':'当前曲目')+'，当前播放增益保持不变…';
      var result=await options.transport.post('/v1/player/loudness',{track_ids:ids,album:!!album});
      status.textContent='分析完成。结果只保存为候选；保存本机测量来源后，可显式应用到当前曲目。';
      options.refresh();
    });});
    document.getElementById('loudness-apply').addEventListener('click',function(){perform(async function(){var result=await options.transport.post('/v1/player/loudness/apply',{});status.textContent=result.message;options.refresh();});});
    var importing=false,draftRevision=0,resourceRequest=0,targetField=document.getElementById('dsp-impulse');
    targetField.addEventListener('input',function(){draftRevision++;});
    function fillResource(id,revision,request){
      if(revision!==draftRevision||request!==resourceRequest)return false;
      targetField.value=id;targetField.dispatchEvent(new Event('input',{bubbles:true}));return true;
    }
    impulse.addEventListener('submit',async function(event){
      event.preventDefault();if(importing||!impulse.reportValidity())return;
      var note=document.getElementById('impulse-state'),button=impulse.querySelector('button');
      var revision=draftRevision,request=++resourceRequest;
      impulse.dataset.requestId=requestId();
      importing=true;button.disabled=true;impulse.setAttribute('aria-busy','true');
      try{note.textContent='正在读取、校验并复制校正核…';var body=Object.fromEntries(new FormData(impulse));body.request_id=impulse.dataset.requestId;var result=await options.transport.post('/v1/player/impulses',body);
        note.textContent='已导入 '+result.resource.taps+' taps，固定延迟 '+result.resource.delay_frames+' 帧；资源 ID：'+result.resource.resource_id+'。尚未保存到音效。';
        if(!fillResource(result.resource.resource_id,revision,request))note.textContent+=' 当前草稿已有更新，未覆盖；可手动填入上述资源 ID。';
      }catch(error){note.textContent='导入未完成，当前声音保持：'+String(error&&error.message||error);}finally{importing=false;button.disabled=false;impulse.setAttribute('aria-busy','false');delete impulse.dataset.requestId;}
    });
    var generate=document.getElementById('audio-impulse-generate'),generating=false;
    if(generate)generate.addEventListener('submit',async function(event){
      event.preventDefault();if(generating||!generate.reportValidity())return;
      var note=document.getElementById('fir-state'),button=generate.querySelector('button');
      var revision=draftRevision,request=++resourceRequest,pointsField=document.getElementById('fir-points');
      try{
        var body=Object.fromEntries(new FormData(generate));
        body.request_id=requestId();
        body.points=body.points.trim().split(/\r?\n/).map(function(line){
          var cells=line.split(/[,，]/).map(s=>s.trim());
          if(cells.length!==2||cells.some(s=>s==='')||cells.some(s=>!Number.isFinite(Number(s)))){pointsField.setAttribute('aria-invalid','true');pointsField.focus();throw new Error('每行需要两个有限数字：频率, 增益');}
          return {frequency_hz:Number(cells[0]),gain_db:Number(cells[1])};
        });
        pointsField.removeAttribute('aria-invalid');
        generating=true;generate.dataset.requestId=body.request_id;button.disabled=true;generate.setAttribute('aria-busy','true');note.textContent='正在生成并核对目标频响…';
        var result=await options.transport.post('/v1/player/impulses/generate',body),resource=result.resource;
        note.textContent='已生成 '+resource.taps+' taps，延迟 '+resource.delay_frames+' 帧，预留衰减 '+Number(resource.attenuation_db).toFixed(2)+' dB。'+result.message;
        if(!fillResource(resource.resource_id,revision,request))note.textContent+=' 当前草稿已有更新，未覆盖；资源 ID：'+resource.resource_id;
      }catch(error){note.textContent='生成未完成：'+String(error&&error.message||error);}finally{generating=false;button.disabled=false;generate.setAttribute('aria-busy','false');delete generate.dataset.requestId;}
    });
    ['impulse-cancel','fir-cancel'].forEach(function(id){
      var button=document.getElementById(id);if(!button)return;
      button.addEventListener('click',async function(){
        var jobForm=id==='fir-cancel'?generate:impulse,requestId=jobForm.dataset.requestId;
        if(!requestId)return;
        resourceRequest++;button.disabled=true;var note=document.getElementById(id==='fir-cancel'?'fir-state':'impulse-state');
        try{var result=await options.transport.post('/v1/player/impulses/cancel',{request_id:requestId});note.textContent=result.message;}catch(error){note.textContent='取消未完成：'+String(error&&error.message||error);}finally{button.disabled=false;}
      });
    });
  }
  window.HertzAudioAnalysisSettings={init:init};
})();
