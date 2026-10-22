// rust-embed 要求目录存在；前端未构建时嵌入空目录
fn main() {
    let _ = std::fs::create_dir_all("../web/dist");
    println!("cargo:rerun-if-changed=../web/dist");
}
