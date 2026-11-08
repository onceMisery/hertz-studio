// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// Portable page preferences are a transport schema, not another settings owner.
// Read only registered keys; validate the entire document before planning writes.
// Account data, history, caches, assets, live timers and stage projects stay out.

(function (global) {
  'use strict';

  var KIND = 'hertz-ui-preferences';
  var VERSION = 1;
  var MAX_BYTES = 64 * 1024;
  var MAX_ITEMS = 32;
  var callbacks = Object.create(null);
  var schemas = [];
  var byKey = Object.create(null);
  var hasOwn = Object.prototype.hasOwnProperty;

  function fail(code, message) {
    var error = new Error(message);
    error.code = code;
    throw error;
  }

  // Count the UTF-8 file itself, including whitespace and a possible BOM.
  // Modern browser and WebView hosts provide TextEncoder; the fallback retains
  // the same replacement behavior for unpaired UTF-16 surrogates.
  function byteLength(text) {
    if (typeof global.TextEncoder === 'function') return new global.TextEncoder().encode(text).byteLength;
    var count = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code < 0x80) count += 1;
      else if (code < 0x800) count += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
          && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        count += 4; i += 1;
      } else count += 3;
    }
    return count;
  }

  function isRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function safeStructure(value, depth) {
    if (depth > 6) fail('unsafe-value', '偏好文件的对象嵌套过深');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || (!Array.isArray(value) && !isRecord(value))) {
      fail('invalid-type', '偏好文件只能包含 JSON 类型的值');
    }
    if (Object.getOwnPropertySymbols(value).length) fail('unsafe-value', '偏好文件包含不支持的属性');
    Object.getOwnPropertyNames(value).forEach(function (key) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        fail('unsafe-value', '偏好文件包含禁止的对象属性');
      }
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !hasOwn.call(descriptor, 'value')) fail('unsafe-value', '偏好文件包含不支持的属性');
      if (Array.isArray(value) && key === 'length') return;
      if (!descriptor.enumerable) fail('unsafe-value', '偏好文件包含不支持的属性');
      safeStructure(descriptor.value, depth + 1);
    });
  }

  function exactFields(value, fields, label) {
    if (!isRecord(value) || Object.keys(value).length !== fields.length
        || !fields.every(function (key) { return hasOwn.call(value, key); })) {
      fail('invalid-fields', label + '的字段不符合当前版本');
    }
  }

  function parseJson(text) {
    try {
      return JSON.parse(text, function (key, value) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
          fail('unsafe-value', '偏好文件包含禁止的对象属性');
        }
        return value;
      });
    } catch (error) {
      if (error.code) throw error;
      fail('invalid-json', '偏好文件不是有效的 JSON');
    }
  }

  function enumValue(value, options) {
    if (typeof value !== 'string' || options.indexOf(value) < 0) {
      fail('invalid-value', '偏好值不是当前版本支持的选项');
    }
    return value;
  }

  function booleanValue(value) {
    if (typeof value !== 'boolean') fail('invalid-type', '偏好值必须是布尔值');
    return value;
  }

  function colorValue(value) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
      fail('invalid-value', '偏好颜色必须是六位 HEX 颜色');
    }
    return value.toLowerCase();
  }

  function integerValue(value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
      fail('invalid-value', '偏好数值超出当前版本支持的范围');
    }
    return value;
  }

  function readFlag(raw) {
    if (raw !== '1' && raw !== '0') fail('invalid-value', '已保存的偏好布尔值无效');
    return raw === '1';
  }

  function readInteger(raw) {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) fail('invalid-value', '已保存的偏好数值无效');
    return Number(raw);
  }

  function transferOwner(name, method) {
    var owner = global[name];
    if (!owner || typeof owner[method || 'preferenceTransfer'] !== 'function') {
      fail('owner-not-ready', '偏好模块尚未就绪，请稍后重试');
    }
    return function (value) { return owner[method || 'preferenceTransfer'](value); };
  }

  function callbackOwner(name) {
    if (typeof callbacks[name] !== 'function') fail('owner-not-ready', '偏好模块尚未就绪，请稍后重试');
    return callbacks[name];
  }

  function register(key, label, decode, transfer, markers) {
    var schema = { key: key, label: label, decode: decode, transfer: transfer, markers: markers || [] };
    schemas.push(schema); byKey[key] = schema;
  }

  function simple(key, label, decode, validate, encode) {
    register(key, label, decode, function (value) {
      var checked = validate(value);
      return { value: checked, writes: [{ key: key, value: encode ? encode(checked) : checked }] };
    });
  }

  function flag(key, label) {
    simple(key, label, readFlag, booleanValue, function (value) { return value ? '1' : '0'; });
  }

  function choice(key, label, options) {
    simple(key, label, function (raw) { return raw; }, function (value) { return enumValue(value, options); });
  }

  register('vmusic.theme.v2', '界面主题', function (raw) { return raw; }, function (value) {
    return transferOwner('Theme')(value);
  }, ['vmusic.theme.mineral-default']);
  register('vmusic.theme.custom.v1', '自定义配色', parseJson, function (value) {
    return transferOwner('ThemeStudio')(value);
  });
  register('vmusic.skin', '界面布局', function (raw) { return raw; }, function (value) {
    return transferOwner('Skins')(value);
  }, ['vmusic.skin.default']);
  register('vmusic.defaultView', '启动页面', function (raw) { return raw; }, function (value) {
    return callbackOwner('defaultViewTransfer')(value);
  });
  register('vmusic.playlists.mode', '歌单排布', function (raw) { return raw; }, function (value) {
    return callbackOwner('playlistTransfer')(value);
  }, ['vmusic.playlists.viewV2']);
  choice('vmusic.daily.mode', '首页推荐来源', ['online', 'local']);
  flag('vmusic.daily.collapsed', '首页推荐折叠');
  choice('vmusic.dailyview.layout', '每日推荐排布', ['list', 'card']);
  choice('vmusic.dailyview.mode', '每日推荐来源', ['online', 'local']);
  simple('hertz-reader-preferences', '阅读字号与外观', parseJson, function (value) {
    exactFields(value, ['size', 'font', 'theme'], '阅读偏好');
    return { size: integerValue(value.size, 16, 23), font: enumValue(value.font, ['serif', 'sans']),
      theme: enumValue(value.theme, ['light', 'dark']) };
  }, JSON.stringify);
  choice('vmusic.stage.mode', '二维歌词展示', ['cover', 'karaoke', 'scatter']);
  register('vmusic.stage.control', '二维舞台参数', parseJson, function (value) {
    return transferOwner('StageControl')(value);
  }, ['vmusic.stage.control.v']);
  flag('vmusic.qf-wall', '封面墙熄灯');
  flag('vmusic.qf-wall-follow', '封面墙跟随当前曲目');
  flag('vmusic.qf-wall-vignette', '封面墙暗角');
  flag('vmusic.qf-wall-tint', '封面墙染色');
  simple('vmusic.qf-wall-tint-color', '封面墙染色颜色', function (raw) { return raw; }, colorValue);
  simple('vmusic.qf-wall-tint-intensity', '封面墙染色强度', readInteger, function (value) {
    return integerValue(value, 0, 100);
  }, String);

  function checkedEntry(item) {
    exactFields(item, ['key', 'schemaVersion', 'value'], '偏好项');
    if (typeof item.key !== 'string' || !hasOwn.call(byKey, item.key)) {
      fail('unknown-key', '偏好文件包含当前版本不支持的键');
    }
    if (item.schemaVersion !== VERSION) fail('unknown-version', '偏好项版本不受当前版本支持');
    var schema = byKey[item.key];
    var result;
    try { result = schema.transfer(item.value); }
    catch (error) {
      if (error.code === 'owner-not-ready') throw error;
      fail(error.code || 'invalid-value', schema.label + '：' + error.message);
    }
    if (!isRecord(result) || !hasOwn.call(result, 'value') || !Array.isArray(result.writes)) {
      fail('owner-contract', schema.label + '的迁移模块返回了无效结果');
    }
    safeStructure(result.value, 0);
    var seen = Object.create(null);
    var storageValue = null;
    var writes = result.writes.map(function (write) {
      if (!isRecord(write) || typeof write.key !== 'string' || typeof write.value !== 'string'
          || (write.key !== schema.key && schema.markers.indexOf(write.key) < 0) || seen[write.key]) {
        fail('owner-contract', schema.label + '的迁移模块返回了无效写入');
      }
      seen[write.key] = true;
      if (write.key === schema.key) storageValue = write.value;
      return { key: write.key, value: write.value };
    });
    if (storageValue === null || !schema.markers.every(function (key) { return seen[key]; })) {
      fail('owner-contract', schema.label + '的迁移模块未返回完整写入');
    }
    return { entry: { key: item.key, label: schema.label, schemaVersion: VERSION,
      value: result.value, storageValue: storageValue }, writes: writes };
  }

  function validateDocument(document) {
    safeStructure(document, 0);
    exactFields(document, ['kind', 'schemaVersion', 'preferences'], '偏好文件');
    if (document.kind !== KIND) fail('unknown-kind', '这不是 Hertz 界面偏好文件');
    if (document.schemaVersion !== VERSION) fail('unknown-version', '偏好文件版本不受当前版本支持');
    if (!Array.isArray(document.preferences)) fail('invalid-type', '偏好项必须是数组');
    if (document.preferences.length > MAX_ITEMS) fail('too-many-items', '偏好文件最多支持 32 项');
    var seen = Object.create(null);
    var checked = document.preferences.map(function (item) {
      var result = checkedEntry(item);
      if (seen[result.entry.key]) fail('duplicate-key', '偏好文件包含重复的键');
      seen[result.entry.key] = true;
      return result;
    });
    var theme = checked.find(function (result) { return result.entry.key === 'vmusic.theme.v2'; });
    var customId = global.ThemeStudio && typeof global.ThemeStudio.customThemeId === 'function'
      ? global.ThemeStudio.customThemeId() : null;
    if (theme && theme.entry.value === customId && !seen['vmusic.theme.custom.v1']) {
      fail('missing-dependency', '选择自定义主题的文件必须同时包含自定义配色');
    }
    var normalized = { kind: KIND, schemaVersion: VERSION, preferences: checked.map(function (result) {
      return { key: result.entry.key, schemaVersion: VERSION, value: result.entry.value };
    }) };
    if (byteLength(JSON.stringify(normalized, null, 2)) > MAX_BYTES) {
      fail('too-large', '偏好文件不能超过 64 KiB');
    }
    return { document: normalized, entries: checked.map(function (result) { return result.entry; }), checked: checked };
  }

  function exportDocument() {
    var preferences = [];
    schemas.forEach(function (schema) {
      var raw;
      try { raw = global.localStorage.getItem(schema.key); }
      catch (error) { fail('storage-read-failed', '无法读取' + schema.label + '：' + error.message); }
      if (raw === null) return;
      if (typeof raw !== 'string' || byteLength(raw) > MAX_BYTES) fail('too-large', schema.label + '的已保存值过大或无效');
      var value;
      try { value = schema.decode(raw); }
      catch (error) { fail(error.code || 'invalid-value', schema.label + '：' + error.message); }
      preferences.push({ key: schema.key, schemaVersion: VERSION, value: value });
    });
    return validateDocument({ kind: KIND, schemaVersion: VERSION, preferences: preferences }).document;
  }

  function parse(text) {
    if (typeof text !== 'string') fail('invalid-type', '偏好文件内容必须是文本');
    if (byteLength(text) > MAX_BYTES) fail('too-large', '偏好文件不能超过 64 KiB');
    var checked = validateDocument(parseJson(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
    return { document: checked.document, entries: checked.entries };
  }

  function writes(validated) {
    if (!isRecord(validated) || !hasOwn.call(validated, 'document')) fail('invalid-type', '请先校验偏好文件');
    // The preview's entries/storageValue are display data. Revalidate the source
    // document so altering those fields can never add arbitrary storage writes.
    return validateDocument(validated.document).checked.reduce(function (all, result) {
      return all.concat(result.writes);
    }, []);
  }

  function configure(options) {
    if (!isRecord(options)) fail('invalid-type', '偏好模块配置无效');
    Object.keys(options).forEach(function (name) {
      if ((name !== 'playlistTransfer' && name !== 'defaultViewTransfer') || typeof options[name] !== 'function') {
        fail('invalid-value', '偏好模块配置无效');
      }
      callbacks[name] = options[name];
    });
  }

  global.UiPreferences = Object.freeze({ kind: KIND, schemaVersion: VERSION, maxBytes: MAX_BYTES,
    maxItems: MAX_ITEMS, configure: configure, exportDocument: exportDocument, parse: parse, writes: writes });
})(window);
