// SPDX-License-Identifier: MIT
//! Actual WebView2 File objects convey import authority; JSON paths do not.
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
use windows_core_webview::{Interface, PWSTR};
use wry::WebViewExtWindows;

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    kind: String,
    pub document_id: String,
    pub request_id: String,
}

impl Request {
    fn parse(body: &str) -> Option<Self> {
        if body.len() > 512 {
            return None;
        }
        let request: Self = serde_json::from_str(body).ok()?;
        (request.kind == "import-files"
            && uuid::Uuid::parse_str(&request.document_id).is_ok()
            && uuid::Uuid::parse_str(&request.request_id).is_ok())
        .then_some(request)
    }
}

/// The event token is removed before the retained WebView goes away.
pub(super) struct Handler {
    core: ICoreWebView2,
    token: i64,
    pending: Rc<RefCell<Option<(String, ICoreWebView2WebMessageReceivedEventArgs)>>>,
}
impl Handler {
    /// Event args never leave the WebView's STA. Native admission happens before path extraction.
    pub(super) fn take(
        &self,
        request: &Request,
    ) -> Option<ICoreWebView2WebMessageReceivedEventArgs> {
        let mut pending = self.pending.borrow_mut();
        if pending.as_ref().map(|(id, _)| id.as_str()) != Some(&request.request_id) {
            return None;
        }
        pending.take().map(|(_, args)| args)
    }
}
impl Drop for Handler {
    fn drop(&mut self) {
        unsafe {
            let _ = self.core.remove_WebMessageReceived(self.token);
        }
    }
}

pub(super) fn install(
    webview: &wry::WebView,
    origin: &str,
    proxy: super::EventLoopProxy<super::UserEvent>,
) -> anyhow::Result<Handler> {
    let core = webview.webview();
    let origin = origin.to_owned();
    let mut token = 0;
    let pending = Rc::new(RefCell::new(None));
    let callback_pending = pending.clone();
    unsafe {
        core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut source = PWSTR::null();
                args.Source(&mut source)?;
                let source = take_pwstr(source);
                if super::service_origin(&source).as_deref() != Some(&origin) {
                    return Ok(());
                }
                let mut body = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut body).is_err() {
                    return Ok(());
                }
                let Some(request) = Request::parse(&take_pwstr(body)) else {
                    return Ok(());
                };
                let mut pending = callback_pending.borrow_mut();
                if pending.is_some() {
                    let _ = proxy.send_event(super::UserEvent::FileImportBusy(request));
                    return Ok(());
                }
                *pending = Some((request.request_id.clone(), args));
                if proxy
                    .send_event(super::UserEvent::FileImport(request))
                    .is_err()
                {
                    pending.take();
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(Handler {
        core,
        token,
        pending,
    })
}

pub(super) fn extract_paths(
    args: &ICoreWebView2WebMessageReceivedEventArgs,
) -> Result<Vec<PathBuf>, String> {
    // Never inspect names, webkitRelativePath or path strings in the JSON payload.
    unsafe {
        let objects = args
            .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
            .and_then(|args| args.AdditionalObjects())
            .map_err(|_| "当前系统无法读取所选文件，请使用添加目录".to_string())?;
        let mut count = 0;
        objects
            .Count(&mut count)
            .map_err(|_| "无法读取所选文件".to_string())?;
        if count == 0 || count > 256 {
            return Err("请选择 1 至 256 个文件或目录".into());
        }
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let file = objects
                .GetValueAtIndex(index)
                .and_then(|object| object.cast::<ICoreWebView2File>())
                .map_err(|_| "只能导入本机文件或目录".to_string())?;
            let mut value = PWSTR::null();
            file.Path(&mut value)
                .map_err(|_| "无法读取文件位置".to_string())?;
            let path = PathBuf::from(take_pwstr(value));
            if path.as_os_str().is_empty() || !path.is_absolute() {
                return Err("未能取得本机文件位置，请重新选择文件".into());
            }
            paths.push(path);
        }
        Ok(paths)
    }
}

pub(super) fn receipt(webview: &wry::WebView, request: &Request, result: Result<(), String>) {
    let (status, error) = match result {
        Ok(()) => ("accepted", None),
        Err(error) => ("failed", Some(error)),
    };
    let value = serde_json::json!({ "documentId": request.document_id, "requestId": request.request_id, "status": status, "error": error });
    let _ = webview.evaluate_script(&format!(
        "window.dispatchEvent(new CustomEvent('hertz-native-import-result',{{detail:{value}}}));"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_never_accepts_path_payloads_or_untyped_identity() {
        let document = uuid::Uuid::new_v4();
        let request = uuid::Uuid::new_v4();
        assert!(Request::parse(&format!(
            r#"{{"kind":"import-files","documentId":"{document}","requestId":"{request}"}}"#
        ))
        .is_some());
        assert!(Request::parse(&format!(r#"{{"kind":"import-files","documentId":"{document}","requestId":"{request}","paths":["C:\\Music"]}}"#)).is_none());
        assert!(
            Request::parse(r#"{"kind":"import-files","documentId":"old","requestId":"fake"}"#)
                .is_none()
        );
    }
}
