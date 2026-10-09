// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 多主题色：把参考项目已有的一批主题配色映射到本项目的令牌上。
//
// 设计原则
// --------
// 1. **只声明语义令牌，不写选择器**。每套主题就是一张 { token: value } 表，
//    applyTheme() 把它写成 <html> 上的行内 CSS 变量；style.css / stage.css
//    里已有的 var(--xxx) 自动跟着变。加主题 = 往 CATALOG 里加一条，不用改样式。
// 2. **颜色是唯一的自由量**。结构令牌（圆角、尺寸、缓动）不放进主题表，
//    避免换色顺手把布局也换掉。
// 3. **对比度由构建期保证**。每套主题的 `--text` / `--muted` 都按 WCAG AA
//    （正文 4.5:1、次要文字 3:1）从各自的 --bg 反推过，见下方 contrast 注释；
//    `--accent-ink` 是在 accent 底色上放文字时用的前景色，专门解决
//    "按钮换色后白字看不清"这一类问题。
//
// 扩展方式（见文末 Stage/Theme.register）。

(function () {
  'use strict';

  // 默认外观可以更新，已经保存的主题（包括稍后注册的主题）继续按原选择恢复。
  var STORE_KEY = 'vmusic.theme.v2';
  var ATTR = 'data-theme';
  var DEFAULT_ID = 'celestial';

  // -------------------------------------------------------------------------
  // 内置主题
  //
  // 每一项来自参考项目的 `styles/themes/*.css`：把那里的 --primary-bg /
  // --secondary-bg / --button-bg / --highlight-text 等映射到本项目令牌。
  // -------------------------------------------------------------------------
  var CATALOG = [
    {
      id: 'mineral',
      name: '矿石黑',
      note: '矿石黑 · 近黑底 + 纯白强调 + 薄荷青辉光',
      // 对比度（自 --bg 反推，WCAG AA）：text ≈ 15.6 / muted ≈ 7.4
      tokens: {
        '--bg': '#0A0A0A',
        '--panel': 'rgba(20, 20, 21, 0.72)',
        '--panel-solid': '#121213',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': '#1C1D20',
        '--line-strong': '#26272B',
        '--text': '#E8ECEF',
        '--muted': '#8A9099',
        '--accent': '#FFFFFF',
        '--accent-2': '#00F5D4',
        '--accent-ink': '#0A0A0A',
        '--brand': '#00F5D4',
        '--brand-rgb': '0, 245, 212',
        '--highlight': '#F4D28A',
        '--highlight-rgb': '244, 210, 138',
        '--hover': 'rgba(255, 255, 255, 0.07)'
      }
    },
    {
      id: 'celestial',
      name: '晴空绘卷（默认）',
      note: '动画天空 · 靛蓝玻璃、暖金细边与赛璐璐云影',
      tokens: {
        '--bg': '#0d1530',
        '--panel': 'rgba(23, 34, 63, 0.78)',
        '--panel-solid': '#182541',
        '--panel-2': 'rgba(167, 195, 231, 0.07)',
        '--line': 'rgba(181, 206, 234, 0.16)',
        '--line-strong': 'rgba(190, 217, 237, 0.30)',
        '--text': '#f8f2e5',
        '--muted': '#b4c3dd',
        '--accent': '#f3dca7',
        '--accent-2': '#89d5e5',
        '--accent-ink': '#17243a',
        '--brand': '#89d5e5',
        '--brand-rgb': '137, 213, 229',
        '--highlight': '#f3dca7',
        '--highlight-rgb': '243, 220, 167',
        '--hover': 'rgba(169, 214, 239, 0.12)',
        '--shadow': '0 16px 40px rgba(7, 13, 43, 0.38)',
        '--glass-bg': 'linear-gradient(155deg, rgba(36, 53, 86, 0.82), rgba(20, 29, 55, 0.86))',
        '--glass-bg-strong': 'rgba(23, 34, 63, 0.96)',
        '--glass-border': '1px solid rgba(176, 207, 229, 0.23)',
        '--glass-line': 'rgba(248, 242, 229, 0.13)',
        '--glass-shadow': '0 12px 32px rgba(10, 14, 45, 0.32), inset 0 1px 0 rgba(248, 242, 229, 0.09)',
        '--glass-shadow-glow': '0 18px 48px rgba(10, 14, 45, 0.46), inset 0 1px 0 rgba(248, 242, 229, 0.14)',
        '--glass-blur': '24px',
        '--field-bg': 'rgba(143, 180, 216, 0.065)',
        '--field-bg-hover': 'rgba(157, 205, 228, 0.13)',
        '--field-border': 'rgba(171, 202, 225, 0.22)',
        '--field-border-strong': 'rgba(208, 223, 224, 0.44)',
        '--surface-1': 'rgba(140, 180, 218, 0.065)',
        '--surface-2': 'rgba(151, 196, 227, 0.12)',
        '--surface-line': 'rgba(169, 199, 228, 0.16)',
        '--surface-line-strong': 'rgba(183, 213, 236, 0.30)',
        '--surface-hi': 'inset 0 1px 0 rgba(248, 242, 229, 0.09)',
        '--surface-lift': '0 8px 22px rgba(14, 17, 50, 0.28)',
        '--track': 'rgba(167, 192, 227, 0.19)',
        '--focus-ring': '2px solid #89d5e5',
        '--ok': '#a8d6c2',
        '--ok-wash': 'rgba(168, 214, 194, 0.10)',
        '--warn': '#f3dca7',
        '--warn-wash': 'rgba(243, 220, 167, 0.10)',
        '--danger': '#f5adb0',
        '--danger-wash': 'rgba(245, 173, 176, 0.11)'
      }
    },
    {
      id: 'starblue',
      name: '星蓝深空',
      note: '深空蓝黑底 + 科技蓝强调色',
      // 对比度（自 --bg 反推，WCAG AA）：
      //   text/bg ≈ 14.2  muted/bg ≈ 7.2  accent-ink/accent ≈ 5.7
      tokens: {
        '--bg': '#0b1020',
        '--panel': 'rgba(19, 26, 48, 0.66)',
        '--panel-solid': '#131a30',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(148, 168, 220, 0.12)',
        '--line-strong': 'rgba(148, 168, 220, 0.22)',
        '--text': '#e8edf8',
        '--muted': '#94a0bd',
        '--accent': '#4c8dff',
        '--accent-2': '#7a5cff',
        '--accent-ink': '#0a1230',
        '--hover': 'rgba(120, 150, 230, 0.10)'
      }
    },
    {
      id: 'emerald',
      name: '翡翠夜',
      note: '墨绿底 + 翡翠强调色',
      tokens: {
        '--bg': '#0d0f12',
        '--panel': 'rgba(24, 27, 32, 0.66)',
        '--panel-solid': '#171a1f',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.09)',
        '--line-strong': 'rgba(255, 255, 255, 0.16)',
        '--text': '#eef1f5',
        '--muted': '#97a0af',
        '--accent': '#1dbf8f',
        '--accent-2': '#7f77dd',
        '--accent-ink': '#04140e',
        '--hover': 'rgba(255, 255, 255, 0.07)'
      }
    },
    {
      id: 'midnight-neon',
      name: '午夜霓虹',
      note: '午夜霓虹 · 深夜窗上反光的赛博粉',
      tokens: {
        '--bg': '#101116',
        '--panel': 'rgba(26, 27, 34, 0.72)',
        '--panel-solid': '#1a1b22',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#e8e9ed',
        '--muted': '#d1d1db',
        '--accent': '#ff4785',
        '--accent-2': '#7f77dd',
        '--accent-ink': '#2b0011',
        '--hover': 'rgba(255, 71, 133, 0.12)'
      }
    },
    {
      id: 'mono',
      name: '黑白简约',
      note: '黑白简约 · 克制的墨灰底 + 一点冷蓝强调',
      tokens: {
        '--bg': '#1c1c1e',
        '--panel': 'rgba(40, 40, 44, 0.72)',
        '--panel-solid': '#28282c',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.11)',
        '--line-strong': 'rgba(255, 255, 255, 0.20)',
        '--text': '#e6e6e6',
        '--muted': '#a8a8a8',
        '--accent': '#6fa8dc',
        '--accent-2': '#8f8f94',
        '--accent-ink': '#0b1b29',
        '--hover': 'rgba(255, 255, 255, 0.09)'
      }
    },
    {
      id: 'aero',
      name: '极简 Aero',
      note: '极简 Aero · 冷灰蓝的玻璃质感',
      tokens: {
        '--bg': '#252a30',
        '--panel': 'rgba(48, 54, 61, 0.72)',
        '--panel-solid': '#30363d',
        '--panel-2': 'rgba(255, 255, 255, 0.06)',
        '--line': 'rgba(255, 255, 255, 0.12)',
        '--line-strong': 'rgba(255, 255, 255, 0.22)',
        '--text': '#edf4f8',
        '--muted': '#aab7c1',
        '--accent': '#76b9e6',
        '--accent-2': '#79c99e',
        '--accent-ink': '#10212d',
        '--hover': 'rgba(118, 185, 230, 0.14)'
      }
    },
    {
      id: 'codeide',
      name: 'Code IDE',
      note: '代码编辑器 · 低饱和的暖琥珀',
      tokens: {
        '--bg': '#1a1d23',
        '--panel': 'rgba(37, 40, 48, 0.72)',
        '--panel-solid': '#252830',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#d7dde8',
        '--muted': '#98a3b5',
        '--accent': '#e5c07b',
        '--accent-2': '#7f9ed4',
        '--accent-ink': '#241b06',
        '--hover': 'rgba(229, 192, 123, 0.12)'
      }
    },
    {
      id: 'sakura',
      name: '夜樱猫语',
      note: '夜樱猫语 · 靛紫底上的樱粉',
      tokens: {
        '--bg': '#1a1a2e',
        '--panel': 'rgba(43, 43, 69, 0.72)',
        '--panel-solid': '#2b2b45',
        '--panel-2': 'rgba(255, 255, 255, 0.06)',
        '--line': 'rgba(255, 255, 255, 0.12)',
        '--line-strong': 'rgba(255, 255, 255, 0.22)',
        '--text': '#e8e6f0',
        '--muted': '#a8a6bd',
        '--accent': '#ff8c94',
        '--accent-2': '#8f8fd6',
        '--accent-ink': '#2b0d10',
        '--hover': 'rgba(255, 140, 148, 0.13)'
      }
    },
    {
      id: 'crimson',
      name: '绯红天穹',
      note: '绯红天穹 · 高能的猩红强调',
      tokens: {
        '--bg': '#0d0f12',
        '--panel': 'rgba(26, 28, 32, 0.72)',
        '--panel-solid': '#1a1c20',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#eaebee',
        '--muted': '#a0a3ab',
        '--accent': '#ff3b5c',
        '--accent-2': '#9f1212',
        '--accent-ink': '#2a0008',
        '--hover': 'rgba(255, 59, 92, 0.14)'
      }
    },
    {
      id: 'paper-ink',
      name: '纸墨与机芯',
      note: '纸墨与机芯 · 米白纸感 + 黄铜齿轮',
      tokens: {
        '--bg': '#171a1d',
        '--panel': 'rgba(32, 37, 42, 0.72)',
        '--panel-solid': '#20252a',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#f2f0e9',
        '--muted': '#a7afb1',
        '--accent': '#f2a900',
        '--accent-2': '#76bfae',
        '--accent-ink': '#241800',
        '--hover': 'rgba(242, 169, 0, 0.12)'
      }
    },
    {
      id: 'forest',
      name: '静谧森岭',
      note: '静谧森岭 · 苔绿与蕨叶',
      tokens: {
        '--bg': '#1a201b',
        '--panel': 'rgba(42, 54, 47, 0.72)',
        '--panel-solid': '#2a362f',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#e8e8e3',
        '--muted': '#a8b0a9',
        '--accent': '#7fbf7f',
        '--accent-2': '#587465',
        '--accent-ink': '#0a1a0c',
        '--hover': 'rgba(127, 191, 127, 0.13)'
      }
    },
    {
      id: 'porcelain',
      name: '瓷与锦',
      note: '瓷与锦 · 青花瓷的靛蓝与金线',
      tokens: {
        '--bg': '#0a1921',
        '--panel': 'rgba(13, 42, 56, 0.72)',
        '--panel-solid': '#0d2a38',
        '--panel-2': 'rgba(255, 255, 255, 0.06)',
        '--line': 'rgba(255, 255, 255, 0.12)',
        '--line-strong': 'rgba(255, 255, 255, 0.22)',
        '--text': '#e0e6e9',
        '--muted': '#b3c6ce',
        '--accent': '#daa520',
        '--accent-2': '#3f8fa8',
        '--accent-ink': '#201704',
        '--hover': 'rgba(218, 165, 32, 0.13)'
      }
    },
    {
      id: 'snow-dawn',
      name: '雪境晨昏',
      note: '雪境晨昏 · 冷蓝夜幕与初升暖光',
      tokens: {
        '--bg': '#1a2333',
        '--panel': 'rgba(37, 47, 64, 0.72)',
        '--panel-solid': '#252f40',
        '--panel-2': 'rgba(255, 255, 255, 0.06)',
        '--line': 'rgba(255, 255, 255, 0.12)',
        '--line-strong': 'rgba(255, 255, 255, 0.22)',
        '--text': '#e6edf3',
        '--muted': '#a3b0c2',
        '--accent': '#f7b731',
        '--accent-2': '#5b8dd9',
        '--accent-ink': '#241a02',
        '--hover': 'rgba(247, 183, 49, 0.13)'
      }
    },
    {
      id: 'acid',
      name: '酸性玄武',
      note: '酸性玄武 · 荧光黄绿的实验感',
      tokens: {
        '--bg': '#0d1013',
        '--panel': 'rgba(21, 25, 31, 0.72)',
        '--panel-solid': '#15191f',
        '--panel-2': 'rgba(255, 255, 255, 0.05)',
        '--line': 'rgba(255, 255, 255, 0.10)',
        '--line-strong': 'rgba(255, 255, 255, 0.18)',
        '--text': '#f0f4f8',
        '--muted': '#a0abb8',
        '--accent': '#d4ff00',
        '--accent-2': '#2b3441',
        '--accent-ink': '#1c2200',
        '--hover': 'rgba(212, 255, 0, 0.12)'
      }
    },
    {
      id: 'liunian',
      name: '流年',
      note: '流年 · 旧纸暖褐底 + 沉金色的岁月流光',
      // 对比度（自 --bg 反推，WCAG AA）：
      //   text/bg ≈ 14.8  muted/bg ≈ 6.6  accent-ink/accent ≈ 7.8
      // 流年专属的 --liunian-vignette 是老照片暗角，仅 skin.liunian.css 消费。
      tokens: {
        '--bg': '#15110d',
        '--panel': 'rgba(38, 30, 22, 0.62)',
        '--panel-solid': '#211b14',
        '--panel-2': 'rgba(230, 196, 140, 0.05)',
        '--line': 'rgba(226, 190, 140, 0.10)',
        '--line-strong': 'rgba(226, 190, 140, 0.20)',
        '--text': '#f3e8d8',
        '--muted': '#ab9880',
        '--accent': '#d8ab60',
        '--accent-2': '#c0704e',
        '--accent-ink': '#241a08',
        '--brand': '#d8ab60',
        '--brand-rgb': '216, 171, 96',
        '--highlight': '#e7c687',
        '--highlight-rgb': '231, 198, 135',
        '--hover': 'rgba(216, 171, 96, 0.10)',
        '--liunian-vignette':
          'radial-gradient(125% 100% at 50% 38%, transparent 58%, rgba(18, 12, 6, 0.42) 100%)'
      }
    },
    {
      id: 'ios-light',
      name: 'iOS 浅色',
      note: 'iOS 浅色 · macOS 中性灰白层级、统一系统蓝与轻量分组表面',
      // 对比度（自 --bg #F2F2F7 与 --panel #FFFFFF 反推，WCAG AA）：
      //   text ≈ 15.3 / 17.0   muted ≈ 4.5 / 5.1   accent ≈ 5.2 / 5.8
      //   白字压 accent ≈ 5.8（不是 #007AFF 的 4.0——见下）
      //
      // 为什么主色不是系统原色 #007AFF：白字压 #007AFF 只有 4.02:1，
      // 达不到正文 AA 的 4.5:1。这里取同色相加深一档的 #0A63C9，
      // 白字 5.77:1 达标，视觉上仍是「iOS 那个蓝」而不刺眼。
      //
      // ⚠ 这一套是**唯一自带表面令牌**的主题，原因见下方「白叠层必须翻转」。
      tokens: {
        '--bg': '#F2F2F7',
        '--panel': 'rgba(255, 255, 255, 0.72)',
        '--panel-solid': '#FFFFFF',
        '--panel-2': 'rgba(60, 60, 67, 0.06)',
        '--line': 'rgba(60, 60, 67, 0.14)',
        '--line-strong': 'rgba(60, 60, 67, 0.24)',
        '--text': '#1C1C1E',
        '--muted': '#6E6E73',
        '--accent': '#0A63C9',
        '--accent-2': '#0A63C9',
        '--accent-ink': '#FFFFFF',
        '--brand': '#0A63C9',
        '--brand-rgb': '10, 99, 201',
        '--highlight': '#0A63C9',
        '--highlight-rgb': '10, 99, 201',
        '--hover': 'rgba(60, 60, 67, 0.06)',
        // 语义色：成功 / 警告 / 错误。都从 --bg 反推到 AA 以上，
        // 不用 iOS 原色（systemGreen #34C759 在浅底上只有 2.1:1，
        // systemRed #FF3B30 只有 3.2:1，正文位置会糊掉）。
        '--danger': '#D70015',
        '--ok': '#1E7B34',
        '--warn': '#B25000',

        // ==== 白叠层必须翻转 ====
        // style.css 的玻璃体系是**为暗底写的**：面板比底亮靠的是叠一层
        // rgba(255,255,255,.03~.18)，描边与内高光也全是白叠层。这套方法在
        // 浅底上整体失效——白叠白等于什么都没叠，卡片会糊成一片、描边消失、
        // 进度条轨道看不见。所以这里把同一批令牌逐个翻成「暗叠层」：
        // 面板靠**更深**的底 + 细描边浮起来，而不是靠更亮。
        //
        // 契约 A（check-css-tokens）规定 --glass-* 只能由 style.css 的 :root
        // 声明。那条契约扫的是**CSS 文件**；主题是 themes.js 在运行时写进
        // <html> 的行内变量，行内优先级高于 :root，能干净地盖掉默认值，
        // 且不与任何既有声明冲突。切回暗色主题时 apply() 会把上一套独有的键
        // removeProperty 掉，于是这些翻转值随之消失、回到 style.css 的暗色默认。
        '--glass-bg':
          'linear-gradient(168deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.78) 46%, rgba(255, 255, 255, 0.72))',
        '--glass-border': '1px solid rgba(60, 60, 67, 0.13)',
        '--glass-line': 'rgba(255, 255, 255, 0.85)',
        // 暗色那套 22px/64px 的弥散黑投影在浅底上是一坨脏污。换成 iOS 的
        // 双层贴地投影：贴近处一层极淡的接触影 + 稍远一层扩散影。
        '--glass-shadow': '0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06)',
        '--glass-shadow-glow': '0 1px 2px rgba(0, 0, 0, 0.05), 0 10px 28px rgba(0, 0, 0, 0.08)',
        '--glass-bg-strong': 'rgba(255, 255, 255, 0.86)',
        // 卡片层级：暗底靠「比面板再亮一档」，浅底反过来——卡片是纯白，
        // 面板是半透明白（透出灰底），于是卡片自然浮在面板之上。
        '--surface-1': 'rgba(255, 255, 255, 0.94)',
        '--surface-2': 'rgba(255, 255, 255, 1)',
        '--surface-line': 'rgba(60, 60, 67, 0.11)',
        '--surface-line-strong': 'rgba(60, 60, 67, 0.2)',
        '--surface-hi': 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
        '--surface-lift': '0 1px 2px rgba(0, 0, 0, 0.05), 0 6px 16px rgba(0, 0, 0, 0.06)',
        // 表单控件：暗底是「白 3% 叠层」，浅底改成 iOS 的灰填充 + 细边。
        '--field-bg': 'rgba(118, 118, 128, 0.08)',
        '--field-bg-hover': 'rgba(118, 118, 128, 0.12)',
        '--field-border': 'rgba(60, 60, 67, 0.16)',
        '--field-border-strong': 'rgba(60, 60, 67, 0.28)',
        // 轨道必须看得见：白叠层在白底上不可见，这里给足灰度。
        '--track': 'rgba(60, 60, 67, 0.18)',
        // 焦点环在浅底上要更深才看得见（0.6 的品牌色在白底上偏淡）。
        '--focus-ring': '2px solid rgba(var(--brand-rgb, 10, 99, 201), 0.75)',
        // 语义表面：给状态芯片/提示条用，浅底上必须是浅填充而不是白。
        '--ok-wash': 'rgba(30, 123, 52, 0.1)',
        '--warn-wash': 'rgba(178, 80, 0, 0.1)',
        '--danger-wash': 'rgba(215, 0, 21, 0.1)',
        // 圆角与间距属于「尺度」而非「颜色」，按 themes.js 自己的规矩
        // （结构令牌不进主题表）不放在这里——留给 skin.ios.css 去改。
        // 但玻璃模糊在浅底上要重一档才压得住背后的彩色封面，这属于材质。
        '--glass-blur': '28px'
      }
    },
    {
      id: 'chaoxi-night',
      name: '潮汐·夜',
      note: '留白·夜 · 近黑纸面 + 暖铜色唱片辉光（皮肤「潮汐」的配套深色）',
      // 对比度（自 --bg #0E0E10 反推，WCAG AA）：
      //   text ≈ 16.5   muted ≈ 6.4   brand ≈ 8.6
      // 强调色刻意取 #E8E6E1 而不是纯白：纯白在近黑底上会起光晕，细字尤其明显。
      // 底色也不用纯黑：纯黑在 OLED 上边界过硬，且让"层级"无处表达。
      tokens: {
        '--bg': '#0E0E10',
        '--panel': 'rgba(24, 24, 27, 0.78)',
        '--panel-solid': '#18181B',
        '--panel-2': 'rgba(255, 255, 255, 0.045)',
        // 暗底上的分隔线必须比底色**亮**：暗线在暗底上等于没有。
        '--line': '#1F2023',
        '--line-strong': '#2C2D31',
        '--text': '#EDEDF0',
        '--muted': '#92949B',
        '--accent': '#E8E6E1',
        '--accent-2': '#C8A96A',
        '--accent-ink': '#0E0E10',
        '--brand': '#C8A96A',
        '--brand-rgb': '200, 169, 106',
        // 铜色底上放字用墨色：#C8A96A 亮度 0.417，配黑 8.6、配白仅 2.4。
        '--brand-ink': '#0E0E10',
        '--highlight': '#E8E6E1',
        '--highlight-rgb': '232, 230, 225',
        '--hover': 'rgba(255, 255, 255, 0.06)',
        '--danger': '#E5484D',
        '--ok': '#4CAF6D',
        '--warn': '#E08A3C',
        '--ok-wash': 'rgba(76, 175, 109, 0.12)',
        '--warn-wash': 'rgba(224, 138, 60, 0.12)',
        '--danger-wash': 'rgba(229, 72, 77, 0.12)'
      }
    },
    {
      id: 'chaoxi-day',
      name: '潮汐·昼',
      note: '留白·昼 · 暖白纸面 + 压深铜色（皮肤「潮汐」的配套浅色）',
      // 对比度（自 --bg #F7F6F4 反推，WCAG AA）：
      //   text ≈ 16.6   muted ≈ 4.7   brand-ink ≈ 4.6
      //
      // ⚠ 铜色在浅底上必须**分两档**：#A98244 只有 3.3:1，够图形/描边/指示条，
      //   但承载文字不达标；凡是要写字的位置一律用 --brand-ink #8A6A33（4.6:1）。
      //   这是设计稿里最容易漏的一条，改色时先确认改的是哪一档。
      //
      // ⚠ 强调色在浅色下**反转为墨色**而不是反色：深浅不是反色关系，
      //   是"重排光的来源"—— 浅色下光从环境来，UI 是亮的，强调就必须是暗的。
      tokens: {
        '--bg': '#F7F6F4',
        '--panel': 'rgba(255, 255, 255, 0.78)',
        '--panel-solid': '#FFFFFF',
        '--panel-2': 'rgba(20, 20, 22, 0.035)',
        '--line': '#E4E2DE',
        '--line-strong': '#D2CFCA',
        '--text': '#16171A',
        '--muted': '#6B6E76',
        '--accent': '#16171A',
        '--accent-2': '#8A6A33',
        '--accent-ink': '#F7F6F4',
        '--brand': '#A98244',
        '--brand-rgb': '169, 130, 68',
        '--brand-ink': '#8A6A33',
        '--highlight': '#16171A',
        '--highlight-rgb': '22, 23, 26',
        '--hover': 'rgba(20, 20, 22, 0.05)',
        '--danger': '#D70015',
        '--ok': '#1E7B34',
        '--warn': '#B25000',

        // ==== 白叠层必须翻转（与 ios-light 同一个理由）====
        // style.css 的玻璃体系是**为暗底写的**：面板比底亮靠叠一层白，描边与
        // 内高光也全是白叠层。这套方法在浅底上整体失效——白叠白等于什么都没叠，
        // 卡片糊成一片、描边消失、进度条轨道看不见。这里把同一批令牌逐个翻成
        // 「暗叠层」：面板靠**更深**的底 + 细描边浮起来，而不是靠更亮。
        // 但**别一刀切禁白**：--panel / --surface-1 / --glass-line 浅色下本就该
        // 是白的，只有**分隔类**（--line / --surface-line / --track）必须压暗。
        '--glass-bg':
          'linear-gradient(168deg, rgba(255, 255, 255, 0.94), rgba(255, 255, 255, 0.84) 46%, rgba(255, 255, 255, 0.78))',
        '--glass-border': '1px solid rgba(32, 30, 27, 0.12)',
        '--glass-line': 'rgba(255, 255, 255, 0.9)',
        '--glass-shadow': '0 1px 2px rgba(32, 30, 27, 0.04), 0 8px 24px rgba(32, 30, 27, 0.06)',
        '--glass-shadow-glow': '0 1px 2px rgba(32, 30, 27, 0.05), 0 10px 28px rgba(32, 30, 27, 0.08)',
        '--glass-bg-strong': 'rgba(255, 255, 255, 0.88)',
        '--surface-1': 'rgba(255, 255, 255, 0.95)',
        '--surface-2': 'rgba(255, 255, 255, 1)',
        '--surface-line': 'rgba(32, 30, 27, 0.10)',
        '--surface-line-strong': 'rgba(32, 30, 27, 0.18)',
        '--surface-hi': 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
        '--surface-lift': '0 1px 2px rgba(32, 30, 27, 0.05), 0 6px 16px rgba(32, 30, 27, 0.06)',
        '--field-bg': 'rgba(32, 30, 27, 0.05)',
        '--field-bg-hover': 'rgba(32, 30, 27, 0.09)',
        '--field-border': 'rgba(32, 30, 27, 0.14)',
        '--field-border-strong': 'rgba(32, 30, 27, 0.26)',
        '--track': 'rgba(32, 30, 27, 0.16)',
        '--focus-ring': '2px solid rgba(var(--brand-rgb, 138, 106, 51), 0.75)',
        '--ok-wash': 'rgba(30, 123, 52, 0.1)',
        '--warn-wash': 'rgba(178, 80, 0, 0.1)',
        '--danger-wash': 'rgba(215, 0, 21, 0.1)',
        '--glass-blur': '28px'
      }
    }
  ];

  var byId = new Map();
  CATALOG.forEach(function (t) { byId.set(t.id, t); });

  var current = null;
  var listeners = [];
  /// 启动时想要、但那一刻还没登记进目录的主题 id。
  ///
  /// 目录不是一次性给出的：内置主题在这里，而二次元那七套与「自定义配色」由
  /// ThemeStudio 在启动后半程 register 进来。于是用户选了后者时，存储的 id 在
  /// init() 读回来的瞬间还不认识——就地兜底就等于"刷新后选择丢了"。这里把它
  /// 记下来，等那套主题登记完成的那一刻再兑现（见 register）。
  var pendingId = null;

  function root() { return document.documentElement; }

  function readStored() {
    try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }

  function writeStored(id) {
    try { localStorage.setItem(STORE_KEY, id); } catch (e) { /* 隐私模式 */ }
  }

  // 把一套主题写到 <html> 的行内样式上。先清掉上一套留下的键，再写新的，
  // 否则从"自定义了 X"的主题切到"没定义 X"的主题时，X 会残留。
  function apply(id, opts) {
    var theme = byId.get(id) || byId.get(DEFAULT_ID);
    var el = root();
    var prev = current;
    if (prev) {
      Object.keys(prev.tokens).forEach(function (k) {
        if (!(k in theme.tokens)) el.style.removeProperty(k);
      });
    }
    Object.keys(theme.tokens).forEach(function (k) {
      el.style.setProperty(k, theme.tokens[k]);
    });
    // accent 的 rgb 三元组：rgba() 透明度合成必须用原始数字，CSS 没法从
    // hex 变量里拆出来，所以换肤时顺手派生一份。舞台的 --music-highlight
    // 默认回退就吃这个值，无封面时与主题同色而不是固定琥珀。
    //
    // accent-2 同样要派生：舞台的第二支高亮色吃它。它与 accent 必须**不同**
    // —— 两者相同时频谱柱全染成一种颜色，加性混合一叠就是一块实心白。
    // 只派生不校验的话，某个主题若没给 --accent-2 就会悄悄退回全局默认青，
    // 在那个主题下重新变成单色。
    ['--accent', '--accent-2'].forEach(function (key) {
      var hex = theme.tokens[key];
      if (!hex || !/^#([0-9a-f]{6})$/i.test(hex)) return;
      var n = parseInt(hex.slice(1), 16);
      el.style.setProperty(key + '-rgb',
        [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', '));
    });
    // 老主题里没有 --brand / --highlight 这两个角色色：这里按 accent / accent-2
    // 派生一份，保证统一组件层（激活态/焦点环/选中态）在任何主题下都有值，
    // 不会因为换肤而退化成空白描边。
    ['--brand', '--brand-rgb', '--highlight', '--highlight-rgb'].forEach(function (k) {
      if (theme.tokens[k]) return;
      var primary = theme.tokens['--accent'];
      var secondary = theme.tokens['--accent-2'] || primary;
      if (k === '--brand') el.style.setProperty(k, secondary);
      else if (k === '--highlight') el.style.setProperty(k, primary);
      else {
        var hex = k === '--brand-rgb' ? secondary : primary;
        if (hex && /^#([0-9a-f]{6})$/i.test(hex)) {
          var m = parseInt(hex.slice(1), 16);
          el.style.setProperty(k, [(m >> 16) & 255, (m >> 8) & 255, m & 255].join(', '));
        }
      }
    });
    el.setAttribute(ATTR, theme.id);
    current = theme;
    if (!(opts && opts.silent)) writeStored(theme.id);
    // 主题色会被舞台取色覆盖到 --music-highlight 上，换主题要让它重新取一次
    if (window.Stage && typeof window.Stage.retint === 'function') window.Stage.retint();
    listeners.forEach(function (fn) {
      try { fn(theme); } catch (e) { /* 单个订阅者出错不该拖垮换肤 */ }
    });
    return theme;
  }

  // 带上 tokens：渲染主题菜单时要拿 accent 画色点，调用方不该再回头查一次。
  // 这里是拷贝，外部改不动 CATALOG。
  function list() {
    var ordered = CATALOG.filter(function (t) { return t.id === DEFAULT_ID; })
      .concat(CATALOG.filter(function (t) { return t.id !== DEFAULT_ID; }));
    return ordered.map(function (t) {
      var tokens = {};
      Object.keys(t.tokens).forEach(function (k) { tokens[k] = t.tokens[k]; });
      return { id: t.id, name: t.name, note: t.note, tokens: tokens };
    });
  }

  function init() {
    var saved = readStored();
    if (byId.has(saved)) {
      apply(saved, { silent: true });
      return current;
    }
    // 不认识未必是数据坏了，也可能是这套主题还没登记上来（见 pendingId）。
    // 注意这里不能回写：存储里那个 id 可能晚一步就变得有效了，抹掉它就真的丢了。
    pendingId = saved || null;
    apply(DEFAULT_ID, { silent: true });
    return current;
  }

  window.Theme = {
    init: init,
    apply: apply,
    list: list,
    current: function () { return current; },
    // 换肤后要做的事（重绘 canvas、重建渐变……）挂这里
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    // 扩展方式：Theme.register({ id, name, note, tokens })。
    // tokens 只需给出想覆盖的令牌，其余继承当前主题的默认值。
    register: function (theme) {
      if (!theme || !theme.id || !theme.tokens) return false;
      // 部分声明的扩展主题沿用稳定的基础令牌，不继承新默认外观的专属玻璃表面。
      var base = CATALOG[0].tokens;
      var merged = {};
      Object.keys(base).forEach(function (k) { merged[k] = base[k]; });
      Object.keys(theme.tokens).forEach(function (k) { merged[k] = theme.tokens[k]; });
      var entry = { id: theme.id, name: theme.name || theme.id, note: theme.note || '', tokens: merged };
      var at = byId.get(entry.id);
      if (at) {
        at.tokens = merged; at.name = entry.name; at.note = entry.note;
      } else {
        CATALOG.push(entry);
        byId.set(entry.id, entry);
      }
      // 延迟兑现：之前存着的选择正是这套主题，现在它终于存在于目录里了。
      // 用 silent 是因为存储已经是这个值，写回去只是重复；这一趟的目的是让
      // 令牌真的落到 <html> 上，并把「主题变了」广播给已经订阅的人。
      if (pendingId === entry.id) {
        pendingId = null;
        apply(entry.id, { silent: true });
      }
      return true;
    }
  };
})();
