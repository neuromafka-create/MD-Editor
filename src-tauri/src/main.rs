#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedFile {
    path: String,
    content: String,
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

#[tauri::command]
async fn open_markdown_file() -> Result<Option<OpenedFile>, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "mdown", "txt"])
        .set_title("Открыть Markdown файл")
        .pick_file()
        .await;

    let Some(file) = file else {
        return Ok(None);
    };

    let path = file.path().to_path_buf();
    let content = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;

    Ok(Some(OpenedFile {
        path: path_to_string(path),
        content,
    }))
}

#[tauri::command]
async fn write_markdown_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_markdown_file_as(
    content: String,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .add_filter("Markdown", &["md"])
        .set_title("Сохранить Markdown файл");

    if let Some(name) = default_name.as_deref().filter(|value| !value.is_empty()) {
        dialog = dialog.set_file_name(name);
    } else {
        dialog = dialog.set_file_name("document.md");
    }

    let file = dialog.save_file().await;
    let Some(file) = file else {
        return Ok(None);
    };

    let path = file.path().to_path_buf();
    std::fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(Some(path_to_string(path)))
}

#[tauri::command]
async fn save_html_file_as(
    content: String,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .add_filter("HTML", &["html"])
        .set_title("Экспортировать в HTML");

    if let Some(name) = default_name.as_deref().filter(|value| !value.is_empty()) {
        dialog = dialog.set_file_name(name);
    } else {
        dialog = dialog.set_file_name("document.html");
    }

    let file = dialog.save_file().await;
    let Some(file) = file else {
        return Ok(None);
    };

    let path = file.path().to_path_buf();
    std::fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(Some(path_to_string(path)))
}

#[tauri::command]
async fn save_bytes_file_as(
    bytes: Vec<u8>,
    default_name: Option<String>,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let filter_name = filter_name.unwrap_or_else(|| "File".to_string());
    let extensions = extensions.unwrap_or_else(|| vec!["bin".to_string()]);
    let extension_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let dialog_title = title.unwrap_or_else(|| "Сохранить файл".to_string());

    let mut dialog = rfd::AsyncFileDialog::new()
        .add_filter(&filter_name, &extension_refs)
        .set_title(&dialog_title);

    if let Some(name) = default_name.as_deref().filter(|value| !value.is_empty()) {
        dialog = dialog.set_file_name(name);
    } else {
        let fallback = format!("document.{}", extensions.first().map(String::as_str).unwrap_or("bin"));
        dialog = dialog.set_file_name(&fallback);
    }

    let file = dialog.save_file().await;
    let Some(file) = file else {
        return Ok(None);
    };

    let path = file.path().to_path_buf();
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(Some(path_to_string(path)))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_markdown_file,
            write_markdown_file,
            save_markdown_file_as,
            save_html_file_as,
            save_bytes_file_as
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
