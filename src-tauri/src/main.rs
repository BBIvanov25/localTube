#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::State;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "ogv", "ogg", "mkv", "avi", "mpg", "mpeg", "wmv", "3gp", "mts",
    "m2ts",
];

#[derive(Clone, Deserialize)]
struct SharedVideo {
    key: String,
    path: String,
    title: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    thumbnail: String,
}

#[derive(Clone)]
struct VideoFile {
    metadata: SharedVideo,
    path: PathBuf,
    size: u64,
    modified: u64,
}

struct ShareState {
    stop: Option<Arc<Mutex<bool>>>,
    address: Option<String>,
    root: Option<PathBuf>,
    files: Option<Arc<Mutex<HashMap<String, VideoFile>>>>,
}

#[derive(Serialize)]
struct ShareInfo {
    url: String,
}

#[derive(Deserialize)]
struct LoginBody {
    password: String,
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(ShareState {
            stop: None,
            address: None,
            root: None,
            files: None,
        }))
        .invoke_handler(tauri::generate_handler![
            pick_share_folder,
            start_lan_share,
            stop_lan_share,
            update_lan_share_metadata
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LocalTube");
}

#[tauri::command]
fn pick_share_folder() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("Choose the folder to share")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn start_lan_share(
    root: String,
    password: String,
    library_json: String,
    state: State<'_, Mutex<ShareState>>,
) -> Result<ShareInfo, String> {
    if password.trim().len() < 4 {
        return Err("The LAN sharing password must be at least 4 characters.".into());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("The shared folder is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err("The shared path is not a folder.".into());
    }
    let library: Vec<SharedVideo> = serde_json::from_str(&library_json)
        .map_err(|_| "The local library metadata is invalid.".to_string())?;
    let files = scan_library(&root, &library)?;

    stop_server(&state)?;
    let server = Server::http((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("Could not start LAN sharing: {error}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|address| address.port())
        .unwrap_or(0);
    let token = Uuid::new_v4().simple().to_string();
    let stop = Arc::new(Mutex::new(false));
    let thread_stop = Arc::clone(&stop);
    let shared_root = root.clone();
    let thread_token = token.clone();
    let shared_files = Arc::new(Mutex::new(files));
    let thread_files = Arc::clone(&shared_files);
    thread::spawn(move || {
        serve_requests(
            server,
            shared_root,
            thread_files,
            password,
            thread_token,
            thread_stop,
        );
    });

    let address = format!(
        "http://{}:{}/",
        local_ipv4().unwrap_or(Ipv4Addr::LOCALHOST),
        port
    );
    let mut current = state
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
    current.stop = Some(stop);
    current.address = Some(address.clone());
    current.root = Some(root);
    current.files = Some(shared_files);
    Ok(ShareInfo { url: address })
}

#[tauri::command]
fn update_lan_share_metadata(
    library_json: String,
    state: State<'_, Mutex<ShareState>>,
) -> Result<(), String> {
    let (root, files) = {
        let current = state
            .lock()
            .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
        (current.root.clone(), current.files.clone())
    };
    let Some(root) = root else {
        return Ok(());
    };
    let Some(files) = files else {
        return Ok(());
    };
    let library: Vec<SharedVideo> = serde_json::from_str(&library_json)
        .map_err(|_| "The local library metadata is invalid.".to_string())?;
    let refreshed = scan_library(&root, &library)?;
    *files
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())? = refreshed;
    Ok(())
}

#[tauri::command]
fn stop_lan_share(state: State<'_, Mutex<ShareState>>) -> Result<(), String> {
    stop_server(&state)
}

fn stop_server(state: &State<'_, Mutex<ShareState>>) -> Result<(), String> {
    let mut current = state
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
    if let Some(stop) = current.stop.take() {
        if let Ok(mut value) = stop.lock() {
            *value = true;
        }
    }
    current.address = None;
    current.root = None;
    current.files = None;
    Ok(())
}

fn local_ipv4() -> Option<Ipv4Addr> {
    std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .ok()
        .and_then(|socket| {
            socket.connect(("8.8.8.8", 80)).ok()?;
            match socket.local_addr().ok()?.ip() {
                std::net::IpAddr::V4(address) if !address.is_loopback() => Some(address),
                _ => None,
            }
        })
}

fn scan_library(
    root: &Path,
    library: &[SharedVideo],
) -> Result<HashMap<String, VideoFile>, String> {
    let mut metadata_by_path = HashMap::new();
    for item in library {
        metadata_by_path.insert(normalize_path(&item.path), item.clone());
    }
    let mut result = HashMap::new();
    scan_directory(root, root, &metadata_by_path, &mut result)?;
    Ok(result)
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    metadata_by_path: &HashMap<String, SharedVideo>,
    result: &mut HashMap<String, VideoFile>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not read the shared folder: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect the shared folder: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            scan_directory(root, &path, metadata_by_path, result)?;
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !VIDEO_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Could not map a shared video path.".to_string())?;
        let relative_path = normalize_path(&format!(
            "{}/{}",
            root.file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("videos"),
            relative.to_string_lossy()
        ));
        let metadata = metadata_by_path
            .get(&relative_path)
            .cloned()
            .unwrap_or_else(|| SharedVideo {
                key: relative_path.clone(),
                path: relative_path.clone(),
                title: path
                    .file_stem()
                    .and_then(|v| v.to_str())
                    .unwrap_or("Video")
                    .to_string(),
                duration: 0.0,
                width: 0,
                height: 0,
                thumbnail: String::new(),
            });
        let details = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect a shared video: {error}"))?;
        let modified = details
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        result.insert(
            relative_path,
            VideoFile {
                metadata,
                path,
                size: details.len(),
                modified,
            },
        );
    }
    Ok(())
}

fn serve_requests(
    server: Server,
    _root: PathBuf,
    files: Arc<Mutex<HashMap<String, VideoFile>>>,
    password: String,
    token: String,
    stop: Arc<Mutex<bool>>,
) {
    loop {
        if stop.lock().map(|value| *value).unwrap_or(true) {
            break;
        }
        match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(request)) => handle_request(request, &files, &password, &token),
            Ok(None) => continue,
            Err(_) => break,
        }
    }
}

fn handle_request(
    mut request: Request,
    files: &Arc<Mutex<HashMap<String, VideoFile>>>,
    password: &str,
    token: &str,
) {
    let url = request.url().to_string();
    if url == "/" {
        return respond_text(
            request,
            200,
            include_str!("../../public/remote.html"),
            "text/html; charset=utf-8",
        );
    }
    if url == "/remote.js" {
        return respond_text(
            request,
            200,
            include_str!("../../public/remote.js"),
            "text/javascript; charset=utf-8",
        );
    }
    if url == "/remote.css" {
        return respond_text(
            request,
            200,
            include_str!("../../public/remote.css"),
            "text/css; charset=utf-8",
        );
    }
    if url == "/api/login" && request.method() == &Method::Post {
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            return respond_text(request, 400, "Invalid request.", "text/plain");
        }
        let valid = serde_json::from_str::<LoginBody>(&body)
            .map(|value| value.password == password)
            .unwrap_or(false);
        if valid {
            return respond_json(request, 200, &serde_json::json!({ "token": token }));
        }
        return respond_text(request, 401, "Incorrect password.", "text/plain");
    }
    if !authorized(&url, &request, token) {
        return respond_text(request, 401, "Authentication required.", "text/plain");
    }
    if url.starts_with("/api/library") {
        let files = files
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let items: Vec<_> = files.values().map(|file| {
            serde_json::json!({
                "key": file.metadata.key,
                "path": file.metadata.path,
                "title": file.metadata.title,
                "duration": file.metadata.duration,
                "width": file.metadata.width,
                "height": file.metadata.height,
                "size": file.size,
                "modified": file.modified,
                "thumbnail": if file.metadata.thumbnail.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(format!("/api/thumb/{}?token={}", encode_path(&file.metadata.path), token)) },
                "video": format!("/api/video/{}?token={}", encode_path(&file.metadata.path), token)
            })
        }).collect();
        return respond_json(request, 200, &items);
    }
    if let Some(path) = url.strip_prefix("/api/video/").and_then(path_from_url) {
        return stream_file(request, files, &path);
    }
    if let Some(path) = url.strip_prefix("/api/thumb/").and_then(path_from_url) {
        if let Some(file) = files
            .lock()
            .ok()
            .and_then(|files| files.get(&path).cloned())
        {
            if let Some(data) = file
                .metadata
                .thumbnail
                .strip_prefix("data:image/jpeg;base64,")
            {
                if let Ok(bytes) = decode_base64(data) {
                    return respond_bytes(request, 200, bytes, "image/jpeg");
                }
            }
        }
        return respond_text(request, 404, "Thumbnail not found.", "text/plain");
    }
    respond_text(request, 404, "Not found.", "text/plain");
}

