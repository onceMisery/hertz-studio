// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 小窗专用的 Win32 细节：区域命中、整体穿透、置顶与拖拽。
//!
//! 为什么不直接用 `native` 里那套：`native::set_locked` / `install_hit_test_subclass`
//! 靠的是模块级静态量（`CLICK_THROUGH`、`ORIGINAL_WNDPROC`）。桌面歌词只有一扇窗，
//! 全局量够用；小窗是第二扇，两扇窗会互相改写对方的穿透标记和原始窗口过程。
//! 所以这里按 HWND 建注册表，一扇窗一份状态。后续如果要给歌词也拆开，照这张表改。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, EnumChildWindows, GetCursorPos, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, SetWindowLongPtrW, SetWindowPos, GWLP_WNDPROC,
    GWL_EXSTYLE, HTCLIENT, HWND_TOPMOST, HWND_NOTOPMOST, SWP_NOACTIVATE, SWP_NOZORDER,
    WM_NCHITTEST, WNDPROC, WS_EX_LAYERED, WS_EX_TRANSPARENT,
};

/// 一扇窗的命中状态。坐标一律是物理像素，换算在 Rust 侧做完，wndproc 里只比大小。
struct Chrome {
    /// 这扇窗（或其子窗）归属的根窗口。子窗的 WM_NCHITTEST 也要问根窗的区域表。
    root: HWND,
    original: isize,
}

struct WindowState {
    /// 页面上报的实心区域（物理像素，相对窗口左上）。
    regions: Vec<RECT>,
    /// 宠物态：区域之外的地方点不到。
    pet: bool,
    /// 整体穿透：整扇窗都不吃鼠标。
    locked: bool,
    /// 命中区还没上报时先整块可点，避免首帧点不动。
    regions_ready: bool,
}

static CHROME: OnceLock<Mutex<HashMap<isize, Chrome>>> = OnceLock::new();
static STATE: OnceLock<Mutex<HashMap<isize, WindowState>>> = OnceLock::new();
static DRAGGING: AtomicBool = AtomicBool::new(false);

const DRAG_POLL: Duration = Duration::from_millis(16);
/// 拖拽兜底超时：光标事件丢了（远程桌面、UAC 弹窗抢焦点）也要能自己收尾。
const DRAG_TIMEOUT: Duration = Duration::from_secs(20);

fn chrome_map() -> &'static Mutex<HashMap<isize, Chrome>> {
    CHROME.get_or_init(|| Mutex::new(HashMap::new()))
}

fn state_map() -> &'static Mutex<HashMap<isize, WindowState>> {
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn default_state() -> WindowState {
    WindowState {
        regions: Vec::new(),
        pet: false,
        locked: false,
        regions_ready: false,
    }
}

/// 给根窗口装上命中处理，并把同进程的子窗口（WebView2 那层）一起挂上。
///
/// WebView2 的子窗才是真正先收到 WM_NCHITTEST 的那层：不挂它，返回 HTTRANSPARENT
/// 的机会根本轮不到我们，穿透会静默失效。子窗是 webview 建好之后才有的，所以
/// 建窗完成后要再调一次 `install`。
pub(crate) fn install(hwnd: HWND) {
    let mut children = Vec::new();
    unsafe extern "system" fn collect(child: HWND, lparam: LPARAM) -> i32 {
        let output = &mut *(lparam as *mut Vec<HWND>);
        output.push(child);
        1
    }
    let mut self_pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut self_pid);
        EnumChildWindows(
            hwnd,
            Some(collect),
            &mut children as *mut Vec<HWND> as LPARAM,
        );
    }
    let mut map = chrome_map().lock().unwrap_or_else(|error| error.into_inner());
    for target in std::iter::once(hwnd).chain(
        children
            .into_iter()
            .filter(|child| same_process(*child, self_pid)),
    ) {
        if map.contains_key(&(target as isize)) {
            continue;
        }
        let original = unsafe { GetWindowLongPtrW(target, GWLP_WNDPROC) };
        map.insert(
            target as isize,
            Chrome {
                root: hwnd,
                original,
            },
        );
        unsafe {
            SetWindowLongPtrW(target, GWLP_WNDPROC, mini_wndproc as *const () as isize);
        }
    }
    state_map()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(hwnd as isize)
        .or_insert_with(default_state);
}

