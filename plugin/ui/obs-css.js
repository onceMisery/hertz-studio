// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// OBS 浮层的「素材通道」（folia obsCustomCss 的等价物）。
//
// 为什么需要它：浮层的风格、字号、对齐、颜色都能塞进 URL，**上传的图片不能** ——
// 一个本地 File 没有可分享的地址，OBS 的浏览器源（尤其跑在另一台机器上时）也读不到
// 本应用的存储。所以把用户选的图在本地压成数据 URL，拼成一段 CSS 让用户粘进
// OBS「浏览器源 → 自定义 CSS」：
//
//   body { background-color: rgba(0, 0, 0, 0); margin: 0; overflow: hidden; }
//   :root {
//     --hz-obs-bg: url("data:image/jpeg;base64,...");
//     --hz-obs-logo: url("data:image/png;base64,...");
//   }
//
// 浮层页把这几个自定义属性用 getComputedStyle 读回来（readAssets），所以两边的
// 契约就是「变量名 + url("data:…") 的形状」，由 scripts/check-obs-css.js 钉住。
//
// 两条通道的分工：URL 只管风格与几何（style/scale/align/color/dim），这条只管素材。
// 素材不落服务端设置表 —— 它只服务于「复制一次、粘进 OBS」这个动作，OBS 自己会
// 把配置存下来，没必要让几 MB 的 data URL 进 settings 行。

