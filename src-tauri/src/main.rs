#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::State;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

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
    #[serde(default)]
    size: u64,
    #[serde(default)]
    modified: u64,
}

#[derive(Clone)]
struct VideoFile {
    metadata: SharedVideo,
    path: PathBuf,
    size: u64,
    modified: u64,
    available: Vec<(u64, u64)>,
}

struct ShareState {
    stop: Option<Arc<Mutex<bool>>>,
    address: Option<String>,
    files: Option<Arc<Mutex<HashMap<String, VideoFile>>>>,
    staging_root: Option<PathBuf>,
    pending_files: Option<Arc<Mutex<HashMap<String, (u64, u64)>>>>,
}

#[derive(Serialize)]
struct ShareInfo {
    url: String,
    urls: Vec<String>,
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
            files: None,
            staging_root: None,
            pending_files: None,
        }))
        .invoke_handler(tauri::generate_handler![
            start_lan_share,
            stage_lan_share_file,
            get_lan_prepare_requests,
            register_lan_file,
            stop_lan_share,
            update_lan_share_metadata
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LocalTube");
}

#[tauri::command]
fn start_lan_share(
    password: String,
    library_json: String,
    file_paths_json: String,
    state: State<'_, Mutex<ShareState>>,
) -> Result<ShareInfo, String> {
    if password.trim().len() < 4 {
        return Err("The LAN sharing password must be at least 4 characters.".into());
    }
    let library: Vec<SharedVideo> = serde_json::from_str(&library_json)
        .map_err(|_| "The local library metadata is invalid.".to_string())?;
    let file_paths: HashMap<String, String> = serde_json::from_str(&file_paths_json)
        .map_err(|_| "The loaded library file paths are invalid.".to_string())?;
    let files = build_loaded_library(&library, &file_paths)?;

    stop_server(&state, false)?;
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
    let thread_token = token.clone();
    let shared_files = Arc::new(Mutex::new(files));
    let pending_files = Arc::new(Mutex::new(HashMap::new()));
    let thread_files = Arc::clone(&shared_files);
    let thread_pending = Arc::clone(&pending_files);
    thread::spawn(move || {
        serve_requests(
            server,
            thread_files,
            thread_pending,
            password,
            thread_token,
            thread_stop,
        );
    });

    let addresses = lan_ipv4s();
    if addresses.is_empty() {
        return Err("No active LAN IPv4 address was found. Connect the host to the same Wi-Fi or wired network as the other device and try again.".into());
    }
    let urls: Vec<String> = addresses
        .iter()
        .map(|address| format!("http://{address}:{port}/"))
        .collect();
    let address = urls[0].clone();
    let mut current = state
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
    current.stop = Some(stop);
    current.address = Some(address.clone());
    current.files = Some(shared_files);
    current.pending_files = Some(pending_files);
    Ok(ShareInfo { url: address, urls })
}

#[derive(Serialize)]
struct PrepareRequest {
    key: String,
    start: u64,
    end: u64,
}

#[tauri::command]
fn get_lan_prepare_requests(
    state: State<'_, Mutex<ShareState>>,
) -> Result<Vec<PrepareRequest>, String> {
    let pending = state
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?
        .pending_files
        .clone();
    let Some(pending) = pending else {
        return Ok(Vec::new());
    };
    let requests = pending
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?
        .drain()
        .map(|(key, (start, end))| PrepareRequest { key, start, end })
        .collect();
    Ok(requests)
}

#[tauri::command]
fn register_lan_file(
    key: String,
    path: String,
    state: State<'_, Mutex<ShareState>>,
) -> Result<(), String> {
    let files = state
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?
        .files
        .clone()
        .ok_or_else(|| "LAN sharing is not running.".to_string())?;
    let path = PathBuf::from(path);
    let details = fs::metadata(&path)
        .map_err(|error| format!("Could not access the prepared video: {error}"))?;
    let mut files = files
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
    let file = files
        .get_mut(&key)
        .ok_or_else(|| "The requested video is no longer in the library.".to_string())?;
    file.path = path;
    file.size = details.len();
    file.modified = details
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or(0);
    Ok(())
}

#[tauri::command]
fn stage_lan_share_file(
    key: String,
    file_name: String,
    offset: u64,
    total_size: u64,
    data: Vec<u8>,
    state: State<'_, Mutex<ShareState>>,
) -> Result<String, String> {
    let safe_name = Path::new(&file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The loaded video has an invalid filename.".to_string())?;
    let mut current = state
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
    let root = if let Some(root) = current.staging_root.clone() {
        root
    } else {
        let root = std::env::temp_dir().join(format!("localtube-lan-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not prepare LAN sharing storage: {error}"))?;
        current.staging_root = Some(root.clone());
        root
    };
    let path = root.join(safe_name);
    let mut file = if !path.exists() {
        File::create(&path).map_err(|error| format!("Could not prepare a shared video: {error}"))?
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|error| format!("Could not continue preparing a shared video: {error}"))?
    };
    if file.metadata().map(|details| details.len()).unwrap_or(0) != total_size {
        file.set_len(total_size)
            .map_err(|error| format!("Could not reserve the shared video: {error}"))?;
    }
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.write_all(&data))
        .map_err(|error| format!("Could not copy a loaded video for LAN sharing: {error}"))?;
    let files = current
        .files
        .clone()
        .ok_or_else(|| "LAN sharing is not running.".to_string())?;
    let mut files = files
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
    let shared = files
        .get_mut(&key)
        .ok_or_else(|| "The requested video is no longer in the library.".to_string())?;
    shared.path = path.clone();
    shared.size = total_size;
    add_available_range(
        &mut shared.available,
        offset,
        offset + data.len() as u64 - 1,
    );
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn update_lan_share_metadata(
    library_json: String,
    state: State<'_, Mutex<ShareState>>,
) -> Result<(), String> {
    let files = {
        let current = state
            .lock()
            .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
        current.files.clone()
    };
    let Some(files) = files else {
        return Ok(());
    };
    let library: Vec<SharedVideo> = serde_json::from_str(&library_json)
        .map_err(|_| "The local library metadata is invalid.".to_string())?;
    let mut files = files
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
    for metadata in library {
        if let Some(file) = files
            .values_mut()
            .find(|file| file.metadata.key == metadata.key || file.metadata.path == metadata.path)
        {
            file.metadata = metadata;
        }
    }
    Ok(())
}

#[tauri::command]
fn stop_lan_share(state: State<'_, Mutex<ShareState>>) -> Result<(), String> {
    stop_server(&state, true)
}

fn stop_server(state: &State<'_, Mutex<ShareState>>, clear_staging: bool) -> Result<(), String> {
    let mut current = state
        .lock()
        .map_err(|_| "LAN sharing state is unavailable.".to_string())?;
    if let Some(stop) = current.stop.take() {
        if let Ok(mut value) = stop.lock() {
            *value = true;
        }
    }
    current.address = None;
    current.files = None;
    current.pending_files = None;
    if clear_staging {
        if let Some(root) = current.staging_root.take() {
            if let Err(error) = fs::remove_dir_all(&root) {
                eprintln!("Could not remove temporary LAN sharing files: {error}");
            }
        }
    }
    Ok(())
}

fn lan_ipv4s() -> Vec<Ipv4Addr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            std::net::IpAddr::V4(address)
                if !address.is_loopback()
                    && !address.is_unspecified()
                    && !address.is_link_local() =>
            {
                Some(address)
            }
            _ => None,
        })
        .collect()
}

