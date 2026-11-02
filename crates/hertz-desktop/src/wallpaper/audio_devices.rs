// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Render endpoint discovery and notifications. Constructed on the single audio owner thread;
//! callbacks only mark a revision and wake that owner, never start a capture or call a WebView.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use windows::core::{implement, PCWSTR};
use windows::Win32::{
    Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
    Foundation::PROPERTYKEY,
    Media::Audio::*,
    System::Com::{
        StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
        *,
    },
};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Endpoint {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EndpointKey {
    pub id: String,
    pub format: Vec<u8>,
}

#[implement(IMMNotificationClient, IAgileObject)]
struct Notifications {
    revision: Arc<AtomicU64>,
    wake: Arc<dyn Fn() + Send + Sync>,
}
impl Notifications {
    fn changed(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
        (self.wake)();
    }
}
impl IAgileObject_Impl for Notifications_Impl {}
impl IMMNotificationClient_Impl for Notifications_Impl {
    fn OnDeviceStateChanged(&self, _: &PCWSTR, _: DEVICE_STATE) -> windows::core::Result<()> {
        self.changed();
        Ok(())
    }
    fn OnDeviceAdded(&self, _: &PCWSTR) -> windows::core::Result<()> {
        self.changed();
        Ok(())
    }
    fn OnDeviceRemoved(&self, _: &PCWSTR) -> windows::core::Result<()> {
        self.changed();
        Ok(())
    }
    fn OnDefaultDeviceChanged(
        &self,
        flow: EDataFlow,
        role: ERole,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        if flow == eRender && role == eMultimedia {
            self.changed();
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _: &PCWSTR, _: &PROPERTYKEY) -> windows::core::Result<()> {
        self.changed();
        Ok(())
    }
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

pub(crate) struct DeviceWatch {
    enumerator: IMMDeviceEnumerator,
    callback: IMMNotificationClient,
    revision: Arc<AtomicU64>,
    // COM interfaces must drop before balancing the apartment initialization.
    _apartment: Apartment,
}
impl DeviceWatch {
    pub(crate) fn open(wake: Arc<dyn Fn() + Send + Sync>) -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|error| format!("音频设备 COM 初始化失败：{error}"))?;
            let apartment = Apartment;
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|error| format!("枚举渲染设备失败：{error}"))?;
            let revision = Arc::new(AtomicU64::new(1));
            let callback: IMMNotificationClient = Notifications {
                revision: Arc::clone(&revision),
                wake,
            }
            .into();
            enumerator
                .RegisterEndpointNotificationCallback(&callback)
                .map_err(|error| format!("注册渲染设备通知失败：{error}"))?;
            Ok(Self {
                enumerator,
                callback,
                revision,
                _apartment: apartment,
            })
        }
    }
    pub(crate) fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }
    pub(crate) fn endpoints(&self) -> Result<Vec<Endpoint>, String> {
        unsafe {
            let default = self
                .enumerator
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .ok()
                .and_then(|device| endpoint_id(&device).ok());
            let collection = self
                .enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|error| format!("列出渲染设备失败：{error}"))?;
            let count = collection
                .GetCount()
                .map_err(|error| error.to_string())?
                .min(128);
            let mut result = Vec::with_capacity(count as usize);
            let mut response_bytes = 0;
            for index in 0..count {
                let device = collection.Item(index).map_err(|error| error.to_string())?;
                let id = endpoint_id(&device)?;
                let name = endpoint_name(&device).unwrap_or_else(|_| id.clone());
                // Keep the management response bounded even with virtual endpoint fleets.
                if id.len() > 1024 {
                    continue;
                }
                let endpoint = Endpoint {
                    is_default: default.as_ref() == Some(&id),
                    id,
                    name,
                };
                response_bytes += serde_json::to_vec(&endpoint)
                    .map_err(|error| error.to_string())?
                    .len();
                if response_bytes > 16 * 1024 {
                    break;
                }
                result.push(endpoint);
            }
            Ok(result)
        }
    }
    pub(crate) fn selection(&self, fixed: Option<&str>) -> Result<EndpointKey, String> {
        unsafe {
            let device = match fixed {
                Some(id) => self
                    .enumerator
                    .GetDevice(&windows::core::HSTRING::from(id))
                    .map_err(|error| format!("找不到指定渲染设备（不回退其它设备）：{error}"))?,
                None => self
                    .enumerator
                    .GetDefaultAudioEndpoint(eRender, eMultimedia)
                    .map_err(|error| format!("没有默认渲染设备：{error}"))?,
            };
            let state = device.GetState().map_err(|error| error.to_string())?;
            if state != DEVICE_STATE_ACTIVE {
                return Err("所选渲染设备当前不可用".into());
            }
            let id = endpoint_id(&device)?;
            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|error| error.to_string())?;
            let format = client.GetMixFormat().map_err(|error| error.to_string())?;
            let extra = core::ptr::addr_of!((*format).cbSize).read_unaligned() as usize;
            let bytes = if extra <= 4096 {
                Ok(std::slice::from_raw_parts(
                    format.cast::<u8>(),
                    std::mem::size_of::<WAVEFORMATEX>() + extra,
                )
                .to_vec())
            } else {
                Err("设备混合格式超过有界描述长度".to_string())
            };
            CoTaskMemFree(Some(format.cast()));
            Ok(EndpointKey { id, format: bytes? })
        }
    }
}
impl Drop for DeviceWatch {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .enumerator
                .UnregisterEndpointNotificationCallback(&self.callback);
        }
    }
}
unsafe fn endpoint_id(device: &IMMDevice) -> Result<String, String> {
    let id = device.GetId().map_err(|error| error.to_string())?;
    let text = id.to_string().map_err(|error| error.to_string());
    CoTaskMemFree(Some(id.0.cast()));
    text
}
unsafe fn endpoint_name(device: &IMMDevice) -> Result<String, String> {
    let properties = device
        .OpenPropertyStore(STGM_READ)
        .map_err(|error| error.to_string())?;
    let mut value = properties
        .GetValue(&PKEY_Device_FriendlyName)
        .map_err(|error| error.to_string())?;
    let text = PropVariantToStringAlloc(&value);
    let _ = PropVariantClear(&mut value);
    let text = text.map_err(|error| error.to_string())?;
    let name = text.to_string().map_err(|error| error.to_string());
    CoTaskMemFree(Some(text.0.cast()));
    name.map(|name| name.chars().take(256).collect())
}
