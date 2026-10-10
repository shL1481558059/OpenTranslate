use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SERVICE: &str = "OpenTranslate";
const ACCOUNT: &str = "translation-api-key";

pub fn load(settings_path: &Path) -> String {
    let from_file = read_file(settings_path);
    if !from_file.is_empty() {
        return from_file;
    }
    keyring_get().unwrap_or_default()
}

pub fn store(settings_path: &Path, key: &str) -> Result<(), String> {
    if key.is_empty() {
        let _ = fs::remove_file(secret_path(settings_path));
        let _ = keyring_delete();
        return Ok(());
    }
    if keyring_set(key) {
        let _ = fs::remove_file(secret_path(settings_path));
        return Ok(());
    }
    write_file(settings_path, key)
}

fn secret_path(settings_path: &Path) -> PathBuf {
    settings_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("api-key")
}

fn read_file(settings_path: &Path) -> String {
    fs::read_to_string(secret_path(settings_path))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn write_file(settings_path: &Path, key: &str) -> Result<(), String> {
    let path = secret_path(settings_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "无法创建 API Key 保存目录。".to_string())?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| "无法保存 API Key。".to_string())?;
    file.write_all(key.as_bytes()).map_err(|_| "无法保存 API Key。".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn keyring_likely() -> bool {
    #[cfg(test)]
    {
        return false;
    }
    #[cfg(all(target_os = "linux", not(test)))]
    {
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
    }
    #[cfg(all(not(target_os = "linux"), not(test)))]
    {
        true
    }
}

fn keyring_get() -> Option<String> {
    if !keyring_likely() {
        return None;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| {
            let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
            entry.get_password().ok()
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(Duration::from_millis(800)).ok().flatten()
}

fn keyring_set(key: &str) -> bool {
    if !keyring_likely() {
        return false;
    }
    let key = key.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ok = (|| {
            let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
            entry.set_password(&key)?;
            Ok::<(), keyring::Error>(())
        })()
        .is_ok();
        let _ = tx.send(ok);
    });
    rx.recv_timeout(Duration::from_millis(800)).unwrap_or(false)
}

fn keyring_delete() -> bool {
    if !keyring_likely() {
        return false;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ok = (|| {
            let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
            entry.delete_credential()?;
            Ok::<(), keyring::Error>(())
        })()
        .is_ok();
        let _ = tx.send(ok);
    });
    rx.recv_timeout(Duration::from_millis(800)).unwrap_or(false)
}
