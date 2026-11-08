// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  const settings = window.hertzWallpaperSettings;
  const request = (command, payload) => settings.requestManagement(command, payload).then(receipt => receipt.result);
  function node(tag, text, id) { const value = document.createElement(tag); if (text) value.textContent = text; if (id) value.id = id; return value; }
  function button(text, id, action) { const value = node('button', text, id); value.type = 'button'; value.addEventListener('click', () => Promise.resolve().then(action).catch(error => message(error.message, true))); return value; }
  function field(label, input) { const value = node('label'); value.className = 'field'; value.append(node('span', label), input); return value; }
  const section = node('details', '', 'playlist-editor'); section.className = 'local-library'; section.append(node('summary', '轮播列表'));
  const toolbar = node('div'); toolbar.className = 'library-toolbar';
  const select = node('select', '', 'playlist-select'); select.setAttribute('aria-label', '保存的轮播列表');
  toolbar.append(select, button('打开列表', 'playlist-open', load), button('新建列表', 'playlist-new', () => { current = null; items = []; title.value = '我的轮播'; mode.value = 'sequential'; interval.value = 60; changed(); render(); }), button('刷新', 'playlist-refresh', refresh));
  const title = node('input', '', 'playlist-title'); title.value = '我的轮播'; title.maxLength = 120; title.required = true;
  const mode = node('select', '', 'playlist-mode'); [['sequential','按顺序'],['random','随机']].forEach(([value,label]) => { const option = node('option',label); option.value=value; mode.append(option); });
  const interval = node('input', '', 'playlist-interval'); interval.type='number'; interval.min=10; interval.max=86400; interval.step=1; interval.value=60;
  const list = node('ol', '', 'playlist-items');
  const hint = node('p', '在本地作品的版本列表中点击“加入轮播”。每个列表最多32项，暂停期间不计时。'); hint.className='hint';
  const status = node('p', '', 'playlist-message'); status.className='hint'; status.setAttribute('role','status');
  const runtime = node('p', '', 'playlist-runtime'); runtime.className='hint'; runtime.setAttribute('aria-live','polite');
  const actions = node('div'); actions.className='library-toolbar';
  const choose = button('选择此列表', 'playlist-choose', async () => { const groupId = settings.currentGroupId(); await save(); if (!await settings.choosePlaylist(current, groupId)) throw new Error('原显示组已移除或设置正在处理，请重新选择。'); message('已为原显示组选择此轮播列表。点击应用设置后开始播放。',false); });
  const next = button('下一项', 'playlist-next', () => step(false));
  const retry = button('重试失败项', 'playlist-retry', () => step(true)); retry.hidden = true;
  actions.append(button('保存列表','playlist-save',save), choose, next, retry);
  section.append(toolbar,field('列表名称',title),field('播放顺序',mode),field('间隔 / 秒',interval),hint,list,actions,status,runtime);
  document.getElementById('work-editor').after(section);
  let current = null, items = [], dirty = false, busy = false, active = null, activeGroupId = null;
  function message(text,error) { status.textContent=text; status.classList.toggle('error',!!error); }
  function changed() { dirty=true; message('列表尚未保存。',false); }
  [title,mode,interval].forEach(input => input.addEventListener('input', changed));
  function render() {
    list.replaceChildren();
    items.forEach((item,index) => {
      const row=node('li'); row.className='library-version';
      row.append(node('span', item.label || ('版本 ' + item.packageHash.slice(0,8))));
      const up=button('上移','',() => { [items[index-1],items[index]]=[items[index],items[index-1]];changed();render(); }); up.disabled=index===0;
      const remove=button('移除','',() => { items.splice(index,1);changed();render(); });
      row.append(up,remove);list.append(row);
    });
    choose.disabled=busy || !items.length || !settings.canChooseLibraryVersion(); next.disabled=busy || !active || !activeGroupId || !!active.failed || active.pendingIndex != null;
    retry.hidden=!active || !active.failed; retry.disabled=busy;
    [title,mode,interval,select].forEach(input => input.disabled=busy);
    section.querySelectorAll('button').forEach(button => { if (busy) button.disabled=true; else if (![choose,next,retry].includes(button)) button.disabled=false; });
    list.querySelector('button')?.toggleAttribute('disabled',true);
  }
  async function refresh() {
    const old=select.value; let cursor=null; const all=[];
    do { const page=await request('wallpaper.playlist.list',{limit:20,cursor}); all.push(...page.playlists);cursor=page.nextCursor; } while(cursor);
    select.replaceChildren(); all.forEach(value=>{const option=node('option',value.title+' · '+value.itemCount+'项');option.value=value.playlistId;select.append(option);});
    if(all.some(value=>value.playlistId===old)) select.value=old;
  }
  async function load() {
    if (!select.value || busy) return;
    if(dirty && !confirm('放弃尚未保存的列表修改？')) return;
    busy=true;render();
    try {
      current=await request('wallpaper.playlist.get',{playlistId:select.value});
      items=current.items.map(item=>Object.assign({},item)); title.value=current.title;mode.value=current.mode;interval.value=current.intervalSeconds;dirty=false;message('已读取保存的固定版本列表。',false);
    } finally {busy=false;render();}
  }
  async function save() {
    if (busy) throw new Error('列表正在保存，请等待完成。');
    if (!title.checkValidity() || !interval.checkValidity() || !items.length) throw new Error('请填写名称、10–86400秒间隔，并加入至少一个版本。');
    if(current && !dirty) return;
    busy=true;render();
    try {
      current=await request('wallpaper.playlist.save',{playlistId:current && current.playlistId,expectedPlaylistRevision:current && current.revision,title:title.value,mode:mode.value,intervalSeconds:Number(interval.value),items:items.map(({workKey,packageHash})=>({workKey,packageHash}))});
      dirty=false;await refresh();select.value=current.playlistId;message('轮播列表已保存。应用设置后开始播放。',false);
    } finally {busy=false;render();}
  }
  async function step(retry) { if(!active || !activeGroupId)return; const groupId=activeGroupId, playlistId=active.playlistId; await request('wallpaper.playlist.next',{playlistId,groupId,retry});message(retry?'正在重试同一版本。':'正在切换下一项。',false); }
  window.addEventListener('wallpaper-playlist-add',event=>{
    if(busy){message('列表正在保存或读取，请等待完成。',true);return;}
    if(items.length>=32){message('每个列表最多32项。',true);return;}
    const {work,version}=event.detail;items.push({workKey:work.workKey,packageHash:version.packageHash,label:work.title+' · 版本 '+version.version});changed();render();section.open=true;
  });
  function updateRuntime(value) {
    active=value && value.playlist; activeGroupId=value && value.groupId;
    runtime.textContent=active ? active.title+' · '+(active.failed?'切换失败，等待重试':active.pendingIndex!=null?'正在切换第'+(active.pendingIndex+1)+'项': '第'+((active.currentIndex||0)+1)+' / '+active.itemCount+'项') : '';
    render();
  }
  window.addEventListener('wallpaper-runtime-updated',event=>updateRuntime(event.detail));
  section.addEventListener('toggle',()=>{if(section.open)refresh().catch(error=>message(error.message,true));});
  updateRuntime(settings.currentRuntime());
})();
