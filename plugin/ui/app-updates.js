// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  var transport, refs, snapshot = null, initialized = false;
  var pending = false, saving = false, timer = 0, failures = 0, errorNote = '', notified = '', requestEpoch = 0;
  var endpoint = '/v1/system/updates';
  function message(error) { return String(error && error.message || error); }
  function nativeHost() {
    if (window.hertzHost && window.hertzHost.isDbx) return null;
    var host = window.__hertzWindowHost;
    return host && host.updateVersion === 1 && typeof host.installUpdate === 'function' ? host : null;
  }
  function busy() { return snapshot && ['checking', 'downloading', 'verifying', 'installing', 'cancelling'].includes(snapshot.phase); }
  function text(node, value) { if (node.textContent !== value) node.textContent = value; }
  function bytes(value) {
    return (Math.max(0, Number(value) || 0) / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function releaseLink(value) {
    if (typeof value !== 'string' || value.length > 1024) return '';
    try {
      var url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
          && !url.port && !url.search && !url.hash && url.pathname.startsWith('/onceMisery/hertz-studio/releases/')) return url.href;
    } catch (_) {}
    return '';
  }
  function phaseMessage() {
    if (errorNote) return errorNote;
    if (!snapshot) return '正在读取更新信息';
    if (snapshot.error) return snapshot.error.message;
    if (snapshot.phase === 'idle' && snapshot.lastInstall) {
      return snapshot.lastInstall.message + (snapshot.lastInstall.status === 'failed' ? '；可重新检查更新，日志：' + snapshot.lastInstall.log : '');
    }
    var version = snapshot.release && snapshot.release.version;
    return {
      idle: '尚未检查更新', checking: '正在检查 GitHub 发布', current: '当前版本无需更新',
      available: '发现新版本 ' + version, unavailable: '当前发行方式暂无已发布的稳定版本',
      downloading: '正在下载更新包', verifying: '下载完成，正在校验更新包',
      ready: '更新包已校验，可以安装', installing: '正在准备安装，请完成播放器的退出确认',
      cancelling: '正在取消更新操作',
      cancelled: '已取消，可重新检查或下载', failed: '检查或下载失败，请重试',
    }[snapshot.phase] || '更新状态暂不可用，请重试';
  }
  function render() {
    if (!refs) return;
    var value = snapshot, downloading = value && ['downloading', 'verifying'].includes(value.phase);
    text(refs.status, phaseMessage());
    refs.status.classList.toggle('is-error', !!errorNote || !!(value && (value.error || value.phase === 'idle' && value.lastInstall && value.lastInstall.status === 'failed')));
    refs.check.disabled = pending || saving || (!value && !errorNote) || (value && (busy() || value.phase === 'ready') && failures < 6);
    text(refs.check, failures >= 6 || !value && errorNote ? '重试读取状态' : value && value.phase === 'checking' ? '正在检查' : value && value.phase === 'failed' ? '重新检查' : '检查更新');
    refs.auto.disabled = pending || saving || !value;
    if (value && !saving) refs.auto.checked = value.checkOnStartup === true;
    if (value) text(refs.version, value.currentVersion + ' · ' + (value.distribution === 'plugin' ? 'DBX 插件' : '独立播放器') + ' · ' + (value.edition === 'full' ? 'Full' : 'Standard'));
    refs.progress.hidden = !busy();
    refs.progress.setAttribute('aria-label', downloading ? '更新包下载进度' : value && value.phase === 'checking' ? '版本检查进度' : '安装准备进度');
    if (downloading && value.totalBytes > 0) {
      refs.progress.max = value.totalBytes;
      refs.progress.value = Math.min(value.totalBytes, value.downloadedBytes || 0);
    } else { refs.progress.removeAttribute('value'); }
    refs.transfer.hidden = !downloading;
    if (downloading) text(refs.transfer, bytes(value.downloadedBytes) + ' / ' + bytes(value.totalBytes)
      + (value.totalBytes ? ' · ' + Math.floor(100 * value.downloadedBytes / value.totalBytes) + '%' : ''));
    var release = value && value.release;
    refs.release.hidden = !release;
    if (!release) return;
    text(refs.releaseTitle, '最新发布 ' + release.version);
    text(refs.notes, release.notes || '此版本未提供更新说明');
    var host = nativeHost(), dbx = window.hertzHost && window.hertzHost.isDbx;
    var link = releaseLink(release.releaseUrl), downloadLink = releaseLink(release.downloadUrl);
    refs.page.hidden = !link || dbx;
    if (link) refs.page.href = link;
    refs.copy.hidden = !(downloadLink || link);
    refs.copy.dataset.url = downloadLink || link;
    var ready = value.phase === 'ready', installing = value.phase === 'installing';
    refs.download.hidden = !value.canDownload;
    refs.download.disabled = pending || saving || busy() || ready;
    text(refs.download, ready ? '已下载' : value.phase === 'failed' ? '重新下载' : '下载更新');
    refs.install.hidden = !host || !(ready || installing);
    refs.install.disabled = pending || saving || !value.canInstall;
    text(refs.install, installing ? '正在准备安装' : '安装并重新打开');
    refs.cancel.hidden = !downloading;
    refs.cancel.disabled = pending || saving;
    text(refs.installNote, dbx ? '下载对应插件包后，在 DBX 中安装更新'
      : value.canDownload ? '安装时会保存当前舞台并正常退出播放器，完成后重新打开；音乐和个人资料会保留'
        : !downloadLink ? '此版本暂未提供当前系统的下载包，可以查看发布页面'
          : value.installUnavailableReason || '请下载对应程序包后安装或完整解压新版本');
  }
  function schedule() {
    clearTimeout(timer); timer = 0;
    if (!busy() || document.hidden || failures >= 6) return;
    timer = setTimeout(function () { timer = 0; void refresh(); }, 750);
  }
  function accept(value) {
    if (!value || typeof value.currentVersion !== 'string' || typeof value.phase !== 'string') throw new Error('更新信息格式无效，请重试');
    snapshot = value; failures = 0; errorNote = '';
    render(); schedule();
    if (value.phase === 'available' && value.release && value.release.version !== notified) {
      notified = value.release.version;
      if (typeof window.toast === 'function' && document.getElementById('view-settings').hidden) {
        window.toast('发现 Hertz Studio ' + notified + '，可在设置的「关于与更新」中查看', 'info');
      }
    }
  }
  async function refresh() {
    if (!initialized || saving || pending || transport.kind === 'demo') return;
    var epoch = requestEpoch;
    try { var value = await transport.get(endpoint); if (epoch === requestEpoch) accept(value); }
    catch (error) { if (epoch !== requestEpoch) return; failures++; errorNote = '更新状态读取失败：' + message(error); render(); schedule(); }
  }
  async function action(path, body) {
    if (pending || saving) return;
    requestEpoch++; pending = true; errorNote = ''; render();
    try { accept(await transport.post(endpoint + path, body || {})); }
    catch (error) { errorNote = '操作失败：' + message(error); render(); }
    finally { pending = false; render(); schedule(); }
  }
  async function savePreference() {
    if (pending || saving || !snapshot) { render(); return; }
    var previous = snapshot.checkOnStartup, enabled = refs.auto.checked;
    requestEpoch++; saving = true; errorNote = ''; render();
    try { accept(await transport.put(endpoint + '/settings', { checkOnStartup: enabled })); }
    catch (error) { refs.auto.checked = previous; errorNote = '启动检查设置未保存：' + message(error); }
    finally { saving = false; render(); schedule(); }
  }
  async function install() {
    var host = nativeHost();
    if (pending || saving || !host || !snapshot || !snapshot.canInstall) return;
    requestEpoch++; pending = true; errorNote = ''; render();
    try {
      await host.installUpdate(snapshot.operationId);
      snapshot = Object.assign({}, snapshot, { phase: 'installing', canInstall: false }); render();
      accept(await transport.get(endpoint));
    }
    catch (error) { errorNote = '无法开始安装：' + message(error); }
    finally { pending = false; render(); schedule(); }
  }
  async function copyLink() {
    try {
      if (!refs.copy.dataset.url || !window.HertzClipboard) throw new Error('无法复制链接，请打开发布页面');
      await window.HertzClipboard.write(refs.copy.dataset.url);
      text(refs.status, '下载链接已复制');
    } catch (error) { errorNote = '复制失败：' + message(error); render(); }
  }
  async function initial() {
    await refresh();
    if (snapshot && snapshot.checkOnStartup) await action('/check', { automatic: true });
  }
  function init(api) {
    if (initialized) return;
    var root = document.getElementById('application-updates');
    if (!root) return;
    initialized = true; transport = api;
    refs = {};
    ['version', 'check', 'status', 'progress', 'transfer', 'auto', 'release', 'notes', 'download', 'install', 'cancel', 'page', 'copy'].forEach(function (name) {
      refs[name] = document.getElementById('app-update-' + name);
    });
    refs.releaseTitle = document.getElementById('app-update-release-title');
    refs.installNote = document.getElementById('app-update-install-note');
    refs.check.addEventListener('click', function () { if (!snapshot || failures >= 6) void refresh(); else void action('/check'); });
    refs.download.addEventListener('click', function () { void action('/download'); });
    refs.cancel.addEventListener('click', function () { void action('/cancel'); });
    refs.install.addEventListener('click', install);
    refs.auto.addEventListener('change', savePreference);
    refs.copy.addEventListener('click', copyLink);
    refs.page.addEventListener('click', function (event) {
      var host = nativeHost();
      if (!host || typeof host.openUpdatePage !== 'function') return;
      event.preventDefault();
      host.openUpdatePage(refs.page.href).catch(function (error) { errorNote = '发布页面未能打开：' + message(error); render(); });
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) void refresh(); else { clearTimeout(timer); timer = 0; } });
    window.addEventListener('hertz-native-host-confirmed', render);
    // 关于与更新已收进「关于」分类，进入该分类时才刷新版本状态。
    window.addEventListener('hertz-settings-category', function (event) {
      if (event.detail && ['about', 'tools'].includes(event.detail.category)) void refresh();
    });
    if (transport.kind === 'demo') {
      text(refs.version, '演示模式'); text(refs.status, '连接播放器服务后可以检查更新'); return;
    }
    void initial();
  }
  window.HertzUpdates = { init: init, refresh: refresh };
}());
