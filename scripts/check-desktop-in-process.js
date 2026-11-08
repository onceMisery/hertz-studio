#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 桌面歌词进程模型契约：播放器在本进程内直接调用 hertz_desktop 库开窗，
// 不再启动 hertz-desktop.exe、不再经管理命名管道转发命令；启动/托盘/退出
// 全部由 desktop_host 这个唯一 owner 收口。歌词与设置页面资产必须原样复用。
//
//   node scripts/check-desktop-in-process.js
//
// 负面断言只看代码、不看注释：注释里记录旧链路的来由是允许的。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STUDIO = path.join(ROOT, 'crates/hertz-studio/src');
const DESKTOP = path.join(ROOT, 'crates/hertz-desktop');
const ASSETS = path.join(DESKTOP, 'assets');

let passed = 0;
function pass(name) {
  passed += 1;
  console.log('  ok  ' + name);
}
function read(file) {
  return fs.readFileSync(file, 'utf8');
}
function rustFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? rustFiles(file) : entry.name.endsWith('.rs') ? [file] : [];
  });
}
function codeOnly(source) {
  // 只剥行注释；双引号字符串里的 `//`（例如 URL）必须保留。
  let out = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      out += char;
      if (char === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += char;
  }
  return out;
}
function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, '缺少函数起点 ' + from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, '缺少函数终点 ' + to);
  return source.slice(start, end);
}

const standalone = read(path.join(STUDIO, 'desktop/standalone.rs'));
const control = read(path.join(STUDIO, 'desktop_control.rs'));
const tray = read(path.join(STUDIO, 'desktop_tray.rs'));
const host = read(path.join(STUDIO, 'desktop_host.rs'));
const window = read(path.join(STUDIO, 'window.rs'));
const main = read(path.join(STUDIO, 'main.rs'));
const lib = read(path.join(STUDIO, 'lib.rs'));
const studioCargo = read(path.join(ROOT, 'crates/hertz-studio/Cargo.toml'));
const desktopCargo = read(path.join(DESKTOP, 'Cargo.toml'));
const desktopLib = read(path.join(DESKTOP, 'src/lib.rs'));
const desktopMain = read(path.join(DESKTOP, 'src/main.rs'));
const app = read(path.join(DESKTOP, 'src/app.rs'));
const native = read(path.join(DESKTOP, 'src/native.rs'));
const nativeEvents = read(path.join(DESKTOP, 'src/native_events.rs'));
const decodeProbe = read(path.join(DESKTOP, 'src/wallpaper/decode_probe.rs'));

// —— 1. 播放器侧不再有进程启动与管道转发 ——
// `main.rs` 里 `cmd /C start` 是打开浏览器的入口，与桌面组件无关；
// 因此只取优雅停机那一段参与负面断言。
const shutdownBlock = slice(main, '.with_graceful_shutdown(', '.await?;');
const playerSources = [standalone, control, tray, host, window, shutdownBlock]
  .map(codeOnly)
  .join('\n');
for (const forbidden of [
  'Command::new',
  'process::Command',
  'spawn_host',
  'host_path',
  'SpawnError',
  'management::request',
  'management::pipe_name',
  'hertz-desktop.exe',
]) {
  assert.ok(!playerSources.includes(forbidden), '播放器里仍残留 ' + forbidden);
}
pass('播放器侧的启动/控制/托盘/退出代码没有外部 exe 与管理管道');

assert.ok(codeOnly(standalone).includes('desktop_host::ensure_started'), 'launch 未直接调用进程内宿主');
assert.ok(codeOnly(standalone).includes('desktop_control::send'), 'launch 未直接完成用户动作');
assert.ok(!codeOnly(slice(standalone, 'pub(crate) async fn launch', '\n}\n')).includes('sleep'), 'launch 仍在用启动后等待重试');
pass('打开设置：ensure_started 后直接开窗，无 spawn + sleep + 补发命令');

assert.ok(codeOnly(control).includes('desktop_host::command'), '控制面未落到进程内宿主');
assert.ok(codeOnly(tray).includes('desktop_host::is_running'), '托盘探测未读进程内宿主状态');
assert.ok(codeOnly(tray).includes('desktop_host::ensure_started'), '托盘启动未落到进程内宿主');
assert.ok(codeOnly(tray).includes('desktop_host::shutdown'), '托盘退出未收口到进程内宿主');
assert.ok(!codeOnly(tray).includes('HostState::Missing'), '托盘仍保留「组件 exe 缺失」这一已退役状态');
assert.ok(codeOnly(window).includes('desktop_host::menu_event(id)'), '托盘合并后宿主自建菜单没有转发回宿主');
assert.ok(codeOnly(host).includes('pub fn menu_event('), 'owner 缺少菜单转发入口');
assert.ok(codeOnly(app).includes('HostAction::Menu'), '宿主未处理播放器代收的菜单点击');
pass('控制面与托盘全部指向同一个进程内 owner');

