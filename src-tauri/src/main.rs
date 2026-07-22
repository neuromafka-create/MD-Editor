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

fn mime_from_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" | "jpe" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
}

/// Read a local image and return a data URL for WebView preview.
/// Avoids asset-protocol encoding/scope issues on Windows.
#[tauri::command]
fn read_local_image_data_url(path: String) -> Result<String, String> {
    let path = std::path::Path::new(&path);
    if !path.is_file() {
        return Err(format!("Файл не найден: {}", path.display()));
    }

    const MAX_BYTES: u64 = 25 * 1024 * 1024;
    let meta = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "Изображение слишком большое ({} МБ). Максимум 25 МБ.",
            meta.len() / (1024 * 1024)
        ));
    }

    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let mime = mime_from_path(path);
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Open a URL in the system default browser / handler.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Разрешены только http(s) URL".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        Err("Открытие URL не поддерживается на этой платформе".to_string())
    }
}

/// Download a Windows NSIS installer from `url` to a temp file and launch it.
#[tauri::command]
async fn download_and_run_installer(url: String) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Разрешены только http(s) URL".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("MD-Editor-Updater/1.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| error.to_string())?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("Не удалось скачать обновление: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Ошибка загрузки обновления: HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Не удалось прочитать файл обновления: {error}"))?;

    if bytes.len() < 1024 {
        return Err("Файл обновления слишком маленький — возможно, ссылка неверна".to_string());
    }

    let file_name = url
        .rsplit('/')
        .next()
        .filter(|s| s.to_lowercase().ends_with(".exe"))
        .unwrap_or("MD-Editor-update-setup.exe");

    let temp_path = std::env::temp_dir().join(file_name);
    std::fs::write(&temp_path, &bytes).map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&temp_path)
            .spawn()
            .map_err(|error| format!("Не удалось запустить установщик: {error}"))?;
        return Ok(temp_path.to_string_lossy().to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = temp_path;
        Err("Автоустановка доступна только в Windows-сборке".to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_markdown_file,
            write_markdown_file,
            save_markdown_file_as,
            save_html_file_as,
            save_bytes_file_as,
            read_local_image_data_url,
            open_external_url,
            download_and_run_installer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
