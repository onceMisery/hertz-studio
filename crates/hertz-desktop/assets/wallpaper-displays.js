// SPDX-License-Identifier: MIT
(function () {
  'use strict';

  var MODES = { single: '单屏', mirror: '镜像', span: '跨屏' };
  var MAX_GROUPS = 4, MAX_DISPLAYS = 4, instanceSequence = 0;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function list(value) { return Array.isArray(value) ? value : []; }
  function displays(group) { return list(group && group.displays); }
  function primary(monitors) { return monitors.find(function (monitor) { return monitor.primary; }) || null; }
  function connectedMonitors(monitors) {
    var seen = new Set();
    return list(monitors).filter(function (monitor) {
      if (!monitor || typeof monitor.displayId !== 'string' || !monitor.displayId || seen.has(monitor.displayId)) return false;
      seen.add(monitor.displayId);
      return true;
    });
  }
  function displayKey(selection, monitors) {
    if (!selection) return '';
    if (selection.kind === 'fixed') return 'fixed:' + selection.displayId;
    if (selection.kind === 'primary') {
      var main = primary(monitors);
      return main ? 'fixed:' + main.displayId : 'primary';
    }
    // A legacy name is deliberately never compared with a connected monitor name.
    return selection.kind === 'unresolved' ? 'unresolved:' + selection.legacyName : '';
  }
  function monitorFor(selection, monitors) {
    if (!selection) return null;
    if (selection.kind === 'primary') return primary(monitors);
    if (selection.kind === 'fixed') return monitors.find(function (monitor) { return monitor.displayId === selection.displayId; }) || null;
    return null;
  }
  function monitorName(monitor) {
    return String(monitor.name || '显示器').replace(/^\\\\\.\\/, '');
  }
  function monitorDetail(monitor) {
    var details = [];
    if (Number(monitor.width) > 0 && Number(monitor.height) > 0) details.push(monitor.width + ' × ' + monitor.height);
    if (Number(monitor.dpi) > 0) details.push(monitor.dpi + ' DPI');
    if (monitor.primary) details.push('主显示器');
    return details.join(' · ');
  }
  function groupName(index) { return '显示组 ' + (index + 1); }
  function multiEnabled(capabilities) {
    return !!capabilities && (capabilities.multiDisplay === true || list(capabilities.layouts).some(function (mode) { return mode === 'mirror' || mode === 'span'; }));
  }
  function ownership(groups, monitors) {
    var owners = new Map();
    groups.forEach(function (group, groupIndex) {
      displays(group).forEach(function (selection, memberIndex) {
        var key = displayKey(selection, monitors);
        if (!key) return;
        if (!owners.has(key)) owners.set(key, []);
        owners.get(key).push({ groupId: group.id, groupIndex: groupIndex, memberIndex: memberIndex });
      });
    });
    return owners;
  }
  function otherOwners(owners, key, groupId, memberIndex) {
    return (owners.get(key) || []).filter(function (owner) { return owner.groupId !== groupId || owner.memberIndex !== memberIndex; });
  }
  function availableMonitors(groups, monitors) {
    var owners = ownership(groups, monitors);
    return monitors.filter(function (monitor) { return !owners.has('fixed:' + monitor.displayId); });
  }
  function allowedMode(group, mode, capabilities) {
    if (!capabilities) return { allowed: false, reason: '正在读取可用的显示方式。' };
    if (!multiEnabled(capabilities)) return { allowed: false, reason: '当前桌面组件尚未开放显示组编辑。' };
    if (mode !== 'single' && list(capabilities.layouts).indexOf(mode) === -1) {
      return { allowed: false, reason: '当前桌面组件尚未开放' + MODES[mode] + '。' };
    }
    var groupLayouts = capabilities.groupLayouts && capabilities.groupLayouts[group.id];
    if (Array.isArray(groupLayouts)) {
      return groupLayouts.indexOf(mode) !== -1 ? { allowed: true, reason: '' } : { allowed: false, reason: capabilities.groupLayoutReasons && capabilities.groupLayoutReasons[group.id] || '当前画面不支持' + MODES[mode] + '，请先选择支持此布局的作品。' };
    }
    if (mode === 'mirror') {
      if (capabilities.mirrorInspection === true) return { allowed: false, reason: '正在检查当前内容的镜像支持…' };
      var kind = group.selection && group.selection.kind;
      var supported = (kind === 'builtin' || kind === 'followHertz') ? capabilities.mirrorBuiltin === true
        : kind === 'package' ? capabilities.mirrorPackages === true
        : kind === 'playlist' ? capabilities.mirrorPlaylists === true : false;
      if (!supported) return { allowed: false, reason: '当前画面尚未确认支持同步镜像。请在壁纸属性中选择支持镜像的作品。' };
    }
    return { allowed: true, reason: '' };
  }

  // This is also used by the host to report a draft conflict before its revision check.
  function inspect(input) {
    input = input || {};
    var groups = list(input.groups), monitors = connectedMonitors(input.monitors);
    var owners = ownership(groups, monitors), issues = [], groupStates = [];
    if (!groups.length) issues.push({ code: 'no-groups', text: '没有可编辑的显示组。请重新打开设置，读取已保存的配置。' });
    if (groups.length > MAX_GROUPS) issues.push({ code: 'too-many-groups', text: '显示组超过 4 个，请删除多余的组后应用。' });
    var groupIds = new Set();
    groups.forEach(function (group, index) {
      var selections = displays(group), missing = 0, unresolved = 0, overlaps = 0;
      if (!group.id || groupIds.has(group.id)) issues.push({ code: 'group-identity', groupId: group.id, text: '显示组记录重复或缺失。请重新打开设置后重试。' });
      groupIds.add(group.id);
      selections.forEach(function (selection) {
        if (selection.kind === 'unresolved') unresolved++;
        else if (!monitorFor(selection, monitors)) missing++;
        if ((owners.get(displayKey(selection, monitors)) || []).length > 1) overlaps++;
      });
      var invalidCount = !selections.length || selections.length > MAX_DISPLAYS
        || (group.mode === 'single' ? selections.length !== 1 : selections.length < 2);
      if (invalidCount) issues.push({ code: 'member-count', groupId: group.id, text: groupName(index) + (group.mode === 'single' ? '需要选择 1 台显示器。' : '需要选择 2–4 台显示器。') });
      if (overlaps) issues.push({ code: 'overlap', groupId: group.id, text: groupName(index) + '包含重复分配的显示器，请重新选择。' });
      if (!Object.prototype.hasOwnProperty.call(MODES, group.mode)) issues.push({ code: 'unknown-mode', groupId: group.id, text: groupName(index) + '的布局不可用，请重新选择显示方式。' });
      if (group.mode === 'mirror' && input.capabilities && input.capabilities.mirrorInspection === true) {
        var support = allowedMode(group, 'mirror', input.capabilities);
        if (!support.allowed) issues.push({ code: 'mirror-unavailable', groupId: group.id, text: groupName(index) + '：' + support.reason });
      }
      groupStates.push({ groupId: group.id, missing: missing, unresolved: unresolved, overlaps: overlaps, invalidCount: invalidCount });
    });
    return { multiDisplay: multiEnabled(input.capabilities), issues: issues, groups: groupStates, available: availableMonitors(groups, monitors).map(function (monitor) { return monitor.displayId; }) };
  }

  // Physical coordinates stay physical: negative origins and differing DPI are not reflowed.
  function topology(input) {
    var monitors = connectedMonitors(input).filter(function (monitor) {
      return [monitor.left, monitor.top, monitor.width, monitor.height].every(function (value) { return typeof value === 'number' && Number.isFinite(value); }) && monitor.width > 0 && monitor.height > 0;
    });
    if (!monitors.length) return { width: 720, height: 224, monitors: [], bounds: null };
    var left = Math.min.apply(null, monitors.map(function (monitor) { return monitor.left; }));
    var top = Math.min.apply(null, monitors.map(function (monitor) { return monitor.top; }));
    var right = Math.max.apply(null, monitors.map(function (monitor) { return monitor.left + monitor.width; }));
    var bottom = Math.max.apply(null, monitors.map(function (monitor) { return monitor.top + monitor.height; }));
    var scale = Math.min(672 / (right - left), 176 / (bottom - top));
    var offsetX = 24, offsetY = 24;
    return {
      width: (right - left) * scale + 48, height: (bottom - top) * scale + 48,
      bounds: { left: left, top: top, width: right - left, height: bottom - top },
      monitors: monitors.map(function (monitor) {
        return { displayId: monitor.displayId, x: offsetX + (monitor.left - left) * scale, y: offsetY + (monitor.top - top) * scale, width: monitor.width * scale, height: monitor.height * scale };
      })
    };
  }

  function newGroupId(groups) {
    var value;
    do {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') value = 'display-' + window.crypto.randomUUID();
      else if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        value = 'display-' + Array.from(window.crypto.getRandomValues(new Uint32Array(4))).map(function (part) { return part.toString(16).padStart(8, '0'); }).join('');
      } else value = 'display-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    } while (groups.some(function (group) { return group.id === value; }));
    return value;
  }

  function create(options) {
    if (!options || !options.mount || typeof options.onChange !== 'function') throw new TypeError('显示组编辑器需要挂载节点和草稿回调。');
    var mount = options.mount, document = mount.ownerDocument;
    var prefix = 'hertz-displays-' + (++instanceSequence) + '-';
    var root = document.createElement('section'); root.className = 'hertz-displays';
    root.setAttribute('aria-label', '壁纸显示组'); mount.appendChild(root);
    var state = { groups: null, monitors: [], selectedGroupId: null, disabled: true, capabilities: null, targets: [], loading: true, error: null };
    var sequence = 0, destroyed = false, busy = false, message = '', messageError = false, lastSignature = '';
    var monitorNames = new Map();

    function node(tag, className, text) {
      var result = document.createElement(tag);
      if (className) result.className = className;
      if (text != null) result.textContent = String(text);
      return result;
    }
    function button(text, key, handler) {
      var result = node('button', 'hd-button', text); result.type = 'button';
      result.dataset.focusKey = key; result.addEventListener('click', handler);
      return result;
    }
    function hint(text, className) { return node('p', 'hd-hint' + (className ? ' ' + className : ''), text); }
    function svgNode(tag, attributes, text) {
      var result = document.createElementNS(SVG_NS, tag);
      Object.keys(attributes || {}).forEach(function (name) { result.setAttribute(name, attributes[name]); });
      if (text != null) result.textContent = text;
      return result;
    }
    function selectedGroup() {
      return list(state.groups).find(function (group) { return group.id === state.selectedGroupId; }) || list(state.groups)[0] || null;
    }
    function locked() { return !!state.disabled || busy || !!state.loading || !!state.error || !multiEnabled(state.capabilities); }
    function say(text, error) { message = text; messageError = !!error; draw(); }
    function selectGroup(id) {
      if (state.disabled || busy || !list(state.groups).some(function (group) { return group.id === id; })) return;
      state.selectedGroupId = id; message = ''; draw();
      if (typeof options.onSelect === 'function') options.onSelect(id);
    }
    function commit(next, nextSelectedId, text) {
      if (locked()) return;
      var version = sequence, result;
      function finish(accepted) {
        if (destroyed) return;
        busy = false;
        if (accepted === false) { say('当前设置暂时无法修改。请等待正在进行的操作完成后重试。', true); return; }
        // Host renders are authoritative, including a host-normalized draft.
        if (version === sequence) state.groups = clone(next);
        message = text; messageError = false;
        if (nextSelectedId && list(state.groups).some(function (group) { return group.id === nextSelectedId; })) {
          state.selectedGroupId = nextSelectedId;
          if (typeof options.onSelect === 'function') options.onSelect(nextSelectedId);
        }
        draw();
      }
      try { result = options.onChange(clone(next)); }
      catch (_) { say('显示组草稿未能更新。请等待设置就绪后重试。', true); return; }
      if (result && typeof result.then === 'function') {
        busy = true; draw();
        Promise.resolve(result).then(finish, function () {
          if (destroyed) return;
          busy = false; say('显示组草稿未能更新。请等待设置就绪后重试。', true);
        });
      } else finish(result);
    }
    function changeGroup(id, update, text) {
      var next = clone(list(state.groups)), group = next.find(function (item) { return item.id === id; });
      if (!group || locked()) return;
      update(group, next);
      commit(next, null, text || '显示组已更新到草稿。应用设置后生效。');
    }
    function addGroup() {
      var current = selectedGroup(), free = availableMonitors(list(state.groups), connectedMonitors(state.monitors));
      if (locked() || !current || list(state.groups).length >= MAX_GROUPS) return;
      if (!free.length) { say('没有可分配的显示器。请连接另一台显示器，或从已有组移除一台。', true); return; }
      var next = clone(state.groups), group = clone(current);
      group.id = newGroupId(next); group.mode = 'single'; group.displays = [{ kind: 'fixed', displayId: free[0].displayId }];
      next.push(group); commit(next, group.id, '已新建显示组，沿用所选组的画面与属性。应用设置后生效。');
    }
    function removeGroup(id) {
      if (locked() || list(state.groups).length <= 1) return;
      var next = clone(state.groups).filter(function (group) { return group.id !== id; });
      commit(next, next[0].id, '已从草稿移除显示组。应用设置后释放它的显示器。');
    }
    function changeMode(id, mode) {
      var group = list(state.groups).find(function (item) { return item.id === id; });
      if (!group || !Object.prototype.hasOwnProperty.call(MODES, mode) || locked()) return;
      var support = allowedMode(group, mode, state.capabilities);
      if (!support.allowed) { say(support.reason, true); return; }
      var free = availableMonitors(state.groups, connectedMonitors(state.monitors));
      if (mode !== 'single' && displays(group).length < 2 && !free.length) { say('此布局至少需要 2 台显示器。请先连接或释放另一台显示器。', true); return; }
      changeGroup(id, function (draft) {
        draft.mode = mode;
        if (mode === 'single') draft.displays = draft.displays.slice(0, 1);
        else if (draft.displays.length < 2) draft.displays.push({ kind: 'fixed', displayId: free[0].displayId });
      }, '已将显示组改为' + MODES[mode] + '。应用设置后生效。');
    }
    function chooseDisplay(id, index, choice) {
      if (locked()) return;
      var monitors = connectedMonitors(state.monitors), owners = ownership(state.groups, monitors);
      if (otherOwners(owners, displayKey(choice, monitors), id, index).length) { say('这台显示器已分配给其他成员，请选择未分配的显示器。', true); return; }
      if (choice.kind === 'fixed' && !monitorFor(choice, monitors)) { say('这台显示器已断开。请重新连接后选择。', true); return; }
      changeGroup(id, function (group) { group.displays[index] = clone(choice); });
    }
    function selectionLabel(selection, monitors) {
      var monitor = monitorFor(selection, monitors);
      if (selection.kind === 'primary') return monitor ? '主显示器 · ' + monitorName(monitor) : '主显示器（未连接）';
      if (selection.kind === 'unresolved') return '旧显示器（需重新选择）';
      return monitor ? monitorName(monitor) : (monitorNames.get(selection.displayId) || '固定显示器') + '（未连接）';
    }
    function drawTopology(container, groups, monitors, current) {
      var diagram = topology(monitors), figure = node('figure', 'hd-topology');
      if (!diagram.monitors.length) {
        var empty = node('div', 'hd-topology-empty');
        empty.append(node('strong', '', monitors.length ? '暂时无法读取屏幕位置' : '没有检测到显示器'), hint(monitors.length ? '显示器选择仍会保留。位置恢复后会更新排列图。' : '连接显示器后会出现在这里，已保存的屏幕选择会保留。'));
        figure.appendChild(empty); container.appendChild(figure); return;
      }
      var owners = ownership(groups, monitors), svg = svgNode('svg', { viewBox: '0 0 ' + diagram.width + ' ' + diagram.height, role: 'img', 'aria-labelledby': prefix + 'topology-title ' + prefix + 'topology-desc' });
      svg.append(svgNode('title', { id: prefix + 'topology-title' }, '显示器物理排列'), svgNode('desc', { id: prefix + 'topology-desc' }, monitors.map(function (monitor) { return monitorName(monitor) + '，' + monitorDetail(monitor); }).join('；') + '。高亮为所选显示组。'));
      diagram.monitors.forEach(function (rect) {
        var monitor = monitors.find(function (item) { return item.displayId === rect.displayId; });
        var ownersForDisplay = owners.get('fixed:' + rect.displayId) || [];
        var active = !!current && ownersForDisplay.some(function (owner) { return owner.groupId === current.id; });
        var group = svgNode('g', { class: 'hd-screen' + (active ? ' is-selected' : '') + (ownersForDisplay.length > 1 ? ' has-conflict' : '') });
        group.appendChild(svgNode('rect', { x: rect.x + 2, y: rect.y + 2, width: Math.max(0, rect.width - 4), height: Math.max(0, rect.height - 4), rx: 5 }));
        group.appendChild(svgNode('title', {}, monitorName(monitor) + ' · ' + (ownersForDisplay.length ? ownersForDisplay.map(function (owner) { return groupName(owner.groupIndex); }).join('、') : '未分配')));
        if (rect.width >= 64 && rect.height >= 42) {
          var maxLength = Math.max(4, Math.floor((rect.width - 22) / 7));
          var label = monitorName(monitor); if (label.length > maxLength) label = label.slice(0, maxLength - 1) + '…';
          group.appendChild(svgNode('text', { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 - (rect.height > 68 ? 3 : -4), 'text-anchor': 'middle' }, label));
          if (rect.height > 68) group.appendChild(svgNode('text', { class: 'hd-screen-detail', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 + 17, 'text-anchor': 'middle' }, monitor.width + ' × ' + monitor.height));
        }
        svg.appendChild(group);
      });
      figure.append(svg, node('figcaption', '', '按 Windows 屏幕位置排列 · 高亮为所选显示组'));
      container.appendChild(figure);
    }
    function runtimeText(groupId) {
      var targets = list(state.targets).filter(function (target) { return target.groupId === groupId; });
      if (!targets.length) return '';
      var names = { running: '正在显示', playing: '正在显示', paused: '已暂停', suspended: '已暂停', stopped: '已停止', disabled: '已关闭', missing: '未连接', disconnected: '未连接', error: '运行失败', failed: '运行失败', preparing: '正在准备', pending: '正在准备' };
      var counts = new Map();
      targets.forEach(function (target) { var label = names[target.state || target.status]; if (label) counts.set(label, (counts.get(label) || 0) + 1); });
      return counts.size ? '当前桌面：' + Array.from(counts).map(function (entry) { return entry[1] + ' 台' + entry[0]; }).join('，') : '';
    }
    function drawGroups(container, groups, monitors, current, diagnostics) {
      var groupList = node('div', 'hd-groups'); groupList.setAttribute('aria-label', '选择显示组');
      groups.forEach(function (group, index) {
        var row = button('', 'group-' + group.id, function () { selectGroup(group.id); }); row.className = 'hd-group';
        row.setAttribute('aria-pressed', String(!!current && current.id === group.id)); row.disabled = !!state.disabled || busy;
        var label = node('span', 'hd-group-label'); label.append(node('strong', '', groupName(index)), node('span', 'hd-mode-label', MODES[group.mode] || '布局不可用'));
        var content = node('span', 'hd-group-content'); content.append(label, node('span', 'hd-group-members', displays(group).map(function (selection) { return selectionLabel(selection, monitors); }).join('、') || '尚未选择显示器'));
        var summary = diagnostics.groups[index];
        var status = summary.overlaps ? '分配冲突' : summary.unresolved ? '需重新选择' : summary.missing ? summary.missing + ' 台未连接' : summary.invalidCount ? '成员不足' : current && current.id === group.id ? '正在编辑' : displays(group).length + ' 台显示器';
        var statusNode = node('span', 'hd-group-status', status);
        if (summary.overlaps || summary.unresolved || summary.missing || summary.invalidCount) statusNode.classList.add('hd-attention');
        row.append(content, statusNode); groupList.appendChild(row);
      });
      container.appendChild(groupList);
    }
    function drawMember(container, group, memberIndex, monitors, owners) {
      var selection = displays(group)[memberIndex], monitor = monitorFor(selection, monitors);
      var row = node('div', 'hd-member'), field = node('label', 'hd-field'), select = node('select', 'hd-select');
      var key = 'member-' + group.id + '-' + memberIndex, helperId = prefix + 'member-help-' + memberIndex;
      select.dataset.focusKey = key; select.setAttribute('aria-describedby', helperId); select.disabled = locked();
      field.appendChild(node('span', 'hd-label', group.mode === 'single' ? '显示器' : '成员 ' + (memberIndex + 1)));
      var choices = [], currentValue = '';
      function option(choice, label, unavailable) {
        var value = String(choices.length), optionNode = node('option', '', label); optionNode.value = value;
        var occupied = choice && otherOwners(owners, displayKey(choice, monitors), group.id, memberIndex);
        if (occupied && occupied.length) {
          optionNode.textContent += occupied[0].groupId === group.id ? ' · 已在此组选择' : ' · 已分配给' + groupName(occupied[0].groupIndex);
          optionNode.disabled = true;
        }
        if (unavailable) optionNode.disabled = true;
        choices.push(choice); select.appendChild(optionNode);
        if (choice && choice.kind === selection.kind && (choice.kind === 'primary' || choice.displayId === selection.displayId)) currentValue = value;
        return value;
      }
      if (selection.kind === 'unresolved' || (selection.kind === 'fixed' && !monitor)) currentValue = option(null, selectionLabel(selection, monitors), true);
      option({ kind: 'primary' }, '主显示器（自动跟随）', !primary(monitors) && selection.kind !== 'primary');
      monitors.forEach(function (item) { option({ kind: 'fixed', displayId: item.displayId }, monitorName(item) + (monitorDetail(item) ? ' · ' + monitorDetail(item) : ''), false); });
      select.value = currentValue;
      select.addEventListener('change', function () { var choice = choices[Number(select.value)]; if (choice) chooseDisplay(group.id, memberIndex, choice); });
      field.appendChild(select); row.appendChild(field);
      var helper = selection.kind === 'unresolved' ? '请选择一台显示器。旧记录不会自动绑定到当前屏幕。'
        : !monitor ? '显示器未连接。请连接原显示器，或在上方重新选择。'
        : selection.kind === 'primary' ? '自动跟随 Windows 当前设置的主显示器。'
        : '固定选择这台显示器；断开后保留选择。';
      var collision = otherOwners(owners, displayKey(selection, monitors), group.id, memberIndex);
      if (collision.length) helper = '这台显示器被重复分配。请在此处或另一个组重新选择。';
      var helpNode = hint(helper, !monitor || collision.length ? 'hd-attention' : ''); helpNode.id = helperId;
      select.setAttribute('aria-invalid', String(collision.length > 0 || selection.kind === 'unresolved'));
      row.appendChild(helpNode);
      if (group.mode !== 'single') {
        var remove = button('移除此屏', 'remove-member-' + memberIndex, function () {
          if (displays(group).length <= 2) return;
          changeGroup(group.id, function (draft) { draft.displays.splice(memberIndex, 1); });
        });
        remove.classList.add('hd-subtle'); remove.disabled = locked() || displays(group).length <= 2;
        remove.setAttribute('aria-label', '从' + groupName(state.groups.indexOf(group)) + '移除成员 ' + (memberIndex + 1));
        if (displays(group).length <= 2) remove.title = MODES[group.mode] + '至少保留 2 台显示器';
        row.appendChild(remove);
      }
      container.appendChild(row);
    }
    function drawEditor(container, groups, monitors, group) {
      var editor = node('div', 'hd-editor'), index = groups.indexOf(group);
      var heading = node('div', 'hd-editor-heading'); heading.appendChild(node('h3', '', groupName(index)));
      var remove = button('删除组', 'remove-group', function () { removeGroup(group.id); }); remove.classList.add('hd-subtle'); remove.disabled = locked() || groups.length <= 1;
      if (groups.length <= 1) remove.title = '至少保留 1 个显示组';
      heading.appendChild(remove); editor.appendChild(heading);
      var modeField = node('label', 'hd-field'), modeSelect = node('select', 'hd-select');
      modeSelect.dataset.focusKey = 'mode'; modeSelect.disabled = locked(); modeSelect.setAttribute('aria-describedby', prefix + 'mode-help');
      var free = availableMonitors(groups, monitors), reasons = [];
      Object.keys(MODES).forEach(function (mode) {
        var support = allowedMode(group, mode, state.capabilities), countReady = mode === 'single' || displays(group).length >= 2 || free.length > 0;
        var label = mode === 'single' ? '单屏 · 独立画面' : mode === 'mirror' ? '镜像 · 每屏显示相同画面' : '跨屏 · 共同显示完整画面';
        var option = node('option', '', label + (!support.allowed ? '（暂不可用）' : !countReady ? '（需要另一台显示器）' : ''));
        option.value = mode; option.disabled = !support.allowed || !countReady; modeSelect.appendChild(option);
        if (mode !== 'single' && !support.allowed && reasons.indexOf(support.reason) === -1) reasons.push(support.reason);
      });
      modeSelect.value = group.mode; modeSelect.addEventListener('change', function () { changeMode(group.id, modeSelect.value); });
      modeField.append(node('span', 'hd-label', '布局方式'), modeSelect); editor.appendChild(modeField);
      var descriptions = {
        single: '一台显示器使用此组的画面与属性。',
        mirror: '每台显示器独立呈现同一作品，共用播放进度。某一屏暂停时，其它屏幕可继续。',
        span: '将所选显示器的物理区域合成一张画布，按各屏的位置显示对应部分。'
      };
      var modeHelp = hint((descriptions[group.mode] || '请选择可用的布局方式。') + (group.mode !== 'single' ? ' 改为单屏时只保留第一台显示器。' : '')); modeHelp.id = prefix + 'mode-help'; editor.appendChild(modeHelp);
      if (reasons.length) editor.appendChild(hint(reasons.join(' '), 'hd-capability-note'));
      if (group.mode !== 'single' && displays(group).length < 2) editor.appendChild(hint('此布局至少需要 2 台显示器，请添加成员或改为单屏。', 'hd-attention'));
      var members = node('div', 'hd-members'), owners = ownership(groups, monitors);
      displays(group).forEach(function (_, memberIndex) { drawMember(members, group, memberIndex, monitors, owners); });
      editor.appendChild(members);
      if (group.mode !== 'single') {
        var add = button('添加显示器', 'add-member', function () {
          var available = availableMonitors(state.groups, connectedMonitors(state.monitors));
          if (!available.length || displays(group).length >= MAX_DISPLAYS) return;
          changeGroup(group.id, function (draft) { draft.displays.push({ kind: 'fixed', displayId: available[0].displayId }); });
        });
        add.disabled = locked() || !free.length || displays(group).length >= MAX_DISPLAYS; editor.appendChild(add);
        editor.appendChild(hint(displays(group).length >= MAX_DISPLAYS ? '此组已达到 4 台显示器的上限。' : !free.length ? '没有未分配的显示器。连接另一台，或从其它组释放一台后再添加。' : '可以继续添加未分配的显示器。'));
      }
      var runtime = runtimeText(group.id); if (runtime) editor.appendChild(hint(runtime, 'hd-runtime'));
      editor.appendChild(hint('此组的场景与画面参数可在“壁纸属性”中调整。', 'hd-property-note'));
      container.appendChild(editor);
    }
    function drawLoading() {
      root.setAttribute('aria-busy', 'true');
      var loading = node('div', 'hd-loading'); loading.setAttribute('role', 'status');
      loading.append(node('span', 'hd-loading-label', '正在读取显示器与显示组…'));
      ['hd-skeleton-title', 'hd-skeleton-topology', 'hd-skeleton-row', 'hd-skeleton-row'].forEach(function (className) { var block = node('div', 'hd-skeleton ' + className); block.setAttribute('aria-hidden', 'true'); loading.appendChild(block); });
      root.appendChild(loading);
    }
    function draw() {
      if (destroyed) return;
      var signature = JSON.stringify([state, busy, message, messageError]);
      if (signature === lastSignature) return;
      lastSignature = signature;
      var active = document.activeElement, focusKey = active && root.contains(active) ? active.dataset.focusKey : null;
      root.replaceChildren();
      if ((state.loading || !Array.isArray(state.groups)) && !state.error) { drawLoading(); return; }
      root.setAttribute('aria-busy', String(busy));
      var groups = list(state.groups), monitors = connectedMonitors(state.monitors), current = selectedGroup();
      var diagnostics = inspect({ groups: groups, monitors: monitors, capabilities: state.capabilities });
      var heading = node('div', 'hd-heading'), headingText = node('div', 'hd-heading-text');
      headingText.append(node('h2', '', '显示组'), hint(groups.length + ' / ' + MAX_GROUPS + ' 组 · ' + monitors.length + ' 台显示器已连接'));
      var add = button('新建显示组', 'add-group', addGroup); add.disabled = locked() || !current || groups.length >= MAX_GROUPS || !diagnostics.available.length;
      heading.append(headingText, add); root.appendChild(heading);
      if (state.error) {
        var error = hint('显示器信息读取失败。请重新打开设置后重试；当前选择会保留。', 'hd-notice hd-attention'); error.setAttribute('role', 'alert'); root.appendChild(error);
      } else if (!multiEnabled(state.capabilities)) {
        root.appendChild(hint(state.capabilities ? '当前桌面组件尚未开放多屏显示组。已保存的分组仅供查看。' : '正在读取桌面组件支持的显示方式，暂时无法编辑。', 'hd-notice'));
      } else if (groups.length >= MAX_GROUPS) root.appendChild(hint('已达到 4 个显示组。可修改已有组，或删除不再使用的组。', 'hd-availability'));
      else if (!diagnostics.available.length) root.appendChild(hint(monitors.length ? '所有已连接的显示器都已分配。连接另一台，或从已有组释放一台后可新建。' : '连接显示器后可新建显示组。', 'hd-availability'));
      diagnostics.issues.forEach(function (issue) { var notice = hint(issue.text, 'hd-notice hd-attention'); notice.setAttribute('role', 'alert'); root.appendChild(notice); });
      drawTopology(root, groups, monitors, current);
      if (groups.length) {
        drawGroups(root, groups, monitors, current, diagnostics);
        if (current) drawEditor(root, groups, monitors, current);
      }
      var status = hint(message, 'hd-message' + (messageError ? ' hd-attention' : '')); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); root.appendChild(status);
      if (focusKey) {
        var target = Array.from(root.querySelectorAll('[data-focus-key]')).find(function (element) { return element.dataset.focusKey === focusKey && !element.disabled; });
        if (!target && current) target = Array.from(root.querySelectorAll('[data-focus-key]')).find(function (element) { return element.dataset.focusKey === 'group-' + current.id && !element.disabled; });
        if (target) target.focus({ preventScroll: true });
      }
    }
    function render(input) {
      if (destroyed) return;
      sequence++;
      state = Object.assign({}, state, input || {});
      connectedMonitors(state.monitors).forEach(function (monitor) { monitorNames.set(monitor.displayId, monitorName(monitor)); });
      if (input && Object.prototype.hasOwnProperty.call(input, 'groups') && !Object.prototype.hasOwnProperty.call(input, 'loading')) state.loading = !Array.isArray(input.groups);
      draw();
    }
    draw();
    return {
      render: render,
      destroy: function () { destroyed = true; sequence++; monitorNames.clear(); root.remove(); }
    };
  }

  window.hertzWallpaperDisplays = Object.freeze({ create: create, inspect: inspect, topology: topology });
})();
