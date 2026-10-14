use std::path::Path;
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Re-run when HEAD moves: HEAD itself changes on checkout, the branch ref on commit/reset,
/// packed-refs after `git gc`. Only existing files are listed – a missing path would make
/// cargo re-run the build script on every build.
fn watch_git_refs() {
    let mut watched = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(branch_ref) = git(&["symbolic-ref", "-q", "HEAD"]) {
        watched.push(branch_ref);
    }
    for name in watched {
        if let Some(path) = git(&["rev-parse", "--git-path", &name]) {
            if Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
}

fn main() {
    let hash = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unbekannt".to_string());
    println!("cargo:rustc-env=SLATEDESK_GIT_HASH={hash}");
    watch_git_refs();

    tauri_build::build()
}