fn authorized(url: &str, request: &Request, token: &str) -> bool {
    request.headers().iter().any(|header| {
        header.field.equiv("Authorization") && header.value.as_str() == format!("Bearer {token}")
    }) || url
        .split_once("?")
        .map(|(_, query)| {
            query
                .split('&')
                .any(|item| item == format!("token={token}"))
        })
        .unwrap_or(false)
}

fn path_from_url(value: &str) -> Option<String> {
    Some(decode_path(value.split('?').next()?).ok()?)
}

fn stream_file(request: Request, files: &Arc<Mutex<HashMap<String, VideoFile>>>, path: &str) {
    let Some(file) = files.lock().ok().and_then(|files| files.get(path).cloned()) else {
        return respond_text(request, 404, "Video not found.", "text/plain");
    };
    let Ok(mut source) = File::open(&file.path) else {
        return respond_text(request, 404, "Video is no longer available.", "text/plain");
    };
    let start = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .and_then(|header| {
            header
                .value
                .as_str()
                .strip_prefix("bytes=")
                .and_then(|value| value.split('-').next()?.parse::<u64>().ok())
        })
        .unwrap_or(0)
        .min(file.size.saturating_sub(1));
    let end = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .and_then(|header| {
            header
                .value
                .as_str()
                .strip_prefix("bytes=")
                .and_then(|value| value.split('-').nth(1)?.parse::<u64>().ok())
        })
        .unwrap_or_else(|| file.size.saturating_sub(1))
        .min(file.size.saturating_sub(1));
    if start > end || source.seek(SeekFrom::Start(start)).is_err() {
        return respond_text(request, 416, "Invalid byte range.", "text/plain");
    }
    let mut bytes = vec![0; (end - start + 1) as usize];
    if source.read_exact(&mut bytes).is_err() {
        return respond_text(request, 404, "Video could not be read.", "text/plain");
    }
    let content_type = mime_type(&file.path);
    let mut response = Response::from_data(bytes)
        .with_status_code(if start == 0 && end + 1 == file.size {
            200
        } else {
            206
        })
        .with_header(Header::from_bytes("Content-Type", content_type).unwrap())
        .with_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap())
        .with_header(
            Header::from_bytes(
                "Content-Range",
                format!("bytes {start}-{end}/{}", file.size),
            )
            .unwrap(),
        );
    response
        .add_header(Header::from_bytes("Content-Length", (end - start + 1).to_string()).unwrap());
    let _ = request.respond(response);
}

