// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Optional host-wide lyrics recovery shortcut. The App owns durable preferences;
//! this module owns only the actual Win32 registrations and their replacement.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use windows_sys::Win32::Foundation::{ERROR_HOTKEY_NOT_REGISTERED, HWND};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

// Two distinct window-local IDs let the old shortcut survive until the new one
// has registered and its preference has been durably saved. Never reuse an ID
// whose cleanup failed, or RegisterHotKey could leave an untracked registration.
const REGISTRATION_IDS: [i32; 2] = [0x4851, 0x4852];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Shortcut {
    canonical: String,
    modifiers: u32,
    key: u32,
}

impl Shortcut {
    pub(crate) fn as_str(&self) -> &str {
        &self.canonical
    }
}

impl fmt::Display for Shortcut {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Shortcut {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() > 40 || !value.is_ascii() {
            return Err("快捷键格式无效".into());
        }
        let parts: Vec<_> = value.split('+').map(str::trim).collect();
        if !(3..=4).contains(&parts.len()) || parts.iter().any(|part| part.is_empty()) {
            return Err(
                "请使用 Ctrl、Alt、Shift 中至少两个修饰键，再加一个字母、数字或功能键".into(),
            );
        }
        let mut modifiers = 0;
        for part in &parts[..parts.len() - 1] {
            let flag = match part.to_ascii_lowercase().as_str() {
                "ctrl" => MOD_CONTROL,
                "alt" => MOD_ALT,
                "shift" => MOD_SHIFT,
                _ => return Err("修饰键只支持 Ctrl、Alt、Shift；不使用 Windows 系统键".into()),
            };
            if modifiers & flag != 0 {
                return Err("修饰键不能重复".into());
            }
            modifiers |= flag;
        }
        let main = parts[parts.len() - 1].to_ascii_uppercase();
        let key = if main.len() == 1 && main.as_bytes()[0].is_ascii_alphanumeric() {
            u32::from(main.as_bytes()[0])
        } else if let Some(number) = main.strip_prefix('F') {
            let function = number.parse::<u32>().ok().filter(|number| {
                (1..=24).contains(number) && *number != 12 && main == format!("F{number}")
            });
            match function {
                Some(function) => 0x70 + function - 1,
                None => return Err("功能键支持 F1–F11、F13–F24；F12 由系统保留".into()),
            }
        } else {
            return Err("主键只支持 A–Z、0–9、F1–F11 或 F13–F24".into());
        };
        let mut canonical = String::new();
        for (flag, name) in [
            (MOD_CONTROL, "Ctrl+"),
            (MOD_ALT, "Alt+"),
            (MOD_SHIFT, "Shift+"),
        ] {
            if modifiers & flag != 0 {
                canonical.push_str(name);
            }
        }
        canonical.push_str(&main);
        Ok(Self {
            canonical,
            modifiers,
            key,
        })
    }
}

