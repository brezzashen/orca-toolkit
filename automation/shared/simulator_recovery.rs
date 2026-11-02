//! Private on-disk recovery protocol shared by the watchdog and Xcode gateway.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct App {
    pub bundle: String,
    pub path: PathBuf,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recovery {
    pub source: String,
    pub target: Option<String>,
    pub phase: String,
    pub at: u64,
    pub detail: String,
    pub apps: Vec<App>,
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub started: bool,
    #[serde(default)]
    pub fault_device: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Registry {
    pub cases: BTreeMap<String, Recovery>,
}

pub fn directory() -> PathBuf {
    std::env::var_os("SIM_RECOVERY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                .join(".local/state/sim-render-watchdog")
        })
}

pub fn valid_udid(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

#[derive(Debug)]
pub struct Lock(Option<File>);
impl Lock {
    pub fn take(path: &Path) -> Result<Self> {
        let parent = path.parent().context("lock has no parent")?;
        std::fs::create_dir_all(parent)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)?;
        // SAFETY: file owns a valid descriptor; nonblocking flock never waits on another process.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("simulator operation is busy; retry after the current operation finishes");
        }
        file.set_len(0)?;
        writeln!(file, "{}", std::process::id())?;
        Ok(Self(Some(file)))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        if let Some(file) = &self.0 {
            // SAFETY: this lock owns the descriptor until the end of drop.
            unsafe {
                libc::flock(file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

pub fn device_lock(dir: &Path, udid: &str) -> Result<Lock> {
    if !valid_udid(udid) {
        bail!("an explicit simulator UUID is required");
    }
    Lock::take(&dir.join(format!("device-{}.lock", udid.to_ascii_uppercase())))
}

pub fn nested_device_lock(dir: &Path, udid: &str) -> Result<Lock> {
    match device_lock(dir, udid) {
        Ok(lock) => Ok(lock),
        Err(error) => {
            let path = dir.join(format!("device-{}.lock", udid.to_ascii_uppercase()));
            let holder = std::fs::read_to_string(path)
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok());
            let mut pid = std::process::id();
            for _ in 0..12 {
                let output = std::process::Command::new("/bin/ps")
                    .args(["-o", "ppid=", "-p", &pid.to_string()])
                    .output()?;
                let Some(parent) = std::str::from_utf8(&output.stdout)
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok())
                else {
                    break;
                };
                if Some(parent) == holder {
                    return Ok(Lock(None));
                }
                if parent <= 1 || parent == pid {
                    break;
                }
                pid = parent;
            }
            Err(error)
        }
    }
}

pub fn load(dir: &Path) -> Result<Registry> {
    match std::fs::read(dir.join("recovery.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .context("invalid simulator recovery state; refusing automation"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
        Err(error) => Err(error.into()),
    }
}

pub fn save(dir: &Path, state: &Registry) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(state)?;
    let tmp = dir.join("recovery.json.tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    std::fs::rename(tmp, dir.join("recovery.json"))?;
    Ok(())
}

pub fn check(state: &Registry, udid: &str) -> Result<()> {
    for recovery in state.cases.values() {
        if recovery.source.eq_ignore_ascii_case(udid)
            || recovery
                .target
                .as_deref()
                .is_some_and(|target| target.eq_ignore_ascii_case(udid))
        {
            if !matches!(recovery.phase.as_str(), "restarted" | "moved") {
                bail!("simulator {}: {} ({}). No action was replayed. Use sim-render-watchdog status.",
                    udid, recovery.phase, recovery.detail);
            }
            if recovery.source.eq_ignore_ascii_case(udid) {
                if let Some(target) = &recovery.target {
                    bail!("simulator moved from {udid} to {target}; set the new simulatorId/--udid and inspect its UI before another action. No action was replayed.");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "7588F756-F687-4398-B128-57ECE8EBF854";
    #[test]
    fn locks_are_exclusive_and_released() {
        let dir = tempfile::tempdir().unwrap();
        let lock = device_lock(dir.path(), ID).unwrap();
        assert!(device_lock(dir.path(), ID).is_err());
        drop(lock);
        assert!(device_lock(dir.path(), ID).is_ok());
        assert!(device_lock(dir.path(), "../../escape").is_err());
    }
    #[test]
    fn failed_or_partial_state_never_allows_actions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("recovery.json"), "{").unwrap();
        assert!(load(dir.path()).is_err());
    }
    #[test]
    fn migration_requires_explicit_target_and_blocks_during_recovery() {
        let mut state = Registry::default();
        state.cases.insert(
            ID.into(),
            Recovery {
                source: ID.into(),
                target: Some("other".into()),
                phase: "recovering".into(),
                at: 1,
                detail: "test".into(),
                apps: vec![],
                stage: String::new(),
                started: false,
                fault_device: None,
            },
        );
        assert!(check(&state, ID).is_err());
        assert!(check(&state, "other").is_err());
        state.cases.get_mut(ID).unwrap().phase = "moved".into();
        assert!(check(&state, ID).unwrap_err().to_string().contains("moved"));
        assert!(check(&state, "other").is_ok());
    }
}