fn same_process(hwnd: HWND, pid: u32) -> bool {
    let mut other = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut other) };
    other == pid && pid != 0
}

unsafe extern "system" fn mini_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        let map = chrome_map().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(chrome) = map.get(&(hwnd as isize)) {
            let root = chrome.root;
            let original = chrome.original;
            drop(map);
            // 屏幕坐标是 lparam 的低 16 / 高 16 位（有符号）。
            let x = (lparam & 0xFFFF) as i16 as i32;
            let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;
            if let Some(pass) = should_pass_through(root, x, y) {
                if pass {
                    return windows_sys::Win32::UI::WindowsAndMessaging::HTTRANSPARENT as isize;
                }
                return HTCLIENT as isize;
            }
            if original == 0 {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let procedure: WNDPROC = std::mem::transmute(original);
            return CallWindowProcW(procedure, hwnd, msg, wparam, lparam);
        }
    }
    let original = {
        let map = chrome_map().lock().unwrap_or_else(|e| e.into_inner());
        map.get(&(hwnd as isize)).map(|chrome| chrome.original)
    };
    match original {
        Some(0) | None => DefWindowProcW(hwnd, msg, wparam, lparam),
        Some(original) => {
            let procedure: WNDPROC = std::mem::transmute(original);
            CallWindowProcW(procedure, hwnd, msg, wparam, lparam)
        }
    }
}

/// 返回 None 表示这扇窗没登记（不该发生）→ 交回原窗口过程。
fn should_pass_through(root: HWND, x: i32, y: i32) -> Option<bool> {
    let states = state_map().lock().unwrap_or_else(|e| e.into_inner());
    let state = states.get(&(root as isize))?;
    if state.locked {
        return Some(true);
    }
    if !state.pet || !state.regions_ready {
        return Some(false);
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(root, &mut rect) } == 0 {
        return Some(false);
    }
    let local_x = x - rect.left;
    let local_y = y - rect.top;
    let inside = state.regions.iter().any(|region| {
        local_x >= region.left
            && local_x < region.right
            && local_y >= region.top
            && local_y < region.bottom
    });
    Some(!inside)
}

/// 页面上报命中区（逻辑像素 + 窗口 DPI）。内容或尺寸变了就重报一次，
/// 平时不动——这是 WM_NCHITTEST 里唯一的热点路径，必须只是几次整数比较。
pub(crate) fn set_hit_regions(hwnd: HWND, regions: &[(f64, f64, f64, f64)], dpi: u32) {
    let scale = f64::from(dpi.max(1)) / 96.0;
    let physical: Vec<RECT> = regions
        .iter()
        .map(|(x, y, w, h)| RECT {
            left: (x * scale).round() as i32,
            top: (y * scale).round() as i32,
            right: ((x + w) * scale).round() as i32,
            bottom: ((y + h) * scale).round() as i32,
        })
        .collect();
    let mut states = state_map().lock().unwrap_or_else(|e| e.into_inner());
    let state = states.entry(hwnd as isize).or_insert_with(default_state);
    state.regions = physical;
    state.regions_ready = !regions.is_empty();
}

/// 宠物态：透明区域不吃鼠标。与 `locked` 互斥——整窗穿透时区域判定没意义。
pub(crate) fn set_pet_mode(hwnd: HWND, on: bool) {
    let mut states = state_map().lock().unwrap_or_else(|e| e.into_inner());
    let state = states.entry(hwnd as isize).or_insert_with(default_state);
    state.pet = on;
}

/// 整体穿透。走 WS_EX_TRANSPARENT：Windows 会在合成阶段就把这扇窗排除掉，
/// 比在 wndproc 里逐个返回 HTTRANSPARENT 更彻底（后者对某些合成层不生效）。
pub(crate) fn set_locked(hwnd: HWND, locked: bool) {
    let old = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    let next = if locked {
        old | WS_EX_TRANSPARENT | WS_EX_LAYERED
    } else {
        old & !(WS_EX_TRANSPARENT | WS_EX_LAYERED)
    };
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
        set_children_transparent(hwnd, locked);
    }
    let mut states = state_map().lock().unwrap_or_else(|e| e.into_inner());
    let state = states.entry(hwnd as isize).or_insert_with(default_state);
    state.locked = locked;
}