impl Serialize for Shortcut {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Shortcut {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// A failed commit can still have replaced the durable file before journal
/// finalization failed. The owner must return the actual saved preference after
/// every attempt, and must never restore an older revision directly in memory.
pub(crate) struct PersistOutcome {
    pub(crate) saved: Option<Shortcut>,
    pub(crate) result: Result<(), String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Status {
    pub(crate) saved: Option<Shortcut>,
    pub(crate) registered: Vec<Shortcut>,
    pub(crate) error: Option<String>,
}

pub(crate) trait Registry {
    fn register(&mut self, id: i32, shortcut: &Shortcut) -> Result<(), String>;
    /// Success also covers an ID already absent from the operating system.
    fn unregister(&mut self, id: i32) -> Result<(), String>;
}

pub(crate) struct Win32Registry {
    hwnd: HWND,
}

impl Win32Registry {
    fn check_thread(&self) -> Result<(), String> {
        let owner = unsafe { GetWindowThreadProcessId(self.hwnd, std::ptr::null_mut()) };
        if owner == 0 || owner != unsafe { GetCurrentThreadId() } {
            return Err("快捷键必须由歌词窗口所属线程注册和释放".into());
        }
        Ok(())
    }
}

impl Registry for Win32Registry {
    fn register(&mut self, id: i32, shortcut: &Shortcut) -> Result<(), String> {
        self.check_thread()?;
        if unsafe {
            RegisterHotKey(
                self.hwnd,
                id,
                shortcut.modifiers | MOD_NOREPEAT,
                shortcut.key,
            )
        } == 0
        {
            return Err(format!(
                "无法注册 {shortcut}，组合键可能已被占用：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn unregister(&mut self, id: i32) -> Result<(), String> {
        self.check_thread()?;
        if unsafe { UnregisterHotKey(self.hwnd, id) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_HOTKEY_NOT_REGISTERED as i32) {
                return Err(format!("无法释放快捷键：{error}"));
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Registration {
    id: i32,
    shortcut: Shortcut,
}

pub(crate) struct Manager<R: Registry = Win32Registry> {
    registry: R,
    registered: Vec<Registration>,
    error: Option<String>,
}

impl Manager<Win32Registry> {
    pub(crate) fn new(hwnd: HWND) -> Self {
        Self::with_registry(Win32Registry { hwnd })
    }
}

impl<R: Registry> Manager<R> {
    fn with_registry(registry: R) -> Self {
        Self {
            registry,
            registered: Vec::new(),
            error: None,
        }
    }

    pub(crate) fn initialize(&mut self, saved: Option<&Shortcut>) -> Result<(), String> {
        self.replace(saved, saved.cloned(), |_| {
            unreachable!("initialization never saves preferences")
        })
    }

    pub(crate) fn status(&self, saved: Option<&Shortcut>) -> Status {
        Status {
            saved: saved.cloned(),
            registered: self
                .registered
                .iter()
                .map(|entry| entry.shortcut.clone())
                .collect(),
            error: self.error.clone(),
        }
    }

    pub(crate) fn handles(&self, id: i32) -> bool {
        self.registered.iter().any(|entry| entry.id == id)
    }

    /// Caller serializes commands and checks expectedRevision before entering.
    /// Each successful persistence or compensating write advances its revision.
    pub(crate) fn replace(
        &mut self,
        saved: Option<&Shortcut>,
        desired: Option<Shortcut>,
        mut persist: impl FnMut(Option<&Shortcut>) -> PersistOutcome,
    ) -> Result<(), String> {
        let old_saved = saved.cloned();
        let before = self.registered.clone();
        if before.len() > 1 && desired.is_some() {
            return self.fail(vec![
                "上次快捷键释放未完成，请先清空快捷键，再重新设置".into()
            ]);
        }
        let mut candidate = None;
        if let Some(shortcut) = desired.as_ref() {
            if !self
                .registered
                .iter()
                .any(|entry| &entry.shortcut == shortcut)
            {
                let Some(id) = REGISTRATION_IDS
                    .iter()
                    .copied()
                    .find(|id| !self.handles(*id))
                else {
                    return self.fail(vec!["快捷键释放未完成，请先清空快捷键".into()]);
                };
                if let Err(error) = self.registry.register(id, shortcut) {
                    return self.fail(vec![error]);
                }
                self.registered.push(Registration {
                    id,
                    shortcut: shortcut.clone(),
                });
                candidate = Some(id);
            }
        }

        let mut actual_saved = old_saved.clone();
        if old_saved != desired {
            let outcome = persist(desired.as_ref());
            actual_saved = outcome.saved;
            let failure = match outcome.result {
                Err(error) => Some(format!("保存快捷键失败：{error}")),
                Ok(()) if actual_saved != desired => Some("保存后的快捷键与本次请求不一致".into()),
                Ok(()) => None,
            };
            if let Some(error) = failure {
                let mut errors = vec![error];
                self.revoke_candidate(candidate, &mut errors);
                Self::compensate(&old_saved, actual_saved, &mut persist, &mut errors);
                return self.fail(errors);
            }
        }

        // Clearing persists None before releasing registrations. Keep a record
        // of every successful release so a later failure can restore the former
        // actual state, including a previous transaction's residual candidate.
        let obsolete: Vec<_> = before
            .into_iter()
            .filter(|entry| Some(&entry.shortcut) != desired.as_ref())
            .collect();
        let mut removed: Vec<Registration> = Vec::new();
        for entry in obsolete {
            if let Err(error) = self.remove(entry.id) {
                let mut errors = vec![format!("释放旧快捷键 {} 失败：{error}", entry.shortcut)];
                self.revoke_candidate(candidate, &mut errors);
                for old in removed {
                    match self.registry.register(old.id, &old.shortcut) {
                        Ok(()) => self.registered.push(old),
                        Err(error) => {
                            errors.push(format!("恢复旧快捷键 {} 失败：{error}", old.shortcut))
                        }
                    }
                }
                Self::compensate(&old_saved, actual_saved, &mut persist, &mut errors);
                return self.fail(errors);
            }
            removed.push(entry);
        }
        self.error = None;
        Ok(())
    }

    fn compensate(
        old_saved: &Option<Shortcut>,
        actual_saved: Option<Shortcut>,
        persist: &mut impl FnMut(Option<&Shortcut>) -> PersistOutcome,
        errors: &mut Vec<String>,
    ) {
        if &actual_saved == old_saved {
            return;
        }
        let outcome = persist(old_saved.as_ref());
        if let Err(error) = outcome.result {
            errors.push(format!("恢复原快捷键偏好时保存失败：{error}"));
        }
        if &outcome.saved != old_saved {
            errors.push("原快捷键偏好未恢复；当前保存值与实际注册请分别查看".into());
        }
    }

    fn revoke_candidate(&mut self, candidate: Option<i32>, errors: &mut Vec<String>) {
        if let Some(id) = candidate {
            if let Err(error) = self.remove(id) {
                errors.push(format!("候选快捷键未释放，可能仍有多个快捷键生效：{error}"));
            }
        }
    }

    fn remove(&mut self, id: i32) -> Result<(), String> {
        self.registry.unregister(id)?;
        self.registered.retain(|entry| entry.id != id);
        Ok(())
    }

    fn fail(&mut self, errors: Vec<String>) -> Result<(), String> {
        let error = errors.join("；");
        self.error = Some(error.clone());
        Err(error)
    }

    pub(crate) fn shutdown(&mut self) -> Result<(), String> {
        let ids: Vec<_> = self.registered.iter().map(|entry| entry.id).collect();
        let mut errors = Vec::new();
        for id in ids {
            if let Err(error) = self.remove(id) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            self.error = None;
            Ok(())
        } else {
            self.fail(errors)
        }
    }
}

impl<R: Registry> Drop for Manager<R> {
    fn drop(&mut self) {
        // The App explicitly shuts down before destroying the HWND. This also
        // covers initialization failures; failed IDs stay tracked until retry.
        let _ = self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, VecDeque};
    use std::rc::Rc;

    const OLD: &str = "Ctrl+Alt+L";
    const NEW: &str = "Ctrl+Shift+F9";
    type Events = Rc<RefCell<Vec<String>>>;

    #[derive(Default)]
    struct FakeOs {
        keys: BTreeMap<i32, String>,
        fail_register: VecDeque<String>,
        fail_unregister: VecDeque<i32>,
        events: Events,
    }

    struct FakeRegistry(Rc<RefCell<FakeOs>>);

    impl Registry for FakeRegistry {
        fn register(&mut self, id: i32, shortcut: &Shortcut) -> Result<(), String> {
            let mut os = self.0.borrow_mut();
            os.events.borrow_mut().push(format!("register:{shortcut}"));
            if os
                .fail_register
                .front()
                .is_some_and(|key| key == shortcut.as_str())
            {
                os.fail_register.pop_front();
                return Err("组合键已被占用".into());
            }
            assert!(!os.keys.contains_key(&id), "must never reuse a live ID");
            assert!(
                !os.keys.values().any(|key| key == shortcut.as_str()),
                "must not register a key twice"
            );
            os.keys.insert(id, shortcut.to_string());
            Ok(())
        }

        fn unregister(&mut self, id: i32) -> Result<(), String> {
            let mut os = self.0.borrow_mut();
            os.events.borrow_mut().push(format!(
                "unregister:{}",
                os.keys.get(&id).map(String::as_str).unwrap_or("absent")
            ));
            if os.fail_unregister.front() == Some(&id) {
                os.fail_unregister.pop_front();
                return Err("模拟注销失败".into());
            }
            os.keys.remove(&id);
            Ok(())
        }
    }

    enum SaveFault {
        BeforeWrite,
        AfterWrite,
    }

    struct Store {
        saved: Option<Shortcut>,
        revision: u64,
        attempts: usize,
        faults: VecDeque<(usize, SaveFault)>,
        events: Events,
    }

    impl Store {
        fn persist(&mut self, desired: Option<&Shortcut>) -> PersistOutcome {
            self.attempts += 1;
            self.events.borrow_mut().push(format!(
                "save:{}",
                desired.map(Shortcut::as_str).unwrap_or("empty")
            ));
            let fault = if self
                .faults
                .front()
                .is_some_and(|(attempt, _)| *attempt == self.attempts)
            {
                self.faults.pop_front().map(|(_, fault)| fault)
            } else {
                None
            };
            if matches!(fault, Some(SaveFault::BeforeWrite)) {
                return PersistOutcome {
                    saved: self.saved.clone(),
                    result: Err("模拟落盘失败".into()),
                };
            }
            self.saved = desired.cloned();
            self.revision += 1;
            PersistOutcome {
                saved: self.saved.clone(),
                result: if matches!(fault, Some(SaveFault::AfterWrite)) {
                    Err("模拟提交收据失败".into())
                } else {
                    Ok(())
                },
            }
        }
    }

    fn shortcut(value: &str) -> Shortcut {
        value.parse().unwrap()
    }

    fn fixture(saved: Option<&str>) -> (Manager<FakeRegistry>, Rc<RefCell<FakeOs>>, Store) {
        let events = Events::default();
        let os = Rc::new(RefCell::new(FakeOs {
            events: events.clone(),
            ..Default::default()
        }));
        let mut manager = Manager::with_registry(FakeRegistry(os.clone()));
        let store = Store {
            saved: saved.map(shortcut),
            revision: 20,
            attempts: 0,
            faults: VecDeque::new(),
            events,
        };
        manager.initialize(store.saved.as_ref()).unwrap();
        store.events.borrow_mut().clear();
        (manager, os, store)
    }

    fn replace(
        manager: &mut Manager<FakeRegistry>,
        store: &mut Store,
        desired: Option<&str>,
    ) -> Result<(), String> {
        let saved = store.saved.clone();
        manager.replace(saved.as_ref(), desired.map(shortcut), |next| {
            store.persist(next)
        })
    }

    fn assert_actual(
        manager: &Manager<FakeRegistry>,
        os: &Rc<RefCell<FakeOs>>,
        saved: &Option<Shortcut>,
        expected: &[&str],
    ) {
        let mut tracked = manager
            .status(saved.as_ref())
            .registered
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let mut actual = os.borrow().keys.values().cloned().collect::<Vec<_>>();
        let mut expected = expected
            .iter()
            .map(|key| key.to_string())
            .collect::<Vec<_>>();
        tracked.sort();
        actual.sort();
        expected.sort();
        assert_eq!(tracked, expected);
        assert_eq!(tracked, actual, "reported registrations must match the OS");
    }

    #[test]
    fn canonical_shortcuts_roundtrip_and_reserved_or_ambiguous_keys_are_rejected() {
        let key = shortcut(" shift + ctrl + alt + f24 ");
        assert_eq!(key.as_str(), "Ctrl+Alt+Shift+F24");
        assert_eq!(
            serde_json::to_string(&key).unwrap(),
            "\"Ctrl+Alt+Shift+F24\""
        );
        assert_eq!(
            serde_json::from_str::<Shortcut>("\"alt+ctrl+l\"").unwrap(),
            shortcut(OLD)
        );
        for value in [
            "Ctrl+L",
            "Win+Ctrl+L",
            "Ctrl+Alt+F12",
            "Ctrl+Ctrl+L",
            "Ctrl+Alt+F01",
            "Ctrl+Alt+F25",
            "Ctrl+Alt+F0",
            "Ctrl+Alt+Delete",
            "Ctrl+Alt++",
            "Ctrl+Alt+😀",
            "L+Ctrl+Alt",
            "",
        ] {
            assert!(
                value.parse::<Shortcut>().is_err(),
                "unexpectedly accepted {value}"
            );
        }
        for value in [
            "Ctrl+Alt+0",
            "Alt+Shift+Z",
            "Ctrl+Shift+F1",
            "Ctrl+Alt+F11",
            "Ctrl+Alt+F13",
        ] {
            assert!(
                value.parse::<Shortcut>().is_ok(),
                "unexpectedly rejected {value}"
            );
        }
    }

    #[test]
    fn empty_default_and_unknown_ids_never_claim_registration() {
        let (manager, os, store) = fixture(None);
        assert_actual(&manager, &os, &store.saved, &[]);
        assert!(store.events.borrow().is_empty());
        assert!(!manager.handles(REGISTRATION_IDS[0]));
        assert!(!manager.handles(-1));
        assert!(!manager.handles(0));
        assert!(manager.status(None).error.is_none());
    }

    #[test]
    fn startup_conflict_keeps_saved_preference_and_can_retry_same_key() {
        let (mut manager, os, mut store) = fixture(None);
        store.saved = Some(shortcut(OLD));
        os.borrow_mut().fail_register.push_back(OLD.into());
        assert!(manager.initialize(store.saved.as_ref()).is_err());
        let status = manager.status(store.saved.as_ref());
        assert_eq!(status.saved, Some(shortcut(OLD)));
        assert!(status.error.is_some());
        assert_actual(&manager, &os, &store.saved, &[]);
        replace(&mut manager, &mut store, Some(OLD)).unwrap();
        assert_eq!(store.attempts, 0);
        assert_actual(&manager, &os, &store.saved, &[OLD]);
    }

    #[test]
    fn replacement_registers_then_saves_then_releases_old_key() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        replace(&mut manager, &mut store, Some(NEW)).unwrap();
        assert_eq!(
            *store.events.borrow(),
            vec![
                format!("register:{NEW}"),
                format!("save:{NEW}"),
                format!("unregister:{OLD}")
            ]
        );
        assert_eq!(store.saved, Some(shortcut(NEW)));
        assert_eq!(store.revision, 21);
        assert_actual(&manager, &os, &store.saved, &[NEW]);
        assert!(!manager.handles(REGISTRATION_IDS[0]));
        assert!(manager.handles(REGISTRATION_IDS[1]));
    }

    #[test]
    fn same_key_neither_saves_nor_registers_twice() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        replace(&mut manager, &mut store, Some(OLD)).unwrap();
        assert!(store.events.borrow().is_empty());
        assert_eq!(store.revision, 20);
        assert_actual(&manager, &os, &store.saved, &[OLD]);
    }

    #[test]
    fn registration_conflict_does_not_save_or_release_existing_key() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        os.borrow_mut().fail_register.push_back(NEW.into());
        assert!(replace(&mut manager, &mut store, Some(NEW)).is_err());
        assert_eq!(store.attempts, 0);
        assert_eq!(store.saved, Some(shortcut(OLD)));
        assert_actual(&manager, &os, &store.saved, &[OLD]);
    }

    #[test]
    fn failed_save_revokes_candidate_and_preserves_old_preference() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        store.faults.push_back((1, SaveFault::BeforeWrite));
        assert!(replace(&mut manager, &mut store, Some(NEW)).is_err());
        assert_eq!(store.saved, Some(shortcut(OLD)));
        assert_eq!(store.revision, 20);
        assert_actual(&manager, &os, &store.saved, &[OLD]);
        assert_eq!(
            *store.events.borrow(),
            vec![
                format!("register:{NEW}"),
                format!("save:{NEW}"),
                format!("unregister:{NEW}")
            ]
        );
    }

    #[test]
    fn failed_candidate_cleanup_reports_both_keys_and_clear_releases_them() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        store.faults.push_back((1, SaveFault::BeforeWrite));
        os.borrow_mut()
            .fail_unregister
            .push_back(REGISTRATION_IDS[1]);
        let error = replace(&mut manager, &mut store, Some(NEW)).unwrap_err();
        assert!(error.contains("候选快捷键未释放"));
        assert_actual(&manager, &os, &store.saved, &[OLD, NEW]);
        assert!(manager.handles(REGISTRATION_IDS[0]) && manager.handles(REGISTRATION_IDS[1]));
        assert!(replace(&mut manager, &mut store, Some("Ctrl+Alt+K")).is_err());
        assert_eq!(
            store.attempts, 1,
            "no further candidate while cleanup is pending"
        );
        replace(&mut manager, &mut store, None).unwrap();
        assert_eq!(store.saved, None);
        assert_actual(&manager, &os, &store.saved, &[]);
        assert!(manager.status(None).error.is_none());
    }

    #[test]
    fn old_release_failure_revokes_candidate_and_compensates_with_new_revision() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        os.borrow_mut()
            .fail_unregister
            .push_back(REGISTRATION_IDS[0]);
        assert!(replace(&mut manager, &mut store, Some(NEW)).is_err());
        assert_eq!(store.saved, Some(shortcut(OLD)));
        assert_eq!(store.revision, 22, "compensation is a new durable commit");
        assert_actual(&manager, &os, &store.saved, &[OLD]);
        assert_eq!(
            *store.events.borrow(),
            vec![
                format!("register:{NEW}"),
                format!("save:{NEW}"),
                format!("unregister:{OLD}"),
                format!("unregister:{NEW}"),
                format!("save:{OLD}")
            ]
        );
    }