// —— 2. 唯一 owner 与依赖接线 ——
assert.ok(lib.includes('pub mod desktop_host;'), 'lib.rs 未导出 desktop_host');
assert.ok(studioCargo.includes('hertz-desktop = { path = "../hertz-desktop" }'), '播放器未依赖桌面宿主库');
assert.ok(codeOnly(host).includes('start_embedded'), 'owner 未调用库入口');
assert.ok(codeOnly(host).includes('pub fn shutdown()'), 'owner 缺少退出收口');
assert.ok(codeOnly(host).includes('autostart_command'), '开机启动项未指向播放器');
assert.ok(codeOnly(host).includes('PLAYER_TRAY'), 'owner 未接收托盘所有权声明');
pass('desktop_host 是启动/命令/退出的唯一 owner，依赖与导出齐备');

assert.ok(desktopCargo.includes('[lib]'), 'hertz-desktop 未提供库目标');
assert.ok(desktopCargo.includes('[[bin]]'), '独立 exe 入口仍保留（原生回归脚本需要）');
assert.ok(desktopLib.includes('pub use host::{start_embedded, HostHandle, HostOptions};'), '库未暴露内嵌宿主 API');
assert.ok(desktopLib.includes('pub fn run()'), '库未提供独立 exe 入口');
assert.ok(!codeOnly(desktopMain).includes('mod app;'), '独立 exe 仍在重复编译一份业务模块');
assert.ok(codeOnly(desktopMain).includes('hertz_desktop::run()'), '独立 exe 未复用同一个库');
pass('窗口实现只有一份：库 + 独立 exe 薄壳');

// —— 3. 同一进程内开窗与生命周期 ——
assert.ok(codeOnly(app).includes('with_any_thread(true)'), '内嵌事件循环未放行非主线程');
assert.ok(codeOnly(app).includes('run_return(event_loop_handler!())'), '内嵌仍用会结束整个进程的 run()');
assert.ok(codeOnly(app).includes('UserEvent::Host'), '缺少进程内命令事件');
assert.ok(codeOnly(app).includes('ApiReply::Host'), '缺少进程内命令应答');
assert.ok(codeOnly(app).includes('pub(crate) struct RunConfig'), '缺少两种形态共用的运行参数');
assert.ok(codeOnly(app).includes('pub(crate) fn run_with('), '缺少共用的启动路径');
assert.ok(codeOnly(app).includes('if host_tray'), '内嵌形态未把托盘所有权交回播放器');
assert.ok(codeOnly(app).includes('if !embedded'), '内嵌形态未跳过管理管道与单实例互斥');
assert.ok(codeOnly(native).includes('ensure_window_class'), '进程内宿主重启会重复注册窗口类');
assert.ok(codeOnly(native).includes('clear_message_sink'), '宿主退出后消息窗口接收方未清空');
assert.ok(codeOnly(native).includes('AUTOSTART_COMMAND'), '开机启动未指向播放器命令');
pass('同进程事件循环、命令分派、重启资源与开机启动均已接线');