fn set_children_transparent(hwnd: HWND, locked: bool) {
    unsafe extern "system" fn collect(child: HWND, lparam: LPARAM) -> i32 {
        let output = &mut *(lparam as *mut Vec<HWND>);
        output.push(child);
        1
    }
    let mut children = Vec::new();
    let mut self_pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut self_pid);
        EnumChildWindows(
            hwnd,
            Some(collect),
            &mut children as *mut Vec<HWND> as LPARAM,
        );
    }
    for child in children.into_iter().filter(|c| same_process(*c, self_pid)) {
        let old = unsafe { GetWindowLongPtrW(child, GWL_EXSTYLE) } as u32;
        let next = if locked {
            old | WS_EX_TRANSPARENT
        } else {
            old & !WS_EX_TRANSPARENT
        };
        unsafe { SetWindowLongPtrW(child, GWL_EXSTYLE, next as isize) };
    }
}

pub(crate) fn set_topmost(hwnd: HWND, on: bool) {
    unsafe {
        SetWindowPos(
            hwnd,
            if on { HWND_TOPMOST } else { HWND_NOTOPMOST },
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

pub(crate) fn move_window(hwnd: HWND, x: i32, y: i32, width: i32, height: i32) {
    unsafe {
        SetWindowPos(hwnd, std::ptr::null_mut(), x, y, width, height, SWP_NOACTIVATE | SWP_NOZORDER);
    }
}

/// 光标是否落在窗口矩形内。贴边隐藏后靠它判断该不该弹回来——
/// 那时整窗可能已经是穿透的，收不到 WM_MOUSEMOVE，只能轮询。
pub(crate) fn cursor_in_window(hwnd: HWND) -> bool {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return false;
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return false;
    }
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
}

/// 拖拽事件的出口。由 app 侧包一层转成 tao 的 UserEvent，mini_native 不认事件循环。
#[derive(Clone, Copy, Debug)]
pub(crate) enum DragEvent {
    /// 光标移动到了新的屏幕位置（物理像素）。
    Move(i32, i32),
    /// 松手或超时，拖拽结束。
    End,
}

/// 起一次拖拽：独立线程轮询光标，直到左键松开或超时。
///
/// 为什么不走 HTCAPTION 让系统拖：开启宠物态后窗口本身是穿透的，WM_NCHITTEST
/// 返回的是 HTTRANSPARENT，系统压根不会发起拖动；而我们需要在穿透和非穿透两种
/// 形态下拖拽手感一致（DBX 的 floating.beginDrag 也是宿主自己轮询光标的同一套）。
/// hwnd 只是给调用方一个「拖的是哪扇窗」的落点：真正移动窗口由收到
/// `DragEvent::Move` 的那一侧去 SetWindowPos，这里只负责喂光标位置。
pub(crate) fn begin_drag(_hwnd: HWND, sink: impl Fn(DragEvent) + Send + 'static) {
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("hertz-mini-drag".into())
        .spawn(move || {
            let deadline = Instant::now() + DRAG_TIMEOUT;
            let mut last = None;
            loop {
                let mut point = POINT::default();
                if unsafe { GetCursorPos(&mut point) } != 0 && last != Some((point.x, point.y)) {
                    last = Some((point.x, point.y));
                    sink(DragEvent::Move(point.x, point.y));
                }
                // 左键松开即结束。GetAsyncKeyState 的高位是当前按下状态。
                // VK_LBUTTON 在不同 windows-sys 版本里是 u16 / VIRTUAL_KEY，
                // 显式 as i32 比 i32::from 稳。
                let pressed = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } & 0x8000 != 0;
                if !pressed || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(DRAG_POLL);
            }
            DRAGGING.store(false, Ordering::SeqCst);
            sink(DragEvent::End);
        })
        .ok();
}

/// 卸载：把窗口过程还回去，并清掉状态。进程退出前调一次，避免回调打在已销毁的窗上。
pub(crate) fn uninstall(hwnd: HWND) {
    let mut map = chrome_map().lock().unwrap_or_else(|e| e.into_inner());
    let keys: Vec<isize> = map
        .iter()
        .filter(|(_, chrome)| chrome.root == hwnd)
        .map(|(key, _)| *key)
        .collect();
    for key in keys {
        if let Some(chrome) = map.remove(&key) {
            if chrome.original != 0 {
                unsafe { SetWindowLongPtrW(key as HWND, GWLP_WNDPROC, chrome.original) };
            }
        }
    }
    drop(map);
    state_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&(hwnd as isize));
}
