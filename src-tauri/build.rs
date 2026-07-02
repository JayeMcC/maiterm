fn main() {
    // Capture the git commit (short SHA + dirty flag) at BUILD time so the
    // running app can log exactly which source it was built from — the fast
    // way to tell "is this the latest build?" during white-screen triage.
    let sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    let dirty = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    println!(
        "cargo:rustc-env=MAITERM_GIT_SHA={}{}",
        sha,
        if dirty { "-dirty" } else { "" }
    );
    // build.rs doesn't re-run on new commits by default; watch HEAD so the
    // embedded SHA never goes stale between builds.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");

    let mcp_cap_path = std::path::Path::new("capabilities/mcp-bridge.json");
    #[cfg(all(feature = "mcp-bridge", debug_assertions))]
    {
        let cap = r#"{
  "identifier": "mcp-bridge",
  "description": "enables MCP bridge for development",
  "windows": ["main"],
  "permissions": ["mcp-bridge:default"]
}"#;
        std::fs::write(mcp_cap_path, cap)
            .expect("failed to write mcp-bridge capability");
    }
    #[cfg(not(all(feature = "mcp-bridge", debug_assertions)))]
    {
        let _ = std::fs::remove_file(mcp_cap_path);
    }

    tauri_build::build()
}