    #[test]
    fn failed_compensation_reports_new_saved_preference_and_old_actual_key() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        os.borrow_mut()
            .fail_unregister
            .push_back(REGISTRATION_IDS[0]);
        store.faults.push_back((2, SaveFault::BeforeWrite));
        let error = replace(&mut manager, &mut store, Some(NEW)).unwrap_err();
        assert!(error.contains("原快捷键偏好未恢复"));
        assert_eq!(store.revision, 21);
        assert_eq!(
            manager.status(store.saved.as_ref()).saved,
            Some(shortcut(NEW))
        );
        assert_actual(&manager, &os, &store.saved, &[OLD]);
        replace(&mut manager, &mut store, Some(NEW)).unwrap();
        assert_eq!(
            store.revision, 21,
            "saved key retry only repairs registration"
        );
        assert_actual(&manager, &os, &store.saved, &[NEW]);
    }

    #[test]
    fn failed_old_and_candidate_release_keep_both_registrations_visible() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        os.borrow_mut().fail_unregister.extend(REGISTRATION_IDS);
        assert!(replace(&mut manager, &mut store, Some(NEW)).is_err());
        assert_eq!(store.saved, Some(shortcut(OLD)));
        assert_eq!(store.revision, 22);
        assert_actual(&manager, &os, &store.saved, &[OLD, NEW]);
    }

