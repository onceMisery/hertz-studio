// SPDX-License-Identifier: MIT
// DBX optional desktop UI. Native center owns source selection and surface settings.
(function () {
  'use strict';
  let refs, transport, caps = null, epoch = 0, refreshFlight = null;
  let connectFlight = null, revokeFlight = null, observedAt = '', endpointMissing = false;
  let result = '', resultError = false;
  let mayHaveConsent = false, mutationUnconfirmed = false;
  const byId = id => document.getElementById('dbx-desktop-' + id);
  const message = error => error && error.message || '未收到可确认的结果，请重新检测。';
  const fullConsent = () => !!(!mutationUnconfirmed && caps && caps.authorization.gate && caps.authorization.listenerReady
    && ['lyrics', 'wallpaper'].every(scope => caps.authorization.scopes.includes(scope)));

  function reconcile(value) {
    if (!value || typeof value.supported !== 'boolean' || !value.component || !value.authorization
      || !Array.isArray(value.authorization.scopes)) throw new Error('桌面检测结果格式不完整，请更新插件后重试。');
    caps = value;
    mutationUnconfirmed = false;
    endpointMissing = false;
    observedAt = new Date().toLocaleTimeString();
    if (value.authorization.persistentRevoked) mayHaveConsent = false;
  }

  function fact(label, value) {
    const term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    refs.facts.append(term, detail);
  }

  function render() {
    const busy = !!(refreshFlight || connectFlight || revokeFlight);
    refs.refresh.disabled = busy;
    refs.connect.disabled = busy || endpointMissing || !caps || !caps.supported || !caps.managementReady;
    refs.open.disabled = refs.connect.disabled;
    refs.connect.hidden = fullConsent();
    refs.open.hidden = !fullConsent();
    // Revoke must remain available while connect is still probing or authorizing.
    refs.revoke.disabled = !!revokeFlight || !(connectFlight || mayHaveConsent || caps &&
      (caps.authorization.gate || caps.authorization.scopes.length || caps.authorization.cleanupIncomplete));
    refs.revoke.textContent = connectFlight ? '取消连接并撤销授权' : caps && caps.authorization.cleanupIncomplete ? '重试撤销与清理' : '撤销授权';
    refs.status.textContent = revokeFlight ? '正在撤销授权…' : connectFlight ? '正在连接原生中心…'
      : refreshFlight ? '正在检测桌面组件…' : endpointMissing ? '当前插件后端不支持桌面连接，请更新配套插件。'
        : !caps ? '尚未取得检测结果' : !caps.supported ? '当前平台不支持桌面组件，仅支持 Windows 11 x64（不支持 ARM64）。'
          : caps.component.origin === 'running' && caps.managementReady ? '本次检测发现兼容的运行中组件'
            : ({ 'component-missing': '未找到桌面组件，请按下方步骤安装。', 'component-incompatible': '组件构建不匹配，请升级为配套版本。',
              'incompatible-host': '运行中的桌面组件不兼容，请退出后升级为配套版本。', 'start-required': '组件已安装，请先手动启动。',
              'component-unknown': '无法确认组件是否安装，请查看检测错误或手动检查。', 'management-ready': '本次检测原生中心可用',
              'management-unknown': '无法确认原生中心状态，请手动检查并重试。', 'management-failed': '本次未能连接原生中心，请检查后重试。',
              'management-unconfirmed': '尚未确认原生中心状态，请重新检测。', 'not-detected': '尚未检测桌面组件' })[caps.reason] || '本次检测未确认桌面组件状态';
    refs.facts.replaceChildren();
    if (caps) {
      const auth = caps.authorization, component = caps.component;
      fact('组件', ({ unknown: '未知', missing: '未找到', incompatible: '不兼容', ready: '兼容' })[component.state] || '未知');
      fact('组件位置', component.origin === 'running' ? '运行中的组件（优先）' : component.origin === 'installed' ? '固定安装目录' : '未确认');
      if (caps.source) fact('本插件来源', [caps.source.edition, caps.source.dataDir].filter(Boolean).join(' · '));
      fact(mutationUnconfirmed ? '上次检测授权' : '持久授权', auth.scopes.length ? auth.scopes.map(scope => ({ lyrics: '歌词', wallpaper: '音乐响应' })[scope] || scope).join('、') : '无');
      fact('授权修订', auth.revision == null ? '无' : String(auth.revision));
      fact('当前数据通道', mutationUnconfirmed ? '本次操作未确认，请重新检测或撤销授权' : revokeFlight ? '正在关闭' : auth.gate ? '已允许' : '已关闭');
      fact('数据监听', mutationUnconfirmed ? '本次操作未确认' : revokeFlight ? '正在关闭' : auth.listenerReady ? '已就绪' : '未就绪');
      fact('原生管理通道', mutationUnconfirmed ? '本次操作未确认' : revokeFlight ? '本次撤销中，等待结果' : caps.managementReady ? '本次检测可用' : '未确认');
      fact('来源与窗口', !mutationUnconfirmed && !revokeFlight && caps.sourceConnected
        ? '本次检测已确认（' + observedAt + '）；歌词 ' + (caps.sourceScopes && caps.sourceScopes.lyrics ? '已确认' : '未确认') + '，壁纸 ' + (caps.sourceScopes && caps.sourceScopes.wallpaper ? '已确认' : '未确认')
        : '未确认：请在原生中心确认来源并按需启用歌词或壁纸；窗口关闭时也可能显示未确认。');
      fact('检测时间', observedAt + ' · 此页不自动刷新，状态以本次检测为准');
      for (const [label, error] of [['检测错误', caps.error], ['组件错误', component.error], ['授权错误', auth.error]]) {
        if (error) fact(label, message(error) + (error.code ? '（' + error.code + '）' : ''));
      }
      for (const failure of auth.scopeErrors || []) fact('授权范围错误', failure.scope + '：' + message(failure.error));
      if (mutationUnconfirmed) fact('持久撤销', '本次操作结果未确认，请重新检测或重试撤销。');
      else if (auth.persistentRevoked) fact('持久撤销', auth.cleanupIncomplete ? '已撤销；授权文件清理尚未完成，可重试清理。' : '已撤销');
      else if (!auth.gate && auth.scopes.length) fact('持久撤销', '本次数据通道已关闭，持久授权仍存在；重启可能恢复。');
    }
    refs.result.textContent = result;
    refs.result.dataset.error = String(resultError);
  }

  async function refresh() {
    if (!refs || refreshFlight || connectFlight || revokeFlight) return;
    const operation = ++epoch;
    refreshFlight = operation;
    result = ''; resultError = false; render();
    try {
      const value = await transport.get('/v1/desktop/capabilities?refresh=true', { retry: false });
      if (operation !== epoch) return;
      reconcile(value);
    } catch (error) {
      if (operation !== epoch) return;
      endpointMissing = error.status === 404 || error.status === 405 || error.code === -32601
        || /method not found|unknown method|unknown_method/i.test(String(error.code || '') + ' ' + message(error));
      result = message(error); resultError = true;
    } finally {
      if (refreshFlight === operation) refreshFlight = null;
      render();
    }
  }

  async function connect() {
    if (!refs || connectFlight || revokeFlight || refreshFlight || !caps || !caps.supported || !caps.managementReady || endpointMissing) return;
    const operation = ++epoch;
    connectFlight = operation; mayHaveConsent = true; result = ''; resultError = false; render();
    try {
      const reply = await transport.post('/v1/desktop/connect', { tab: 'runtime' });
      if (operation !== epoch) return;
      reconcile(reply && reply.capabilities);
      resultError = !reply.ok;
      result = !reply.ok ? (reply.centerOpened ? '原生中心已打开，但本次连接未完成确认。' : '') + message(reply.error) + ' 可重试打开中心或撤销现有授权。'
        : (reply.centerOpened ? '原生中心已打开。' : '连接请求已完成。') + '请在原生中心确认本插件来源，并按需开启歌词或壁纸。';
    } catch (error) {
      if (operation !== epoch) return;
      mutationUnconfirmed = true;
      result = message(error) + ' 可重新检测或撤销授权。'; resultError = true;
    } finally {
      if (connectFlight === operation) connectFlight = null;
      render();
    }
  }

  async function revoke() {
    if (!refs || revokeFlight) return;
    const operation = ++epoch;
    // Detach old flights locally: their replies cannot change this newer intent.
    connectFlight = null; refreshFlight = null; revokeFlight = operation;
    result = ''; resultError = false; render();
    try {
      const reply = await transport.post('/v1/desktop/disconnect', {});
      if (operation !== epoch) return;
      reconcile(reply && reply.capabilities);
      const auth = caps.authorization;
      resultError = !reply.ok;
      result = auth.persistentRevoked ? auth.cleanupIncomplete
        ? '授权已撤销；部分授权文件清理尚未完成，可重试清理。' : '授权已撤销，数据通道已断开。'
        : !auth.gate ? '当前已断开，但持久撤销未完成；重启可能恢复授权，请重试撤销。'
          : '尚未确认断开，请重新检测并重试撤销。';
      if (reply.error) result += ' ' + message(reply.error);
    } catch (error) {
      if (operation !== epoch) return;
      mutationUnconfirmed = true;
      // A failed RPC cannot prove either persistence or gate state.
      if (caps) caps = { ...caps, sourceConnected: false, sourceScopes: { lyrics: false, wallpaper: false } };
      result = '未能确认撤销结果，请重新检测并重试。' + message(error); resultError = true;
    } finally {
      if (revokeFlight === operation) revokeFlight = null;
      render();
    }
  }

  function focus() {
    if (!refs) return;
    // Existing skin category buttons own group visibility. Select their lyrics entry.
    const link = document.querySelector('.skset-link[data-skset-key="lyrics"], .qf-set-link[data-qf-key="lyrics"], .ln-set-link[data-ln-key="lyrics"]');
    if (link) link.click();
    refs.root.scrollIntoView({ block: 'nearest' });
    refs.root.focus({ preventScroll: true });
  }

  function init(host) {
    if (refs || !(window.hertzHost && window.hertzHost.isDbx)) return;
    transport = host;
    refs = { root: byId('settings'), status: byId('status'), facts: byId('facts'), result: byId('result'), refresh: byId('refresh'), connect: byId('connect'), open: byId('open'), revoke: byId('revoke') };
    refs.root.hidden = false;
    refs.refresh.onclick = refresh; refs.connect.onclick = connect; refs.open.onclick = connect; refs.revoke.onclick = revoke;
    byId('copy-guide').onclick = async () => {
      const url = byId('guide-url');
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(url.textContent);
        byId('copy-result').textContent = '指南地址已复制';
      } catch (_) {
        const range = document.createRange(); range.selectNodeContents(url);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        byId('copy-result').textContent = '请复制已选中的地址，在浏览器中打开。';
      }
    };
    render(); // Pure registration: no capability read, authorization, launch or timer.
  }

  window.HertzDesktopSettings = { init, onSettingsEnter: refresh, focus };
})();