fn build_loaded_library(
    library: &[SharedVideo],
    file_paths: &HashMap<String, String>,
) -> Result<HashMap<String, VideoFile>, String> {
    let paths = library
        .iter()
        .filter_map(|item| {
            file_paths
                .get(&item.key)
                .or_else(|| file_paths.get(&item.path))
                .map(|path| (item.path.clone(), PathBuf::from(path)))
        })
        .collect();
    build_loaded_library_from_paths(library, &paths)
}

fn build_loaded_library_from_paths(
    library: &[SharedVideo],
    paths: &HashMap<String, PathBuf>,
) -> Result<HashMap<String, VideoFile>, String> {
    let mut result = HashMap::new();
    for metadata in library {
        let path = paths
            .get(&metadata.path)
            .or_else(|| paths.get(&metadata.key))
            .cloned()
            .unwrap_or_default();
        let details = fs::metadata(&path).ok();
        let modified = details
            .as_ref()
            .and_then(|details| {
                details
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|value| value.as_secs())
            })
            .unwrap_or(metadata.modified);
        result.insert(
            metadata.key.clone(),
            VideoFile {
                metadata: metadata.clone(),
                path: path.clone(),
                size: details
                    .as_ref()
                    .map(|details| details.len())
                    .unwrap_or(metadata.size),
                modified,
                available: if let Some(details) = &details {
                    vec![(0, details.len().saturating_sub(1))]
                } else {
                    Vec::new()
                },
            },
        );
    }
    if result.is_empty() {
        return Err("The loaded library is empty.".into());
    }
    Ok(result)
}