    #[test]
    fn error_after_durable_save_is_compensated_without_rewinding_revision() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        store.faults.push_back((1, SaveFault::AfterWrite));
        assert!(replace(&mut manager, &mut store, Some(NEW)).is_err());
        assert_eq!(store.saved, Some(shortcut(OLD)));
        assert_eq!(store.revision, 22);
        assert_actual(&manager, &os, &store.saved, &[OLD]);
    }

    #[test]
    fn clear_saves_empty_before_release_and_release_failure_restores_saved_key() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        os.borrow_mut()
            .fail_unregister
            .push_back(REGISTRATION_IDS[0]);
        assert!(replace(&mut manager, &mut store, None).is_err());
        assert_eq!(store.saved, Some(shortcut(OLD)));
        assert_eq!(store.revision, 22);
        assert_actual(&manager, &os, &store.saved, &[OLD]);
        assert_eq!(
            *store.events.borrow(),
            vec![
                "save:empty".into(),
                format!("unregister:{OLD}"),
                format!("save:{OLD}")
            ]
        );
        replace(&mut manager, &mut store, None).unwrap();
        assert_eq!(store.saved, None);
        assert_actual(&manager, &os, &store.saved, &[]);
    }

    #[test]
    fn partial_clear_failure_restores_previously_released_registrations() {
        let (mut manager, os, mut store) = fixture(Some(OLD));
        store.faults.push_back((1, SaveFault::BeforeWrite));
        os.borrow_mut()
            .fail_unregister
            .push_back(REGISTRATION_IDS[1]);
        assert!(replace(&mut manager, &mut store, Some(NEW)).is_err());
        assert_actual(&manager, &os, &store.saved, &[OLD, NEW]);
        os.borrow_mut()
            .fail_unregister
            .push_back(REGISTRATION_IDS[1]);
        assert!(replace(&mut manager, &mut store, None).is_err());
        assert_eq!(store.saved, Some(shortcut(OLD)));
        assert_actual(&manager, &os, &store.saved, &[OLD, NEW]);
        replace(&mut manager, &mut store, None).unwrap();
        assert_actual(&manager, &os, &store.saved, &[]);
    }

    #[test]
    fn shutdown_retains_failed_ids_for_retry_and_drop_releases_remaining_keys() {
        let (mut manager, os, store) = fixture(Some(OLD));
        os.borrow_mut()
            .fail_unregister
            .push_back(REGISTRATION_IDS[0]);
        assert!(manager.shutdown().is_err());
        assert_actual(&manager, &os, &store.saved, &[OLD]);
        manager.shutdown().unwrap();
        assert_actual(&manager, &os, &store.saved, &[]);
        manager.initialize(store.saved.as_ref()).unwrap();
        drop(manager);
        assert!(os.borrow().keys.is_empty());
    }
}