// Tao 的 Win32 类回调依赖泛型事件类型；进程内所有原生循环必须都是 ()，
// 否则第二个循环会复用第一个循环的回调，把 typed payload 读成另一种布局。
assert.match(codeOnly(app), /EventLoopBuilder::<\(\)>::new\(\)/, '桌面宿主没有使用原生 unit 循环');
const windowsLoop = codeOnly(window).match(/#\[cfg\(windows\)\]\s*let event_loop\s*=([\s\S]*?)#\[cfg\(windows\)\]\s*let \(proxy, events\)/)?.[1];
assert.ok(windowsLoop, 'Windows 主窗口循环初始化未找到');
assert.match(windowsLoop, /EventLoopBuilder::<\(\)>::new\(\)/,
  'Windows 主窗口没有使用与桌面宿主相同的原生 unit 循环');
assert.doesNotMatch(windowsLoop, /EventLoopBuilder::<UserEvent>/, 'Windows 类回调不能携带业务事件类型');
assert.match(codeOnly(window), /#\[cfg\(not\(windows\)\)\]\s*let event_loop = EventLoopBuilder::<UserEvent>/,
  '原生 typed Tao 循环只能留在非 Windows 分支');
for (const [label, source] of [['桌面宿主', app], ['主窗口', window]]) {
  assert.ok(codeOnly(source).includes('native_events::channel(event_loop.create_proxy())'), label + '没有类型化事件队列');
  assert.ok(codeOnly(source).includes('events.map_event(event)'), label + '没有把 unit 唤醒映射回业务事件');
}
assert.match(codeOnly(desktopLib), /#\[cfg\(windows\)\]\s*pub mod native_events;/,
  '共享原生事件适配层没有按 Windows 依赖边界导出');
assert.match(codeOnly(nativeEvents), /wakeup:\s*WakeupProxy<\(\)>/, '原生代理仍携带业务事件');
assert.match(codeOnly(nativeEvents), /sender:\s*mpsc::Sender<T>/, '业务事件没有保留在类型化队列');
for (const file of rustFiles(path.join(DESKTOP, 'src'))) {
  const source = codeOnly(read(file));
  const label = path.relative(ROOT, file);
  for (const target of source.matchAll(/\bEventLoopWindowTarget\s*<\s*([^>]+)>/g)) {
    assert.equal(target[1].trim(), '()', label + '的子窗口目标仍带有业务事件类型');
  }
  for (const builder of source.matchAll(/\bEventLoopBuilder\s*::<\s*([^>]+)>/g)) {
    assert.equal(builder[1].trim(), '()', label + '仍创建不同类型的原生循环');
  }
  if (path.basename(file) !== 'native_events.rs') {
    assert.doesNotMatch(source, /use\s+tao::event_loop::(?:\{[^}]*\bEventLoopProxy\b[^}]*\}|EventLoopProxy)/,
      label + '绕过了类型化事件队列，直接导入 Tao 代理');
  }
}
pass('Windows 所有 Tao 循环与子窗口使用 unit 类型，业务事件走各自的类型化队列');

