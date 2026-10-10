fn main() {
    if std::env::args().any(|arg| arg == "--api-only") {
        std::process::exit(opentranslate_lib::serve_api_blocking());
    }
    opentranslate_lib::run()
}
