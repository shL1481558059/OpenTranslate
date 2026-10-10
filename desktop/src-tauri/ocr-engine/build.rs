fn main() {
    if let Ok(output) = std::process::Command::new("g++")
        .arg("-print-file-name=libstdc++.so")
        .output()
    {
        let path = String::from_utf8_lossy(&output.stdout);
        let path = path.trim();
        if let Some(dir) = std::path::Path::new(path).parent() {
            if dir.as_os_str().len() > 0 {
                println!("cargo:rustc-link-search=native={}", dir.display());
            }
        }
    }
}
