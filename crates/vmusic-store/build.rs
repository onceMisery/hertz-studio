// SPDX-License-Identifier: MIT

fn main() {
    // sqlx::migrate! 需要在新增迁移文件时重新展开，已有文件的 include_str! 不能发现新增项。
    println!("cargo:rerun-if-changed=../../migrations");
}
