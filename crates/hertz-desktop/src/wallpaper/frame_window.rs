// SPDX-License-Identifier: MIT
//! One native static bitmap behind the desktop icons, with no WebView/decoder/GL.
use std::cell::{Cell, RefCell};
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::sync::OnceLock;

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EndPaint, GdiFlush,
    GetObjectW, SelectObject, SetStretchBltMode, StretchDIBits, AC_SRC_ALPHA, AC_SRC_OVER, BITMAP,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS, HALFTONE, HBITMAP, HDC,
    PAINTSTRUCT, SRCCOPY,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW, IsWindow,
    IsWindowVisible, RegisterClassW, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    UpdateLayeredWindow, CREATESTRUCTW, GWLP_USERDATA, HTTRANSPARENT, HWND_TOP, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE, ULW_ALPHA, WM_ERASEBKGND, WM_NCCREATE,
    WM_NCDESTROY, WM_NCHITTEST, WM_PAINT, WM_PRINTCLIENT, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

struct Bitmap {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
    paints: Cell<u64>,
}
impl Bitmap {
    unsafe fn copy(&self, dc: HDC, width: i32, height: i32) -> bool {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: self.width as i32,
                biHeight: -(self.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            },
            ..std::mem::zeroed()
        };
        SetStretchBltMode(dc, HALFTONE);
        let copied = StretchDIBits(
            dc,
            0,
            0,
            width,
            height,
            0,
            0,
            self.width as i32,
            self.height as i32,
            self.bgra.as_ptr().cast(),
            &info,
            DIB_RGB_COLORS,
            SRCCOPY,
        );
        copied > 0 && GdiFlush() != 0
    }
    unsafe fn paint(&self, hwnd: HWND, dc: HDC) {
        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect) != 0 && self.copy(dc, rect.right, rect.bottom) {
            self.paints.set(self.paints.get().saturating_add(1));
        }
    }
}

