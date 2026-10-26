(function () {
  'use strict';
  var revision = 0;
  var previewActive = false;
  var dirty = false;
  var profiles = [];
  var currentProfile = null;
  var ready = false;
  var $ = id => document.getElementById(id);

  function profileKey(profile) {
    if (!profile) return '';
    var path = String(profile.dataDir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    return String(profile.edition || '').toLowerCase() + '|' + path;
  }

  function send(command, extra) {
    if (!window.ipc || !window.ipc.postMessage) return;
    var payload = Object.assign({ cmd: command }, extra || {});
    window.ipc.postMessage(JSON.stringify(payload));
  }

  function form() {
    return {
      enabled: !!$('enabled').checked,
      fps: Number($('fps').value),
      musicResponse: !!$('music').checked,
      monitor: $('monitor').value || null,
    };
  }

  function primaryMonitor(monitors) {
    return (monitors || []).find(monitor => monitor.primary) || (monitors || [])[0] || null;
  }

  function renderProfiles(list, current, forceCurrent) {
    if (Array.isArray(list)) profiles = list.slice();
    if (current) {
      currentProfile = current;
      if (!profiles.some(profile => profileKey(profile) === profileKey(current))) {
        profiles.unshift(current);
      }
    }
    var select = $('profile');
    var previous = select.value;
    select.innerHTML = '';
    profiles.forEach(function (profile) {
      var option = document.createElement('option');
      option.value = profileKey(profile);
      var directory = String(profile.dataDir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      var edition = profile.edition === 'standard' ? 'Standard' : profile.edition === 'full' ? 'Full' : String(profile.edition || '?');
      option.textContent = edition + ' · ' + directory;
      option.title = profile.dataDir;
      select.appendChild(option);
    });
    var preferred = forceCurrent && currentProfile
      ? profileKey(currentProfile)
      : previous || (currentProfile ? profileKey(currentProfile) : '');
    if (profiles.some(profile => profileKey(profile) === preferred)) select.value = preferred;
    if (!select.value && profiles.length) select.selectedIndex = 0;
    updateProfilePath();
  }

  function selectedProfile() {
    var key = $('profile').value;
    return profiles.find(profile => profileKey(profile) === key) || null;
  }

  function updateProfilePath() {
    var profile = selectedProfile();
    $('profile-path').textContent = profile ? profile.dataDir : '';
    $('profile-path').title = profile ? profile.dataDir : '';
    $('profile').title = profile ? profile.dataDir : '';
    var canSwitch = ready && profile && profileKey(profile) !== profileKey(currentProfile);
    $('switch-source').disabled = !canSwitch;
    document.querySelector('.source-actions').hidden = !canSwitch;
  }

  function syncControls() {
    ['profile', 'enabled', 'monitor', 'fps', 'music', 'preview'].forEach(function (id) {
      $(id).disabled = !ready;
    });
    $('apply').disabled = !ready || !dirty;
    $('settings-state').textContent = !ready ? '读取中' : dirty ? '未应用修改' : '已保存';
    $('settings-state').dataset.dirty = String(dirty);
    updateProfilePath();
  }

  function selectMonitor(name) {
    if (!name) return;
    var select = $('monitor');
    if (!Array.from(select.options).some(option => option.value === name)) {
      var missing = document.createElement('option');
      missing.value = name;
      missing.textContent = name + '（未连接）';
      select.appendChild(missing);
    }
    select.value = name;
    select.title = select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
  }

  function status(text, error) {
    var node = $('status');
    node.textContent = text;
    node.className = error ? 'error' : '';
  }

  function applyStatus(payload) {
    if (!payload) return;
    revision = payload.revision || 0;
    renderProfiles(payload.profiles, payload.profile, payload.message === '已切换来源');
    if (Array.isArray(payload.monitors)) {
      const current = $('monitor').value;
      $('monitor').innerHTML = '';
      payload.monitors.forEach(function (monitor) {
        const option = document.createElement('option');
        option.value = monitor.name;
        option.textContent = monitor.label;
        option.dataset.left = String(monitor.left);
        option.dataset.top = String(monitor.top);
        option.dataset.width = String(monitor.width);
        option.dataset.height = String(monitor.height);
        option.dataset.dpi = String(monitor.dpi);
        $('monitor').appendChild(option);
      });
      const fallback = primaryMonitor(payload.monitors);
      selectMonitor(current || (fallback ? fallback.name : ''));
    }
    if (payload.config && (!dirty || payload.message === '已应用' || payload.message === '已切换来源')) {
      $('enabled').checked = !!payload.config.enabled;
      $('fps').value = String(payload.config.fps || 30);
      $('music').checked = !!payload.config.musicResponse;
      const fallback = primaryMonitor(payload.monitors);
      selectMonitor(payload.config.monitor || (fallback ? fallback.name : ''));
      if (!payload.error && (payload.message === '已应用' || payload.message === '已切换来源')) dirty = false;
    }
    ready = ready || !!payload.config;
    previewActive = !!payload.previewActive;
    if (payload.error) status(payload.error, true);
    else if (payload.message) status(payload.message, false);
    else if (previewActive) status('正在预览，尚未保存。应用或关闭设置可结束预览。', false);
    else if (ready) status(dirty ? '有未应用的修改，可先预览效果。' : '设置已保存；预览不会修改已保存的设置。', false);
    $('preview').textContent = previewActive ? '刷新预览' : '预览效果';
    syncControls();
  }

  ['enabled', 'fps', 'music', 'monitor'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      dirty = true;
      if (id === 'monitor') selectMonitor($('monitor').value);
      status('有未应用的修改，可先预览效果。', false);
      syncControls();
    });
  });
  $('profile').addEventListener('change', updateProfilePath);
  $('switch-source').addEventListener('click', function () {
    var profile = selectedProfile();
    if (!profile) {
      status('没有可切换的来源', true);
      return;
    }
    if (currentProfile && profileKey(profile) === profileKey(currentProfile)) {
      status('已经是当前来源', false);
      return;
    }
    send('switch-source', { profile: profile, expectedRevision: revision });
  });
  $('preview').addEventListener('click', function () {
    send('preview', { config: form() });
  });
  $('apply').addEventListener('click', function () {
    send('apply', { expectedRevision: revision, config: form() });
  });
  $('close').addEventListener('click', function () {
    send('close');
  });
  setInterval(function () {
    if (previewActive) send('preview-renew');
  }, 5000);

  window.hertzWallpaperSettings = { applyStatus: applyStatus };
  send('ready');
})();
