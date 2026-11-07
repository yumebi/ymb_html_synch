//! ローカルのファイル操作。画面側(JS)からは、選択済みのルートフォルダの中の、相対パスでしか触れない。
//! Electron 版の `htmlSync.js` と `atomicWrite.js` の、入出力の部分に相当する。

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 相対パス(`/` 区切り)を検証して、ルートの中のパスにする。
/// 空、絶対パス、`..`、ドライブ指定(`C:`)、`\` を含むものは、拒否する。
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("パスが空です".into());
    }
    if rel.contains('\\') {
        return Err("パスに \\ は使えません".into());
    }
    let mut out = root.to_path_buf();
    for part in Path::new(rel).components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err("ルートの外を指すパスは使えません".into()),
        }
    }
    if out == root {
        return Err("パスが空です".into());
    }
    Ok(out)
}

/// 先頭が `.` のものを除く `*.html` を、再帰的に列挙する(ルートからの相対パス、`/` 区切り、`start_rel` を含む)。
pub fn list_html(root: &Path, start_rel: &str) -> Vec<String> {
    let start = if start_rel.is_empty() {
        root.to_path_buf()
    } else {
        match resolve_in_root(root, start_rel) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        }
    };
    let mut out = Vec::new();
    if start.is_dir() {
        walk(&start, root, &mut out);
    }
    out.sort();
    out
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk(&path, root, out);
        } else if ft.is_file() && name.to_lowercase().ends_with(".html") {
            if let Ok(rel) = path.strip_prefix(root) {
                let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
                out.push(parts.join("/"));
            }
        }
    }
}

fn temp_path_for(file: &Path) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    file.with_file_name(format!(".{}.{}.{}.tmp", name, std::process::id(), nanos))
}

fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    // Windows では、ウイルス対策ソフトなどがファイルを一瞬つかんでいて、rename に失敗することがある。
    let mut attempt = 1u32;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let retryable = matches!(e.kind(), std::io::ErrorKind::PermissionDenied);
                if !retryable || attempt >= 6 {
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_millis(25 * attempt as u64));
                attempt += 1;
            }
        }
    }
}

/// 同じフォルダの一時ファイルに書き込み、ディスクに反映してから、rename で置き換える。
/// 途中で落ちても、元のファイルは壊れない。失敗したときは、一時ファイルを消す。
pub fn atomic_write(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = temp_path_for(file);
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        rename_with_retry(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `.bak` が無いときだけ、上書き前の内容を `.bak` に残す(初回のバックアップを、守る)。
pub fn ensure_backup(file: &Path) -> std::io::Result<()> {
    let mut bak = file.as_os_str().to_os_string();
    bak.push(".bak");
    let bak = PathBuf::from(bak);
    if !bak.exists() {
        fs::copy(file, &bak)?;
    }
    Ok(())
}

pub fn backup_path(file: &Path) -> PathBuf {
    let mut bak = file.as_os_str().to_os_string();
    bak.push(".bak");
    PathBuf::from(bak)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escape_and_absolute() {
        let root = Path::new("/r");
        assert!(resolve_in_root(root, "a/b.html").is_ok());
        assert!(resolve_in_root(root, "./a.html").is_ok());
        assert!(resolve_in_root(root, "../a.html").is_err());
        assert!(resolve_in_root(root, "a/../../b.html").is_err());
        assert!(resolve_in_root(root, "/etc/passwd").is_err());
        assert!(resolve_in_root(root, "a\\b.html").is_err());
        assert!(resolve_in_root(root, "").is_err());
        assert!(resolve_in_root(root, ".").is_err());
    }

    #[test]
    fn list_html_skips_dot_entries_and_non_html() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("index.html"), "a").unwrap();
        fs::write(root.join("Page.HTML"), "a").unwrap();
        fs::write(root.join("sub/x.html"), "a").unwrap();
        fs::write(root.join("sub/.hidden.html"), "a").unwrap();
        fs::write(root.join("sub/readme.txt"), "a").unwrap();
        fs::write(root.join(".git/y.html"), "a").unwrap();
        assert_eq!(list_html(root, ""), vec!["Page.HTML", "index.html", "sub/x.html"]);
        assert_eq!(list_html(root, "sub"), vec!["sub/x.html"]);
        assert!(list_html(root, "../outside").is_empty());
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("a.html");
        atomic_write(&file, "一回目".as_bytes()).unwrap();
        atomic_write(&file, "二回目".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "二回目");
        let names: Vec<String> = fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.html"]);
    }

    #[test]
    fn backup_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.html");
        fs::write(&file, "元の内容").unwrap();
        ensure_backup(&file).unwrap();
        fs::write(&file, "二回目の内容").unwrap();
        ensure_backup(&file).unwrap();
        assert_eq!(fs::read_to_string(backup_path(&file)).unwrap(), "元の内容");
    }
}
