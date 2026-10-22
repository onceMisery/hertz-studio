// SPDX-License-Identifier: MIT
// Read-only experimental pitch inspector. The Stage owner supplies all time.
(function () {
  'use strict';
  var live = null, serial = 0;
  function selection() {
    var p = window.Stage && Stage.presentation();
    return p && p.track && p.track.id === p.mediaTrackId && Number.isSafeInteger(p.mediaEpoch)
      ? {id:p.track.id,epoch:p.mediaEpoch} : null;
  }
  function same(a,b) { return !!a && !!b && a.id === b.id && a.epoch === b.epoch; }
  function validate(reply) {
    var map = reply && reply.map, media = reply && reply.media;
    if (!map || map.version !== 1 || map.algorithm !== 'nsdf-lowpass-v1'
      || !Number.isSafeInteger(map.analyzedMs) || map.analyzedMs < 0 || map.analyzedMs > 720000
      || typeof map.truncated !== 'boolean' || typeof reply.cached !== 'boolean'
      || !media || media.kind !== 'local-file-sha256-v1' || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)
      || typeof media.byteLength !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(media.byteLength)
      || Number(media.byteLength) > 2147483648 || !Array.isArray(map.points)
      || map.points.length !== (map.analyzedMs < 128 ? 0 : Math.floor((map.analyzedMs-128)/40)+1)) throw new Error('基频轨迹版本或结构无效');
    var previous = -1;
    map.points.forEach(function (p,i) {
      if (!p || !Number.isSafeInteger(p.t) || p.t !== 64+i*40 || p.t <= previous || p.t+64 > map.analyzedMs
        || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1
        || (p.hz !== null && (!Number.isFinite(p.hz) || p.hz < 55 || p.hz > 1200))) throw new Error('基频轨迹包含无效点');
      previous = p.t;
    });
    return map;
  }
  function curve(map) {
    var path = '', drawing = false, stride = Math.max(1,Math.ceil(map.points.length/1200));
    map.points.forEach(function (p,i) {
      if (p.hz === null) { drawing = false; return; }
      if (i%stride) return;
      var x = 10 + p.t/Math.max(1,map.analyzedMs)*580;
      var y = 150-Math.log(p.hz/55)/Math.log(1200/55)*140;
      path += (drawing ? 'L':'M')+x.toFixed(2)+','+y.toFixed(2); drawing = true;
    });
    return path;
  }
  function unmount() {
    serial++;
    if (live && live.controller) live.controller.abort();
    live = null;
    if (window.Stage) Stage.removeGate('pitch-inspector');
  }
  function mount(host) {
    unmount();
    function h(tag,text) { var el=document.createElement(tag); if(text)el.textContent=text; return el; }
    var box=h('details'); box.className='ws-pitch';
    box.appendChild(h('summary','查看基频候选轨迹（实验）'));
    var note=h('p','仅分析当前本地文件的前 12 分钟。候选基频不等于主唱旋律或乐谱；静音、噪声和低置信度处留空，不生成编排或修改舞台。'); note.className='sc-note';
    var button=h('button','分析当前本地曲目'); button.type='button';button.className='btn';button.dataset.pitch='analyze';
    var message=h('p','点击后读取本地音频，分析结果仅保留在本次查看中。');message.className='sc-note';message.setAttribute('role','status');message.dataset.pitchStatus='';
    var graph=h('div');graph.className='ws-pitch-graph';graph.hidden=true;
    function svgNode(tag,attrs){var el=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.keys(attrs).forEach(function(k){el.setAttribute(k,attrs[k]);});return el;}
    var svg=svgNode('svg',{viewBox:'0 0 600 160',role:'img','aria-label':'基频候选随歌曲时间变化，空白代表未检测到可靠基频'});
    var path=svgNode('path',{fill:'none',stroke:'currentColor','stroke-width':'1.4'});
    var cursor=svgNode('line',{x1:10,x2:10,y1:5,y2:155,stroke:'currentColor','stroke-opacity':'.45'});
    svg.append(path,cursor);graph.append(svg,h('p','纵轴 55–1200 Hz（对数）；横轴为已分析的歌曲时间。'));
    var readout=h('p');readout.className='sc-note';readout.dataset.pitchPosition='';graph.append(readout);
    box.append(note,button,message,graph);host.appendChild(box);
    var state={box:box,controller:null,map:null,selection:null};live=state;
    function invalidate(text) {
      serial++; if(state.controller)state.controller.abort();state.controller=null;state.map=null;state.selection=null;
      path.setAttribute('d','');graph.hidden=true;button.disabled=false;message.textContent=text;
    }
    function tick() {
      if (live !== state) return;
      if (state.selection && !same(state.selection,selection())) { invalidate('曲目已改变，请重新分析当前本地曲目。'); return; }
      if (!state.map) return;
      var pos=Stage.position(), map=state.map;
      var x=10+Math.max(0,Math.min(1,pos/Math.max(1,map.analyzedMs)))*580;
      cursor.setAttribute('x1',x);cursor.setAttribute('x2',x);
      cursor.style.display=pos>=0 && pos<=map.analyzedMs ? '' : 'none';
      var i=map.points.length ? Math.round((pos-map.points[0].t)/40) : -1;
      var p=map.points[i], hz=p && Math.abs(p.t-pos)<=20 ? p.hz : null;
      readout.textContent=(pos/1000).toFixed(1)+' 秒 · '+(hz ? hz.toFixed(1)+' Hz':'此处无可靠基频');
    }
    button.addEventListener('click',async function () {
      invalidate('正在分析当前本地音频…');
      var picked=selection();
      if(!picked){message.textContent='请先选择本地曲库曲目并等待载入完成。';return;}
      state.selection=picked;state.controller=new AbortController();button.disabled=true;
      var mine=++serial;
      try {
        var reply=await VMusicTransport.post('/v1/stage/pitch',{track_id:picked.id},{signal:state.controller.signal});
        if(live!==state || mine!==serial || !same(picked,selection()))return;
        var map=validate(reply);state.map=map;
        var voiced=map.points.filter(function(p){return p.hz!==null;}).length;
        path.setAttribute('d',curve(map));graph.hidden=!voiced;
        message.textContent=voiced ? '已分析 '+(map.analyzedMs/1000).toFixed(1)+' 秒，'+voiced+'/'+map.points.length+' 个可靠候选点。'+(map.truncated?'尾段未分析，不推演频率。':'')
          :'未检测到可靠基频；静音、噪声、多声部或过短音频可能无结果。';
        tick();
      } catch(error) {
        if(live!==state || mine!==serial)return;
        message.textContent=error.name==='AbortError'?'已停止等待分析结果。':(error.message || '基频分析失败，请稍后重试。')
          +(error.requestId?'（request_id '+error.requestId+'）':'');
      } finally {
        if(live===state && mine===serial){state.controller=null;button.disabled=false;}
      }
    });
    box.addEventListener('toggle',function(){if(!box.open && state.controller)invalidate('已停止等待；可重新分析当前曲目。');Stage.kick();});
    Stage.gate('pitch-inspector',function(){return live===state && box.isConnected && box.open && !document.hidden ? 6:0;},tick);
  }
  window.CreativePitch={mount:mount,unmount:unmount,validate:validate,curve:curve};
})();
