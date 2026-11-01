// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Probe 的本机环境指纹。未知字段禁用缓存；不阻止实际解码。
//! COM 浏览器版本在 UI 读取，OS/注册表/DXGI 在准备 worker 读取；原始机器标识不落盘。

use sha2::{Digest, Sha256};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIDevice, IDXGIFactory1, DXGI_ERROR_NOT_FOUND,
};
use windows_core::{Interface, PWSTR};
use windows_sys::core::w;
use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
};
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
use wry::WebViewExtWindows;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Environment {
    pub browser: String,
    pub fingerprint: String,
}

fn known<T>(value: Option<T>, stage: &str) -> Option<T> {
    if value.is_none() {
        crate::app::log(&format!(
            "decode qualification environment unavailable: {stage}"
        ));
    }
    value
}

pub(crate) fn browser_version(webview: &wry::WebView) -> Option<String> {
    let mut version = PWSTR::null();
    let result = unsafe {
        webview
            .controller()
            .CoreWebView2()
            .ok()?
            .cast::<ICoreWebView2_2>()
            .ok()?
            .Environment()
            .ok()?
            .BrowserVersionString(&mut version)
    };
    // WebView2 分配的字符串即使在失败分支也由 RAII 释放。
    let version = webview2_com::take_pwstr(version);
    result.ok()?;
    (!version.is_empty() && version.len() <= 256).then_some(version)
}

/// 枚举所有 adapter，避免混合显卡/远程会话仅绑定当前主屏驱动。
pub(crate) fn capture(browser: String) -> Option<Environment> {
    if browser.is_empty() || browser.len() > 256 {
        return None;
    }
    // 常驻 controller 可能仍运行旧 runtime；安装版本变化也必须使旧证明失效。
    let available = known(wry::webview_version().ok(), "installed runtime")?;
    if available.is_empty() || available.len() > 256 {
        return known(None, "installed runtime version");
    }
    let mut os = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    if unsafe { RtlGetVersion(&mut os) } != 0 {
        return known(None, "Windows version");
    }
    let mut revision = 0u32;
    let mut length = 4;
    if unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            w!("UBR"),
            RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            (&mut revision as *mut u32).cast(),
            &mut length,
        )
    } != 0
        || length != 4
    {
        return known(None, "Windows revision");
    }
    let mut machine = [0u16; 256];
    let mut length = (machine.len() * 2) as u32;
    if unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Cryptography"),
            w!("MachineGuid"),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            machine.as_mut_ptr().cast(),
            &mut length,
        )
    } != 0
        || length < 4
        || length as usize > machine.len() * 2
        || !length.is_multiple_of(2)
    {
        return known(None, "machine scope");
    }
    let machine = String::from_utf16(&machine[..length as usize / 2 - 1]).ok()?;
    if machine.is_empty() {
        return None;
    }
    let factory: IDXGIFactory1 = known(unsafe { CreateDXGIFactory1() }.ok(), "DXGI factory")?;
    let mut adapters = Vec::new();
    // 查询 DXGI 设备接口的 UMD driver version；不以 D3D feature level 冒充驱动版本。
    for index in 0..=16 {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) if index < 16 => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            _ => return known(None, "DXGI adapter enumeration"),
        };
        let description = known(
            unsafe { adapter.GetDesc1() }.ok(),
            "DXGI adapter description",
        )?;
        let driver = match unsafe { adapter.CheckInterfaceSupport(&IDXGIDevice::IID) } {
            Ok(driver) => driver,
            // DXGI_ADAPTER_FLAG_SOFTWARE：软件栈版本由 OS/浏览器键覆盖。
            Err(_) if description.Flags & 2 != 0 => 0,
            Err(_) => return known(None, "DXGI hardware driver version"),
        };
        adapters.push(format!(
            "{}:{}:{}:{}:{}:{driver}",
            description.VendorId,
            description.DeviceId,
            description.SubSysId,
            description.Revision,
            description.Flags
        ));
    }
    if adapters.is_empty() {
        return None;
    }
    adapters.sort();
    let mut digest = Sha256::new();
    let os = format!(
        "{}.{}.{}.{}:{}:{}",
        os.dwMajorVersion,
        os.dwMinorVersion,
        os.dwBuildNumber,
        revision,
        std::env::consts::ARCH,
        unsafe { GetSystemMetrics(SM_REMOTESESSION) }
    );
    for value in std::iter::once("probe-environment-v1")
        .chain([browser.as_str(), available.as_str(), &os, &machine])
        .chain(adapters.iter().map(String::as_str))
    {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    // 非默认启动/渲染参数也影响资格；只存摘要，不记录参数中的路径/身份或凭据。
    for name in [
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
        "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
    ] {
        let value = std::env::var_os(name).unwrap_or_default();
        use std::os::windows::ffi::OsStrExt;
        let value: Vec<u16> = value.encode_wide().collect();
        if value.len() > 32768 {
            return None;
        }
        digest.update(name.as_bytes());
        digest.update([0]);
        for unit in value {
            digest.update(unit.to_le_bytes());
        }
        digest.update([0, 0]);
    }
    Some(Environment {
        browser,
        fingerprint: format!("{:x}", digest.finalize()),
    })
}
