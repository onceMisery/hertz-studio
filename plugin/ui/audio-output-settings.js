// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  function init(options) {
    var form=document.getElementById('audio-output-settings');
    if(!form)return null;
    var mode=document.getElementById('output-mode'),format=document.getElementById('output-format'),dither=document.getElementById('output-dither');
    var status=document.getElementById('output-state'),button=form.querySelector('button[type=submit]');
    var dirty=false,busy=false,epoch=0,reading=null,saved=null;
    function describe(value) {
      var output=value.output,actual=output&&output.actual;
      var text=actual?actual.device_id+' · '+actual.sample_rate+' Hz · '+actual.sample_format+' · '+actual.valid_bits+' 有效位 · '+(actual.mode==='exclusive'?'独占':'共享'):'当前没有活动本机输出。';
      if(output&&output.last_error)text+=' '+output.last_error;
      if(output&&output.capabilities&&!output.capabilities.device_qualified)text+=' 当前设备尚未完成拔插、休眠与长时间播放验证。';
      return text;
    }
    async function load() {
      if(busy||reading)return reading;
      var current=epoch;
      reading=(async function(){try{
        var value=await options.transport.get('/v1/player/output');
        if(current!==epoch)return;
        saved=value.saved;
        if(!dirty){mode.value=saved.mode;format.value=saved.sample_format;dither.value=saved.dither;}
        status.textContent=describe(value);
      }catch(error){status.textContent='无法读取输出设置；请稍后重试。';}finally{reading=null;}})();
      return reading;
    }
    form.addEventListener('input',function(){dirty=true;epoch++;});
    form.addEventListener('change',function(){dirty=true;epoch++;});
    form.addEventListener('submit',async function(event){
      event.preventDefault();if(busy||!form.reportValidity())return;
      if(!saved){status.textContent='先读取当前输出设置后再保存。';return;}
      var device=document.getElementById('set-device');
      var prefs={device_id:device?(device.value||null):saved.device_id,mode:mode.value,sample_format:format.value,dither:dither.value};
      var current=++epoch;busy=true;button.disabled=true;form.setAttribute('aria-busy','true');status.textContent='正在准备并切换输出…';
      try{var value=await options.transport.post('/v1/player/output',prefs);saved=value.saved;if(current===epoch)dirty=false;status.textContent=describe(value);}
      catch(error){status.textContent='输出未保存，草稿保留：'+String(error&&error.message||error);}
      finally{busy=false;button.disabled=false;form.setAttribute('aria-busy','false');}
    });
    return {load:load};
  }
  window.HertzAudioOutputSettings={init:init};
})();