fn serve_requests(
    server: Server,
    files: Arc<Mutex<HashMap<String, VideoFile>>>,
    pending_files: Arc<Mutex<HashMap<String, (u64, u64)>>>,
    password: String,
    token: String,
    stop: Arc<Mutex<bool>>,
) {
    loop {
        if stop.lock().map(|value| *value).unwrap_or(true) {
            break;
        }
        match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(request)) => {
                let request_files = Arc::clone(&files);
                let request_pending = Arc::clone(&pending_files);
                let request_password = password.clone();
                let request_token = token.clone();
                thread::spawn(move || {
                    handle_request(
                        request,
                        &request_files,
                        &request_pending,
                        &request_password,
                        &request_token,
                    );
                });
            }
            Ok(None) => continue,
            Err(_) => break,
        }
    }
}

fn handle_request(
    mut request: Request,
    files: &Arc<Mutex<HashMap<String, VideoFile>>>,
    pending_files: &Arc<Mutex<HashMap<String, (u64, u64)>>>,
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
                "thumbnail": if file.metadata.thumbnail.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(format!("/api/thumb/{}?token={}", encode_path(&file.metadata.key), token)) },
                "video": format!("/api/video/{}?token={}", encode_path(&file.metadata.key), token)
            })
        }).collect();
        return respond_json(request, 200, &items);
    }
    if let Some(key) = url.strip_prefix("/api/video/").and_then(path_from_url) {
        return stream_file(request, files, pending_files, &key);
    }
    if let Some(key) = url.strip_prefix("/api/thumb/").and_then(path_from_url) {
        if let Some(file) = files.lock().ok().and_then(|files| files.get(&key).cloned()) {
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

fn stream_file(
    request: Request,
    files: &Arc<Mutex<HashMap<String, VideoFile>>>,
    pending_files: &Arc<Mutex<HashMap<String, (u64, u64)>>>,
    key: &str,
) {
    let Some(file) = files.lock().ok().and_then(|files| files.get(key).cloned()) else {
        return respond_text(request, 404, "Video not found.", "text/plain");
    };
    let range_header = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .map(|header| header.value.as_str());
    let range = range_header.and_then(|value| parse_range(value, file.size));
    if range_header.is_some() && range.is_none() {
        return respond_text(request, 416, "Invalid byte range.", "text/plain");
    }
    let (start, requested_end) = range.unwrap_or((0, file.size.saturating_sub(1)));
    let mut end = requested_end;
    if let Some((missing_start, missing_end)) = missing_range(&file, start, requested_end) {
        if missing_start == start {
            if let Ok(mut pending) = pending_files.lock() {
                pending.insert(file.metadata.key.clone(), (missing_start, missing_end));
            }
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut prepared = None;
            while Instant::now() < deadline {
                if let Some(updated) = files.lock().ok().and_then(|files| files.get(key).cloned()) {
                    if missing_range(&updated, missing_start, missing_end).is_none() {
                        prepared = Some(updated);
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(50));
            }
            let Some(updated) = prepared else {
                return respond_retry(request, "The host did not prepare the requested segment.");
            };
            let file = updated;
            end = missing_end.min(start.saturating_add(PREPARE_CHUNK_SIZE - 1));
            return stream_prepared_file(request, file, start, end, range.is_some());
        }
        end = (missing_start - 1).min(start.saturating_add(PREPARE_CHUNK_SIZE - 1));
    }
    stream_prepared_file(request, file, start, end, range.is_some());
}

fn stream_prepared_file(request: Request, file: VideoFile, start: u64, end: u64, has_range: bool) {
    let Ok(mut source) = File::open(&file.path) else {
        return respond_text(request, 404, "Video is no longer available.", "text/plain");
    };
    let partial = has_range || end + 1 < file.size;
    if request.method() == &Method::Head {
        let response = Response::empty(if partial {
            StatusCode(206)
        } else {
            StatusCode(200)
        })
        .with_header(Header::from_bytes("Content-Type", mime_type(&file.path)).unwrap())
        .with_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap())
        .with_header(Header::from_bytes("Content-Length", (end - start + 1).to_string()).unwrap());
        return if partial {
            request
                .respond(
                    response.with_header(
                        Header::from_bytes(
                            "Content-Range",
                            format!("bytes {start}-{end}/{}", file.size),
                        )
                        .unwrap(),
                    ),
                )
                .ok();
        } else {
            request.respond(response).ok();
        };
    }

    if start > end || source.seek(SeekFrom::Start(start)).is_err() {
        return respond_text(request, 416, "Invalid byte range.", "text/plain");
    }
    let mut bytes = vec![0; (end - start + 1) as usize];
    if source.read_exact(&mut bytes).is_err() {
        return respond_text(request, 404, "Video could not be read.", "text/plain");
    }
    let content_type = mime_type(&file.path);
    let mut response = Response::from_data(bytes)
        .with_status_code(if !partial { 200 } else { 206 })
        .with_header(Header::from_bytes("Content-Type", content_type).unwrap())
        .with_header(Header::from_bytes("Accept-Ranges", "bytes").unwrap());
    if partial {
        response.add_header(
            Header::from_bytes(
                "Content-Range",
                format!("bytes {start}-{end}/{}", file.size),
            )
            .unwrap(),
        );
    }
    response
        .add_header(Header::from_bytes("Content-Length", (end - start + 1).to_string()).unwrap());
    let _ = request.respond(response);
}

const PREPARE_CHUNK_SIZE: u64 = 2 * 1024 * 1024;

fn missing_range(file: &VideoFile, start: u64, end: u64) -> Option<(u64, u64)> {
    if start > end || file.size == 0 {
        return Some((start, end));
    }
    let mut cursor = start;
    while cursor <= end {
        if let Some((_, available_end)) =
            file.available
                .iter()
                .find(|(available_start, available_end)| {
                    *available_start <= cursor && *available_end >= cursor
                })
        {
            cursor = available_end.saturating_add(1);
        } else {
            return Some((
                cursor,
                end.min(cursor.saturating_add(PREPARE_CHUNK_SIZE - 1)),
            ));
        }
    }
    None
}

fn add_available_range(ranges: &mut Vec<(u64, u64)>, start: u64, end: u64) {
    if start > end {
        return;
    }
    ranges.push((start, end));
    ranges.sort_unstable_by_key(|range| range.0);
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges.drain(..) {
        if let Some((_, previous_end)) = merged.last_mut() {
            if start <= previous_end.saturating_add(1) {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    *ranges = merged;
}

fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let value = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(size);
        return Some((size - suffix, size - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= size {
        return None;
    }
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end).then_some((start, end))
}

fn respond_text(request: Request, status: u16, body: &str, content_type: &str) {
    let response = Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", content_type).unwrap());
    let _ = request.respond(response);
}

fn respond_retry(request: Request, body: &str) {
    let response = Response::from_string(body)
        .with_status_code(StatusCode(503))
        .with_header(Header::from_bytes("Content-Type", "text/plain").unwrap())
        .with_header(Header::from_bytes("Retry-After", "1").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
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

#[cfg(test)]
mod tests {
    use super::{add_available_range, missing_range, parse_range, VideoFile};
    use std::path::PathBuf;

    #[test]
    fn parses_open_ended_and_suffix_ranges() {
        assert_eq!(parse_range("bytes=100-", 1_000), Some((100, 999)));
        assert_eq!(parse_range("bytes=-200", 1_000), Some((800, 999)));
        assert_eq!(parse_range("bytes=100-199", 1_000), Some((100, 199)));
    }

    #[test]
    fn rejects_ranges_outside_the_file() {
        assert_eq!(parse_range("bytes=1000-", 1_000), None);
        assert_eq!(parse_range("bytes=200-100", 1_000), None);
        assert_eq!(parse_range("items=0-10", 1_000), None);
    }

    #[test]
    fn merges_overlapping_available_ranges() {
        let mut ranges = vec![(0, 99), (200, 299)];
        add_available_range(&mut ranges, 90, 210);
        assert_eq!(ranges, vec![(0, 299)]);
    }

    #[test]
    fn finds_only_the_first_missing_segment() {
        let file = VideoFile {
            metadata: super::SharedVideo {
                key: "key".into(),
                path: "video.mp4".into(),
                title: "Video".into(),
                duration: 0.0,
                width: 0,
                height: 0,
                thumbnail: String::new(),
                size: 1_000,
                modified: 0,
            },
            path: PathBuf::from("video.mp4"),
            size: 1_000,
            modified: 0,
            available: vec![(0, 99), (300, 399)],
        };
        assert_eq!(missing_range(&file, 0, 399), Some((100, 399)));
        assert_eq!(missing_range(&file, 300, 399), None);
    }
}
