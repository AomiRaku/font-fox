// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! Windows 11 Mica 背景控制。

use tauri::window::{Effect, EffectsBuilder, Window};
use windows_sys::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOW};

pub(crate) fn is_supported() -> bool {
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    let ok = unsafe { GetVersionExW(&mut info) };
    ok != 0 && info.dwMajorVersion >= 10 && info.dwBuildNumber >= 22000
}

#[tauri::command]
pub fn mica_supported() -> bool {
    is_supported()
}

#[tauri::command]
pub fn set_window_mica(window: Window, mode: String, dark: bool) -> Result<(), String> {
    if mode == "off" {
        return window
            .set_effects(None)
            .map_err(|err| format!("Failed to clear Mica: {err}"));
    }
    if !is_supported() {
        return Err("Mica is only supported on Windows 11.".to_string());
    }
    let effect = if dark { Effect::MicaDark } else { Effect::MicaLight };
    window
        .set_effects(EffectsBuilder::new().effect(effect).build())
        .map_err(|err| format!("Failed to apply Mica: {err}"))
}