/// Full-size staging storage, destroyed after UpdateLayeredWindow copies it.
struct StagingDib {
    dc: HDC,
    dib: HBITMAP,
    delete_requested: bool,
}
impl StagingDib {
    fn close(&mut self) -> bool {
        unsafe {
            // Delete the DC first so the DIB is no longer selected into it.
            if !self.dc.is_null() {
                if DeleteDC(self.dc) == 0 {
                    return false;
                }
                self.dc = null_mut();
            }
            if !self.dib.is_null() {
                if !self.delete_requested {
                    if DeleteObject(self.dib) == 0 {
                        return false;
                    }
                    self.delete_requested = true;
                }
                // GDI can accept deletion while a selected bitmap stays alive.
                // Do not repeat deletion against a possibly recycled handle.
                // A type/size-only query can still answer from stale handle bits;
                // requesting the actual BITMAP proves the object is still live.
                let mut object: BITMAP = std::mem::zeroed();
                if GetObjectW(
                    self.dib,
                    size_of::<BITMAP>() as i32,
                    (&mut object as *mut BITMAP).cast(),
                ) != 0
                {
                    return false;
                }
                self.dib = null_mut();
            }
        }
        true
    }
}
impl Drop for StagingDib {
    fn drop(&mut self) {
        self.close();
    }
}
unsafe extern "system" fn procedure(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        return 1;
    }
    if message == WM_NCDESTROY {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
    }
    if message == WM_NCHITTEST {
        return HTTRANSPARENT as LRESULT;
    }
    if message == WM_ERASEBKGND {
        return 1;
    }
    let bitmap = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Bitmap;
    if !bitmap.is_null() {
        if message == WM_PAINT {
            let mut paint: PAINTSTRUCT = std::mem::zeroed();
            let dc = BeginPaint(hwnd, &mut paint);
            if !dc.is_null() {
                (*bitmap).paint(hwnd, dc);
            }
            EndPaint(hwnd, &paint);
            return 0;
        }
        if message == WM_PRINTCLIENT {
            (*bitmap).paint(hwnd, wparam as HDC);
            return 0;
        }
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

pub(crate) struct FrameWindow {
    hwnd: HWND,
    bitmap: Option<Box<Bitmap>>,
    digest: String,
    presentations: Cell<u64>,
    staging: RefCell<Option<StagingDib>>,
}
impl FrameWindow {
    pub(crate) fn create(width: u32, height: u32, bgra: Vec<u8>) -> Result<Self> {
        if width == 0
            || height == 0
            || width > 960
            || height > 540
            || bgra.len() != width as usize * height as usize * 4
        {
            bail!("静态帧窗口尺寸无效");
        }
        static CLASS: OnceLock<Vec<u16>> = OnceLock::new();
        let class = CLASS.get_or_init(|| {
            let class = crate::native::to_wide("HertzWallpaperFrame");
            let definition = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: unsafe { GetModuleHandleW(null()) },
                lpszClassName: class.as_ptr(),
                ..unsafe { std::mem::zeroed() }
            };
            unsafe {
                RegisterClassW(&definition);
            }
            class
        });
        let digest = format!("{:x}", Sha256::digest(&bgra));
        let mut bitmap = Box::new(Bitmap {
            width,
            height,
            bgra,
            paints: Cell::new(0),
        });
        let title = crate::native::to_wide("Hertz wallpaper frame");
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED,
                class.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                0,
                0,
                width as i32,
                height as i32,
                null_mut(),
                null_mut(),
                GetModuleHandleW(null()),
                (&mut *bitmap as *mut Bitmap).cast(),
            )
        };
        if hwnd.is_null() {
            bail!("创建静态帧窗口失败：{}", std::io::Error::last_os_error());
        }
        Ok(Self {
            hwnd,
            bitmap: Some(bitmap),
            digest,
            presentations: Cell::new(0),
            staging: RefCell::new(None),
        })
    }
    pub(crate) fn mount(&self, monitor: &crate::native::WallpaperMonitor) -> Result<()> {
        crate::native::mount_wallpaper(self.hwnd, monitor)?;
        if !self.alive() || !crate::native::wallpaper_alive(self.hwnd) {
            bail!("静态帧未能挂载到桌面层");
        }
        self.upload(monitor)?;
        self.raise()
    }

    pub(crate) fn mount_preview(
        &self,
        monitor: &crate::native::WallpaperMonitor,
        owner: HWND,
    ) -> Result<()> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GWLP_HWNDPARENT, SWP_SHOWWINDOW};
        unsafe {
            if IsWindow(owner) == 0 {
                bail!("静态预览所属窗口已关闭");
            }
            SetWindowLongPtrW(self.hwnd, GWLP_HWNDPARENT, owner as isize);
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetWindowLongPtrW, SetParent, GWL_STYLE, WS_CHILD, WS_POPUP,
            };
            if GetWindowLongPtrW(owner, GWL_STYLE) & WS_CHILD as isize != 0 {
                let style = GetWindowLongPtrW(self.hwnd, GWL_STYLE);
                SetWindowLongPtrW(
                    self.hwnd,
                    GWL_STYLE,
                    (style & !(WS_POPUP as isize)) | WS_CHILD as isize,
                );
                SetParent(self.hwnd, owner);
            }
            if SetWindowPos(
                self.hwnd,
                HWND_TOP,
                monitor.left,
                monitor.top,
                monitor.width,
                monitor.height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            ) == 0
            {
                bail!("静态预览定位失败");
            }
        }
        self.upload(monitor)?;
        self.raise()
    }

    pub(crate) fn set_preview_visibility(
        &self,
        monitor: &crate::native::WallpaperMonitor,
        visible: bool,
    ) {
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE,
            };
            SetWindowPos(
                self.hwnd,
                HWND_TOP,
                monitor.left,
                monitor.top,
                monitor.width,
                monitor.height,
                SWP_NOACTIVATE,
            );
            ShowWindow(self.hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
        }
    }

    fn upload(&self, monitor: &crate::native::WallpaperMonitor) -> Result<()> {
        let pixels = super::handoff::target_pixels(monitor.width as u32, monitor.height as u32)?;
        if self.staging.borrow().is_some() {
            bail!("旧静态帧工作区尚未退出");
        }
        let result = (|| unsafe {
            // Do not call SetLayeredWindowAttributes: it disables subsequent
            // UpdateLayeredWindow uploads until WS_EX_LAYERED is reset.
            *self.staging.borrow_mut() = Some(StagingDib {
                dc: CreateCompatibleDC(null_mut()),
                dib: null_mut(),
                delete_requested: false,
            });
            let mut staging = self.staging.borrow_mut();
            let stage = staging.as_mut().expect("native staging");
            if stage.dc.is_null() {
                bail!("创建静态帧绘制上下文失败");
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: monitor.width,
                    biHeight: -monitor.height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };
            let mut storage = null_mut();
            stage.dib =
                CreateDIBSection(stage.dc, &info, DIB_RGB_COLORS, &mut storage, null_mut(), 0);
            if stage.dib.is_null() || storage.is_null() {
                bail!("创建静态帧位图失败");
            }
            let old = SelectObject(stage.dc, stage.dib);
            if old.is_null()
                || !self.bitmap.as_ref().expect("native bitmap").copy(
                    stage.dc,
                    monitor.width,
                    monitor.height,
                )
            {
                bail!("填充静态帧位图失败");
            }
            // StretchDIBits does not preserve alpha. All captured pixels are opaque.
            for pixel in std::slice::from_raw_parts_mut(storage as *mut u8, pixels as usize * 4)
                .as_chunks_mut::<4>()
                .0
            {
                pixel[3] = 255;
            }
            let size = SIZE {
                cx: monitor.width,
                cy: monitor.height,
            };
            let origin = POINT { x: 0, y: 0 };
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            if UpdateLayeredWindow(
                self.hwnd,
                null_mut(),
                null(),
                &size,
                stage.dc,
                &origin,
                0,
                &blend,
                ULW_ALPHA,
            ) == 0
            {
                bail!("提交静态帧位图失败：{}", std::io::Error::last_os_error());
            }
            self.presentations
                .set(self.presentations.get().saturating_add(1));
            Ok(())
        })();
        if !self.reap_staging() {
            bail!("静态帧工作区尚未退出");
        }
        result
    }

    pub(crate) fn reap_staging(&self) -> bool {
        let mut staging = self.staging.borrow_mut();
        if staging.as_mut().is_some_and(|stage| !stage.close()) {
            return false;
        }
        staging.take();
        true
    }

    pub(crate) fn raise(&self) -> Result<()> {
        if unsafe {
            SetWindowPos(
                self.hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
        } == 0
        {
            bail!("静态帧未能覆盖旧窗口");
        }
        Ok(())
    }
    pub(crate) fn hwnd(&self) -> HWND {
        self.hwnd
    }
    pub(crate) fn alive(&self) -> bool {
        let expected = self
            .bitmap
            .as_ref()
            .map(|bitmap| &**bitmap as *const Bitmap as isize);
        !self.hwnd.is_null()
            && expected.is_some_and(|expected| unsafe {
                IsWindow(self.hwnd) != 0 && GetWindowLongPtrW(self.hwnd, GWLP_USERDATA) == expected
            })
    }
    pub(crate) fn paints(&self) -> u64 {
        self.bitmap.as_ref().map_or(0, |bitmap| bitmap.paints.get())
    }
    pub(crate) fn presentations(&self) -> u64 {
        self.presentations.get()
    }
    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }
    pub(crate) fn is_visible(&self) -> bool {
        self.alive() && unsafe { IsWindowVisible(self.hwnd) } != 0
    }
    pub(crate) fn visible(&self, visible: bool) {
        if self.alive() && self.is_visible() != visible {
            unsafe {
                ShowWindow(self.hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
        }
    }
    pub(crate) fn close(&mut self) -> bool {
        if self.alive() && unsafe { DestroyWindow(self.hwnd) } == 0 {
            return false;
        }
        self.hwnd = null_mut();
        self.bitmap.take();
        self.reap_staging()
    }
}
impl Drop for FrameWindow {
    fn drop(&mut self) {
        if !self.close() {
            // A still-live WndProc must not hold a pointer into freed Rust storage.
            if let Some(bitmap) = self.bitmap.take() {
                Box::leak(bitmap);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW;

    #[test]
    fn real_native_window_paints_top_down_bgra_and_does_not_close_a_reused_handle() {
        let pixels = vec![
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
        ];
        let mut window = FrameWindow::create(2, 2, pixels.clone()).unwrap();
        unsafe {
            let dc = CreateCompatibleDC(null_mut());
            assert!(!dc.is_null());
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: 2,
                    biHeight: -2,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };
            let mut storage = null_mut();
            let dib = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut storage, null_mut(), 0);
            assert!(!dib.is_null());
            let old = SelectObject(dc, dib);
            SendMessageW(window.hwnd(), WM_PRINTCLIENT, dc as usize, 0);
            let actual = std::slice::from_raw_parts(storage as *const u8, 16);
            for (actual, expected) in actual
                .as_chunks::<4>()
                .0
                .iter()
                .zip(pixels.as_chunks::<4>().0)
            {
                assert_eq!(&actual[..3], &expected[..3]);
            }
            assert_eq!(window.paints(), 1);
            SelectObject(dc, old);
            DeleteObject(dib);
            DeleteDC(dc);
        }
        assert!(window.close());
        let replacement = FrameWindow::create(2, 2, pixels).unwrap();
        window.hwnd = replacement.hwnd();
        assert!(window.close());
        assert!(
            replacement.alive(),
            "stale owner cannot destroy the replacement HWND"
        );
    }

    #[test]
    fn upload_releases_native_staging_while_the_static_window_remains_alive() {
        let mut owner = FrameWindow::create(2, 2, [0, 0, 0, 255].repeat(4)).unwrap();
        let mut window = FrameWindow::create(2, 2, [10, 20, 30, 255].repeat(4)).unwrap();
        let monitor = crate::native::WallpaperMonitor {
            name: "test-frame".into(),
            left: 0,
            top: 0,
            width: 2,
            height: 2,
            dpi: 96,
            primary: false,
            refresh_hz: 60,
            device_path: None,
            edid_digest: None,
        };
        window.mount_preview(&monitor, owner.hwnd()).unwrap();
        assert_eq!(window.presentations(), 1);
        assert!(window.alive());
        assert!(window.staging.borrow().is_none());
        assert!(window.reap_staging());
        assert!(window.close());
        assert!(owner.close());
    }

    #[test]
    fn selected_native_dib_blocks_staging_exit_until_its_real_reference_is_removed() {
        unsafe {
            let dc = CreateCompatibleDC(null_mut());
            let external = CreateCompatibleDC(null_mut());
            assert!(!dc.is_null() && !external.is_null());
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: 2,
                    biHeight: -2,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };
            let mut storage = null_mut();
            let dib = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut storage, null_mut(), 0);
            assert!(!dib.is_null());
            let old = SelectObject(external, dib);
            assert!(!old.is_null());
            let mut window = FrameWindow::create(2, 2, [0, 0, 0, 255].repeat(4)).unwrap();
            *window.staging.borrow_mut() = Some(StagingDib {
                dc,
                dib,
                delete_requested: false,
            });
            assert!(!window.reap_staging());
            assert!(
                !window.reap_staging(),
                "accepted but deferred deletion is not an exit acknowledgement"
            );
            assert!(window.staging.borrow().is_some());
            assert!(
                !window.close(),
                "HWND exit does not prove the staging DIB exited"
            );
            SelectObject(external, old);
            assert_ne!(DeleteDC(external), 0);
            assert!(window.close());
            assert!(window.staging.borrow().is_none());
        }
    }
}