(function () {
  'use strict';

  // 浮层按 `url("data:…")` 读，所以变量值必须是这个形状（CSS 自定义属性不会
  // 替我们做解析，getComputedStyle 拿到的就是原样的字符串）。
  var VAR_BG = '--hz-obs-bg';
  var VAR_LOGO = '--hz-obs-logo';
  var VAR_LOGO_POS = '--hz-obs-logo-pos';
  var LOGO_POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
  var LOGO_POS_DEFAULT = 'top-right';

  // 背景图在浮层里是铺满整页的（cover），再大也只是被浏览器缩回去，而这段 CSS 要
  // 塞进 OBS 的输入框、随场景配置一起保存：1280 长边 JPEG 已经看不出压缩痕迹，
  // 整段片段也稳定停在几百 KB。
  var BACKGROUND_MAX_SIZE = 1280;
  var BACKGROUND_QUALITY = 0.82;
  // 台标在屏幕上只是很小的一块，512 长边足够；必须保留透明通道，所以走 PNG。
  var LOGO_MAX_SIZE = 512;
  // 单条 data URL 的硬上限。正常路径（1280 JPEG / 512 PNG）离它很远，这条只兜
  // 「编码异常」与「有人手改片段塞了张巨图」——CSS 片段会被 CEF 整段执行，
  // 无限膨胀对 OBS 没有好处。
  var MAX_DATA_URL_CHARS = 8 * 1024 * 1024;

  var KINDS = {
    background: { maxSize: BACKGROUND_MAX_SIZE, mime: 'image/jpeg', quality: BACKGROUND_QUALITY, label: '背景图' },
    logo: { maxSize: LOGO_MAX_SIZE, mime: 'image/png', quality: undefined, label: '台标' }
  };

  /// 把一张用户选的图缩到长边 maxSize 以内并编成 data URL。
  ///
  /// JPEG 没有透明通道，带透明的 PNG 会被 canvas 填成黑色 —— 比原始观感突兀得多，
  /// 所以背景图那一路显式先铺一层与界面同色的底（#09090b），让「透明区域」
  /// 落到一个确定的颜色上，而不是由编码器决定。
  function encode(kind, file) {
    var spec = KINDS[kind];
    if (!spec) return Promise.reject(new Error('未知的素材类型：' + kind));
    if (!file) return Promise.reject(new Error('没有选到文件'));
    if (!/^image\//.test(file.type || '')) return Promise.reject(new Error('只支持图片文件'));

    return new Promise(function (resolve, reject) {
      var objectUrl = URL.createObjectURL(file);
      var image = new Image();
      var done = function (fn, value) {
        URL.revokeObjectURL(objectUrl);
        fn(value);
      };
      image.onload = function () {
        try {
          var width = image.naturalWidth || image.width;
          var height = image.naturalHeight || image.height;
          if (!width || !height) throw new Error('这张图读不出尺寸');
          var scale = Math.min(1, spec.maxSize / Math.max(width, height));
          var canvasWidth = Math.max(1, Math.round(width * scale));
          var canvasHeight = Math.max(1, Math.round(height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = canvasWidth;
          canvas.height = canvasHeight;
          var context = canvas.getContext('2d');
          if (!context) throw new Error('拿不到 canvas 2d 上下文');
          if (spec.mime === 'image/jpeg') {
            context.fillStyle = '#09090b';
            context.fillRect(0, 0, canvasWidth, canvasHeight);
          }
          context.drawImage(image, 0, 0, canvasWidth, canvasHeight);
          var dataUrl = canvas.toDataURL(spec.mime, spec.quality);
          if (!/^data:/.test(dataUrl)) throw new Error('编码失败');
          if (dataUrl.length > MAX_DATA_URL_CHARS) {
            throw new Error('压完仍有 ' + Math.round(dataUrl.length / 1024 / 1024) + 'MB，换一张小一点的图');
          }
          done(resolve, dataUrl);
        } catch (err) {
          done(reject, err);
        }
      };
      image.onerror = function () { done(reject, new Error('这张图读不出来（格式不支持或文件损坏）')); };
      image.src = objectUrl;
    });
  }

  /// 拼出给 OBS 的 CSS 片段。没有任何素材时回 null，让调用方能据此禁用按钮
  /// 而不是塞一段空规则进去。
  function buildSnippet(assets) {
    var declarations = [];
    if (assets && assets.background) {
      declarations.push('  ' + VAR_BG + ': url("' + assets.background + '");');
    }
    if (assets && assets.logo) {
      declarations.push('  ' + VAR_LOGO + ': url("' + assets.logo + '");');
    }
    if (!declarations.length) return null;
    return [
      '/* hertz-studio 浮层素材。粘进 OBS「浏览器源 → 自定义 CSS」，改完点一下',
      '   该源的「刷新页面缓存」或重开这个源。',
      '   台标默认在右上角；换位置去掉下面这行的注释并改成',
      '   top-left / bottom-left / bottom-right 之一：',
      '   ' + VAR_LOGO_POS + ': bottom-left; */',
      // 浮层页自己已经清过 body 的边距与背景，这里再写一遍是刻意的：OBS 注入的
      // 自定义 CSS 排在页面样式之后，带上这两行，片段就是一个完整的「落地件」，
      // 而不是「必须和本页样式配合才成立」的半成品。
      'body { background-color: rgba(0, 0, 0, 0); margin: 0; overflow: hidden; }',
      ':root {',
      declarations.join('\n'),
      '}',
      ''
    ].join('\n');
  }

  /// 从自定义属性值里取出 data URL。只认 `url("data:…")` 这一种形状：
  /// 空值、手改坏的片段、别处写进去的普通颜色一律回 null，浮层据此回退到透明。
  function parseDataUrl(value) {
    if (!value) return null;
    var match = /url\(\s*["']?(data:[^"')]+)["']?\s*\)/.exec(value);
    return match ? match[1] : null;
  }

  /// 消费侧（浮层页）：读 OBS 注入的自定义属性。
  function readAssets() {
    var empty = { background: null, logo: null, logoPos: LOGO_POS_DEFAULT };
    if (typeof getComputedStyle !== 'function' || !document.documentElement) return empty;
    var style = getComputedStyle(document.documentElement);
    var pos = String(style.getPropertyValue(VAR_LOGO_POS) || '').trim();
    return {
      background: parseDataUrl(style.getPropertyValue(VAR_BG)),
      logo: parseDataUrl(style.getPropertyValue(VAR_LOGO)),
      logoPos: LOGO_POSITIONS.indexOf(pos) >= 0 ? pos : LOGO_POS_DEFAULT
    };
  }

  window.ObsCss = {
    VAR_BG: VAR_BG,
    VAR_LOGO: VAR_LOGO,
    VAR_LOGO_POS: VAR_LOGO_POS,
    LOGO_POSITIONS: LOGO_POSITIONS,
    LOGO_POS_DEFAULT: LOGO_POS_DEFAULT,
    MAX_DATA_URL_CHARS: MAX_DATA_URL_CHARS,
    KINDS: KINDS,
    encode: encode,
    buildSnippet: buildSnippet,
    parseDataUrl: parseDataUrl,
    readAssets: readAssets
  };
})();