fn respond_text(request: Request, status: u16, body: &str, content_type: &str) {
    let response = Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", content_type).unwrap());
    let _ = request.respond(response);
}

fn respond_json(request: Request, status: u16, body: &impl Serialize) {
    let response =
        Response::from_string(serde_json::to_string(body).unwrap_or_else(|_| "{}".into()))
            .with_status_code(StatusCode(status))
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
    let _ = request.respond(response);
}

fn respond_bytes(request: Request, status: u16, body: Vec<u8>, content_type: &str) {
    let response = Response::from_data(body)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", content_type).unwrap());
    let _ = request.respond(response);
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn encode_path(path: &str) -> String {
    path.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn decode_path(path: &str) -> Result<String, ()> {
    let mut output = Vec::new();
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            output.push(u8::from_str_radix(&path[index + 1..index + 3], 16).map_err(|_| ())?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    Ok(String::from_utf8(output).map_err(|_| ())?)
}

fn decode_base64(value: &str) -> Result<Vec<u8>, ()> {
    let mut output = Vec::new();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in value.bytes().filter(|byte| *byte != b'=') {
        let value = alphabet.iter().position(|item| *item == byte).ok_or(())? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(output)
}

fn mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "webm" => "video/webm",
        "ogg" | "ogv" => "video/ogg",
        "m4v" => "video/x-m4v",
        "mov" => "video/quicktime",
        _ => "video/mp4",
    }
}
