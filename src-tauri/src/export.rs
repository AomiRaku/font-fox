// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 将字体文件导出到用户选择的位置。

use std::ffi::OsString;
use std::fs;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::{FOLDERID_Desktop, SHGetKnownFolderPath};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLabels {
    pub title: String,
    pub folder_title: String,
    pub font_files: String,
    pub all_files: String,
    pub overwrite_message: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    /// 源字体文件路径。
    pub path: String,
    /// 不含扩展名的目标文件名，通常为「字体名-样式名」。
    pub file_name: String,
}

fn safe_file_name(raw: &str) -> String {
    let mut name: String = raw
        .trim()
        .chars()
        .map(|character| {
            if character < ' ' || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    name = name.trim_matches([' ', '.']).to_string();
    name = name.chars().take(120).collect();
    if name.is_empty() {
        return "font".to_string();
    }
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.iter().any(|word| name.eq_ignore_ascii_case(word)) {
        name.insert(0, '_');
    }
    name
}

fn unique_batch_name(base: String, used: &mut std::collections::HashSet<String>) -> String {
    if used.insert(base.to_lowercase()) {
        return base;
    }
    let (stem, extension) = base.rsplit_once('.').unwrap_or((base.as_str(), ""));
    for index in 2.. {
        let candidate = if extension.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!()
}

fn target_name(item: &ExportItem, source: &Path) -> String {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("ttf");
    format!("{}.{}", safe_file_name(&item.file_name), extension)
}

fn desktop_dir() -> Option<PathBuf> {
    let mut raw: *mut u16 = std::ptr::null_mut();
    let result =
        unsafe { SHGetKnownFolderPath(&FOLDERID_Desktop, 0, std::ptr::null_mut(), &mut raw) };
    if result < 0 || raw.is_null() {
        return None;
    }
    let mut length = 0usize;
    unsafe {
        while *raw.add(length) != 0 {
            length += 1;
        }
    }
    let path = PathBuf::from(OsString::from_wide(unsafe {
        std::slice::from_raw_parts(raw, length)
    }));
    unsafe { CoTaskMemFree(raw.cast()) };
    Some(path)
}
fn save_dialog(
    source: &Path,
    labels: &ExportLabels,
    name: &str,
) -> Result<Option<PathBuf>, String> {
    let folder = desktop_dir().or_else(|| source.parent().map(Path::to_path_buf));
    let mut dialog = FileDialog::new()
        .add_filter(&labels.font_files, &["ttf", "otf", "ttc", "fon", "fnt"])
        .add_filter(&labels.all_files, &["*"])
        .set_title(&labels.title);
    if let Some(folder) = folder {
        dialog = dialog.set_directory(folder);
    }
    dialog = dialog.set_file_name(name);
    Ok(dialog.save_file())
}

fn folder_dialog(labels: &ExportLabels) -> Result<Option<PathBuf>, String> {
    let mut dialog = FileDialog::new().set_title(&labels.folder_title);
    if let Some(desktop) = desktop_dir() {
        dialog = dialog.set_directory(desktop);
    }
    Ok(dialog.pick_folder())
}

fn confirm_overwrite(labels: &ExportLabels, count: usize) -> bool {
    if count == 0 {
        return true;
    }
    let message = labels
        .overwrite_message
        .replace("{count}", &count.to_string());
    MessageDialog::new()
        .set_title(&labels.title)
        .set_description(&message)
        .set_level(MessageLevel::Warning)
        .set_buttons(MessageButtons::YesNo)
        .show()
        == MessageDialogResult::Yes
}

fn unique_items(items: Vec<ExportItem>) -> Vec<ExportItem> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(item.path.clone()))
        .collect()
}

/// 单个字体弹出保存文件窗口；多个字体弹出选择文件夹窗口。
pub fn export(mut items: Vec<ExportItem>, labels: &ExportLabels) -> Result<usize, String> {
    items = unique_items(items);
    if items.is_empty() {
        return Ok(0);
    }

    if items.len() == 1 {
        let item = &items[0];
        let source = Path::new(&item.path);
        if !source.is_file() {
            return Err(format!("Font file does not exist: {}", source.display()));
        }
        let default_name = target_name(item, source);
        let Some(target) = save_dialog(source, labels, &default_name)? else {
            return Ok(0);
        };
        fs::copy(source, &target)
            .map_err(|err| format!("Failed to export {}: {err}", default_name))?;
        return Ok(1);
    }

    let Some(folder) = folder_dialog(labels)? else {
        return Ok(0);
    };

    let mut copies = Vec::with_capacity(items.len());
    let mut used_names = std::collections::HashSet::new();
    for item in &items {
        let source = Path::new(&item.path);
        if !source.is_file() {
            return Err(format!("Font file does not exist: {}", source.display()));
        }
        let name = unique_batch_name(target_name(item, source), &mut used_names);
        copies.push((source, folder.join(&name), name));
    }
    let conflicts = copies
        .iter()
        .filter(|(_, target, _)| target.exists())
        .count();
    if !confirm_overwrite(labels, conflicts) {
        return Ok(0);
    }

    for (source, target, name) in copies {
        fs::copy(source, &target).map_err(|err| format!("Failed to export {name}: {err}"))?;
    }
    Ok(items.len())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_export_names() {
        assert_eq!(safe_file_name("Font-Regular"), "Font-Regular");
        assert_eq!(safe_file_name("A/B:C*D?"), "A_B_C_D_");
        assert_eq!(safe_file_name("  .  "), "font");
        assert_eq!(safe_file_name("CON"), "_CON");
    }

    #[test]
    fn disambiguates_batch_names() {
        let mut used = std::collections::HashSet::new();
        assert_eq!(unique_batch_name("A.ttf".into(), &mut used), "A.ttf");
        assert_eq!(unique_batch_name("A.ttf".into(), &mut used), "A (2).ttf");
        assert_eq!(unique_batch_name("A.ttf".into(), &mut used), "A (3).ttf");
    }

    #[test]
    fn keeps_source_extension() {
        let item = ExportItem {
            path: "C:\\fonts\\demo.otf".to_string(),
            file_name: "Demo-Regular".to_string(),
        };
        assert_eq!(
            target_name(&item, Path::new(&item.path)),
            "Demo-Regular.otf"
        );
    }
}
