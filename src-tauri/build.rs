fn main() {
    std::env::set_var("TAURI_SKIP_RESOURCE_GENERATION", "1");
    tauri_build::build()
}