//! Child-process helpers: every external tool runs async, with a deadline, and is killed when
//! the caller gives up – a hanging tool must never block the UI or pile up processes.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;

/// Runs `program args…` to completion within `limit`; the child is killed on timeout.
pub async fn run_with_timeout<I, S>(
    program: &str,
    args: I,
    limit: Duration,
) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut cmd = Command::new(program);
    cmd.args(args);
    output_with_timeout(cmd, program, limit).await
}

pub async fn output_with_timeout(
    mut cmd: Command,
    label: &str,
    limit: Duration,
) -> Result<Output, String> {
    cmd.kill_on_drop(true);
    match tokio::time::timeout(limit, cmd.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("{label} konnte nicht gestartet werden: {e}")),
        Err(_) => Err(format!(
            "{label}: Zeitüberschreitung nach {} s",
            limit.as_secs()
        )),
    }
}

/// `which`-like lookup in `$PATH` without spawning a process.
pub fn find_in_path(program: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let is_executable = |p: &Path| {
        p.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_and_times_out() {
        let ok = run_with_timeout("sh", ["-c", "echo hallo"], Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&ok.stdout).trim(), "hallo");
        let slow = run_with_timeout("sleep", ["5"], Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(slow.contains("Zeitüberschreitung"));
        let missing = run_with_timeout("gibt-es-nicht-slatedesk", ["x"], Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(missing.contains("nicht gestartet"));
    }

    #[test]
    fn finds_programs_in_path() {
        assert!(find_in_path("sh").is_some());
        assert!(find_in_path("gibt-es-nicht-slatedesk").is_none());
    }
}
