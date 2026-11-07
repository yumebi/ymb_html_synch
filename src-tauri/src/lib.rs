mod fsops;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, State};

/// 画面側(JS)が操作してよいローカルのルートフォルダ。`set_root` で決まり、
/// ファイル操作は、必ずこの中の相対パスで行う(ルートの外には、触れない)。
#[derive(Default)]
struct RootState(Mutex<Option<PathBuf>>);

impl RootState {
    fn get(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .map_err(|_| "内部エラー(ロック)".to_string())?
            .clone()
            .ok_or_else(|| "ローカルルートが設定されていません".to_string())
    }
}

#[tauri::command]
fn set_root(state: State<RootState>, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let canonical = std::fs::canonicalize(&p).map_err(|_| "ローカルルートのフォルダが見つかりません".to_string())?;
    if !canonical.is_dir() {
        return Err("ローカルルートはフォルダを指定してください".into());
    }
    // Windows の `\\?\` 接頭辞は、表示に使うパスから外す。
    let display = canonical.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let clean = PathBuf::from(&display);
    *state.0.lock().map_err(|_| "内部エラー(ロック)".to_string())? = Some(clean);
    Ok(display)
}

#[tauri::command]
fn list_html(state: State<RootState>, start_rel: String) -> Result<Vec<String>, String> {
    let root = state.get()?;
    Ok(fsops::list_html(&root, &start_rel))
}

#[tauri::command]
fn local_path(state: State<RootState>, rel: String) -> Result<String, String> {
    let root = state.get()?;
    let p = fsops::resolve_in_root(&root, &rel)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn read_local(state: State<RootState>, rel: String) -> Result<String, String> {
    let root = state.get()?;
    let p = fsops::resolve_in_root(&root, &rel)?;
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// ローカルのファイルを、サーバーの内容で書き換える。`backup` が真なら、初回だけ `.bak` を残す。
#[tauri::command]
fn write_local(state: State<RootState>, rel: String, text: String, backup: bool) -> Result<(), String> {
    let root = state.get()?;
    let p = fsops::resolve_in_root(&root, &rel)?;
    if backup {
        fsops::ensure_backup(&p).map_err(|e| e.to_string())?;
    }
    fsops::atomic_write(&p, text.as_bytes()).map_err(|e| e.to_string())
}

/// `.bak` があれば復元して、復元後の内容を返す。
#[tauri::command]
fn restore_local(state: State<RootState>, rel: String) -> Result<String, String> {
    let root = state.get()?;
    let p = fsops::resolve_in_root(&root, &rel)?;
    let bak = fsops::backup_path(&p);
    if !bak.exists() {
        return Err("バックアップが見つかりません".into());
    }
    std::fs::copy(&bak, &p).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
fn reveal(state: State<RootState>, rel: String) -> Result<(), String> {
    let root = state.get()?;
    let p = fsops::resolve_in_root(&root, &rel)?;
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct FetchError {
    message: String,
    status: Option<u16>,
}

fn fetch_err(message: impl Into<String>, status: Option<u16>) -> FetchError {
    FetchError { message: message.into(), status }
}

/// 公開サーバーのテキストを取る。Basic 認証・タイムアウト・サイズ上限を守る。
/// エラーメッセージは、Electron 版と同じ文言にしてある。
#[tauri::command]
async fn fetch_text(url: String, auth: Option<String>, timeout_ms: u64, max_bytes: u64) -> Result<String, FetchError> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| fetch_err("URL が正しくありません", None))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(fetch_err("http:// または https:// の URL だけ指定できます", None));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .user_agent("ymb-html-sync")
        .build()
        .map_err(|e| fetch_err(e.to_string(), None))?;
    let mut req = client.get(parsed);
    if let Some(a) = auth.filter(|a| !a.is_empty()) {
        req = req.header(reqwest::header::AUTHORIZATION, a);
    }
    let mut res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            fetch_err(format!("タイムアウトしました({}秒以内に応答がありませんでした)", timeout_ms / 1000), None)
        } else {
            fetch_err(e.to_string(), None)
        }
    })?;
    let status = res.status();
    if !status.is_success() {
        let mut msg = format!("HTTPステータス {} が返されました", status.as_u16());
        if status.as_u16() == 401 {
            msg.push_str("(Basic認証に失敗している可能性があります)");
        } else if status.as_u16() == 404 {
            msg.push_str("(サーバーにページが存在しない可能性があります)");
        }
        return Err(fetch_err(msg, Some(status.as_u16())));
    }
    let too_large = || fetch_err(format!("レスポンスが大きすぎます({}MB上限)", max_bytes / (1024 * 1024)), None);
    if res.content_length().map(|n| n > max_bytes).unwrap_or(false) {
        return Err(too_large());
    }
    let mut body: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                if (body.len() + chunk.len()) as u64 > max_bytes {
                    return Err(too_large());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                if e.is_timeout() {
                    return Err(fetch_err(
                        format!("タイムアウトしました({}秒以内に応答がありませんでした)", timeout_ms / 1000),
                        None,
                    ));
                }
                return Err(fetch_err(e.to_string(), None));
            }
        }
    }
    Ok(String::from_utf8_lossy(&body).to_string())
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 二重起動を防ぐ。2つ開くと、同じフォルダへの同期や復元が同時に走って、書き込みが競合する。
        // 2つ目の起動では、先に起動している本体を前面に出す。単一起動のプラグインは、先に登録する。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // ウインドウの位置・大きさ・最大化の状態を保存して、次回の起動で復元する。
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(RootState::default())
        .invoke_handler(tauri::generate_handler![
            set_root,
            list_html,
            local_path,
            read_local,
            write_local,
            restore_local,
            reveal,
            fetch_text,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