// Embedded desktop startup must not redirect the player's main/OBS profiles.
// Every native desktop surface keeps its explicit desktop context alive.
for (const file of rustFiles(path.join(DESKTOP, 'src'))) {
  const source = codeOnly(read(file));
  const label = path.relative(ROOT, file);
  assert.doesNotMatch(source, /(?:set_var|remove_var)\s*\(\s*"WEBVIEW2_USER_DATA_FOLDER"/,
    label + '修改了进程全局 WebView2 profile，可能覆写播放器/OBS context');
  assert.doesNotMatch(source, /WebViewBuilder::new\s*\(/,
    label + '仍使用没有明确 profile owner 的 WebView builder');
}
for (const [label, constructor] of [
  ['歌词', slice(app, 'pub(crate) fn run_with(', '\nfn ')],
  ['壁纸/预览', slice(app, 'fn create_presentation(', '\nfn create_settings(')],
  ['设置', slice(app, 'fn create_settings(', '\nfn scene_thumbnail(')],
  ['小窗', slice(app, 'fn create_mini(', '\nfn mini_protocol_response(')],
]) {
  const source = codeOnly(constructor);
  assert.match(source, /WebContext::new\(Some\(config::webview_dir\(\)\)\)/,
    label + '没有使用明确的 desktop profile 根');
  assert.match(source, /WebViewBuilder::new_with_web_context\(&mut web_context\)/,
    label + '没有把明确 context 交给 WebView builder');
  assert.match(source, /_web_context:\s*web_context/, label + '没有把 context 保留到 surface 生命周期');
}
for (const surface of ['App', 'WallpaperSurface', 'SettingsSurface', 'MiniSurface']) {
  assert.match(codeOnly(app), new RegExp('struct ' + surface + '\\s*\\{[^}]*_web_context:\\s*WebContext'),
    surface + '未持有 WebView context');
}
assert.match(codeOnly(app), /drop\(webview\);\s*drop\(web_context\);\s*drop\(window\);/,
  '壁纸退休解构提前丢弃 context，未保留到 controller 销毁');
assert.match(codeOnly(decodeProbe), /WebContext::new\(Some\(crate::config::webview_dir\(\)\)\)/,
  '解码 probe 未使用明确 desktop profile 根');
assert.match(codeOnly(decodeProbe), /WebViewBuilder::new_with_web_context\(&mut web_context\)/,
  '解码 probe builder 未绑定明确 context');
assert.match(codeOnly(decodeProbe), /struct Surface\s*\{[^}]*_web_context:\s*WebContext/,
  '解码 probe surface 未持有 context');
pass('桌面所有 WebView 明确使用自身 profile 并保留 context，不修改播放器/OBS 的全局 profile');

assert.ok(codeOnly(window).includes('set_player_tray(true)'), '主窗口未声明托盘所有权');
assert.ok(codeOnly(window).includes('lifecycle.request_exit(QuitSource::Tray)'), '窗口托盘退出未通过统一确认所有者');
assert.ok(!codeOnly(window).includes('desktop_host::shutdown()'), '窗口确认前不应单独关闭桌面宿主');
assert.ok(codeOnly(read(path.join(STUDIO, 'window_lifecycle.rs'))).includes('state.request_exit()'), '确认完成未进入统一服务退出通道');
assert.ok(codeOnly(main).includes('desktop_host::shutdown()'), '服务优雅停机未收口桌面宿主');
pass('启动、托盘与退出流程统一由播放器管理');

// —— 3b. 托盘图标左键恢复主窗口 ——
// 菜单点击走 MenuEvent、图标点击走 TrayIconEvent，是两条独立全局通道。
// 只接前者时单击图标毫无反应，用户只能右键再点「打开主窗口」。切片到线程体
// 与恢复分支各自做断言，别在整份文件里就近匹配（那里到处都是 set_visible）。
const trayClick = slice(window, 'let proxy_for_tray_click = proxy.clone();', 'let proxy_for_probe = proxy.clone();');
assert.match(trayClick, /TrayIconEvent::receiver\(\)/, '托盘图标点击没有接全局事件通道');
assert.match(trayClick, /MouseButton::Left/, '左键点击没有接线');
assert.match(trayClick, /MouseButtonState::Up/, '没有把按下与抬起区分开');
assert.match(trayClick, /send_event\(UserEvent::FocusWindow\)/, '托盘点击没有发恢复主窗口事件');
assert.ok(codeOnly(window).includes('with_menu_on_left_click(false)'), '左键被菜单占用，单击就不能恢复窗口');
const focusBlock = slice(window, 'UserEvent::FocusWindow | UserEvent::OpenLyricsSettings',
  'Event::UserEvent(UserEvent::DesktopHostState(state))');
assert.match(focusBlock, /prepare_main_recovery\(&window,\s*&lifecycle\)/,
  '恢复事件没有通过原生 placement owner 准备主窗口');
const prepareRecovery = slice(window, 'fn prepare_main_recovery(', '\n}\n');
assert.match(prepareRecovery, /set_minimized\(false\)/, '恢复 helper 没有解除最小化');
assert.match(focusBlock, /set_visible\(true\)/, '隐藏到托盘后没有被重新显示');
assert.match(focusBlock, /set_focus\(\)/, '恢复后没有把窗口带到前台');
pass('托盘图标左键单击恢复主窗口，右键菜单保持独立');

// —— 4. 歌词样式与设置功能原样复用 ——
for (const asset of [
  'desktop-lyrics.css', 'desktop-lyrics.html', 'desktop-lyrics.js',
  'wallpaper-settings.html', 'wallpaper-settings.js', 'wallpaper-library.js',
]) {
  assert.ok(fs.existsSync(path.join(ASSETS, asset)), '页面资产缺失：' + asset);
}
const page = slice(app, 'fn page_html()', '\nfn ');
const settings = slice(app, 'fn settings_html()', '\nfn ');
for (const asset of ['desktop-lyrics.css', 'desktop-lyrics.html', 'desktop-lyrics.js']) {
  assert.ok(page.includes(asset), '歌词窗口未内嵌 ' + asset);
}
for (const asset of ['wallpaper-settings.html', 'wallpaper-settings.js', 'wallpaper-library.js']) {
  assert.ok(settings.includes(asset), '设置窗口未内嵌 ' + asset);
}
assert.ok(codeOnly(app).includes('fn handle_pipe_request'), '命令业务分派被改写');
assert.ok(codeOnly(app).includes('app.handle_pipe_request(&body, target)'), '进程内命令未复用同一分派');
pass('歌词样式/设置页资产与业务分派逐字复用，功能未改');

console.log(`check-desktop-in-process: ${passed} groups passed`);
