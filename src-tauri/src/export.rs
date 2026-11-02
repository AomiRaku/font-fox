// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 羽梦千景 Raku Inkyetta

//! 将字体文件导出到用户选择的位置。

use std::fs;
use std::path::{Path, PathBuf};

use rfd::FileDialog;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLabels {
    pub title: String,
    pub folder_title: String,
    pub font_files: String,
    pub all_files: String,
}

fn save_dialog(source: &Path, labels: &ExportLabels) -> Result<Option<PathBuf>, String> {
    let folder = source.parent().map(Path::to_path_buf);
    let mut dialog = FileDialog::new()
        .add_filter(&labels.font_files, &["ttf", "otf", "ttc", "fon", "fnt"])
        .add_filter(&labels.all_files, &["*"])
        .set_title(&labels.title);
    if let Some(folder) = folder {
        dialog = dialog.set_directory(folder);
    }
    if let Some(name) = source.file_name().and_then(|name| name.to_str()) {
        dialog = dialog.set_file_name(name);
    }
    Ok(dialog.save_file())
}

fn folder_dialog(labels: &ExportLabels) -> Result<Option<PathBuf>, String> {
    Ok(FileDialog::new().set_title(&labels.folder_title).pick_folder())
}

fn unique_paths(paths: Vec<String>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

/// 单个字体弹出保存文件窗口；多个字体弹出选择文件夹窗口。
pub fn export(paths: Vec<String>, labels: &ExportLabels) -> Result<usize, String> {
    let sources = unique_paths(paths);
    if sources.is_empty() {
        return Ok(0);
    }

    if sources.len() == 1 {
        let source = &sources[0];
        if !source.is_file() {
            return Err(format!("Font file does not exist: {}", source.display()));
        }
        let Some(target) = save_dialog(source, labels)? else {
            return Ok(0);
        };
        fs::copy(source, &target).map_err(|err| {
            format!(
                "Failed to export {}: {err}",
                source.file_name().unwrap_or_default().to_string_lossy()
            )
        })?;
        return Ok(1);
    }

    let Some(folder) = folder_dialog(labels)? else {
        return Ok(0);
    };
    let mut exported = 0usize;
    for source in &sources {
        if !source.is_file() {
            return Err(format!("Font file does not exist: {}", source.display()));
        }
        let name = source.file_name().ok_or_else(|| {
            format!("Invalid font file path: {}", source.display())
        })?;
        let target = folder.join(name);
        fs::copy(source, &target).map_err(|err| {
            format!("Failed to export {}: {err}", name.to_string_lossy())
        })?;
        exported += 1;
    }
    Ok(exported)
}
