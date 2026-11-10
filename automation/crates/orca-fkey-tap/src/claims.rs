//! The terminal claim ledger `runtime/claimed-terminals.json`, shared with the JavaScript Services
//! path (`shortcut-guard.mjs`): a terminal that received one account alias never receives another.

use anyhow::{Context, Result};
use serde_json::json;
use std::fs::OpenOptions;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// `claimed-terminals.json`: JSON strings `[environment, handle]`, shared with shortcut-guard.mjs.
pub struct Claims {
    path: PathBuf,
    entries: Vec<String>,
}

impl Claims {
    pub fn load(path: &Path) -> Result<Self> {
        let entries = match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str::<Vec<String>>(&text)
                .context("invalid shortcut terminal claims; refusing to reuse a terminal")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self { path: path.to_owned(), entries })
    }

    fn key(handle: &str) -> String {
        json!([null, handle]).to_string()
    }

    pub fn has(&self, handle: &str) -> bool {
        self.entries.contains(&Self::key(handle))
    }

    pub fn claim(&mut self, handle: &str) -> Result<()> {
        self.entries.push(Self::key(handle));
        let start = self.entries.len().saturating_sub(4096);
        self.entries.drain(..start);
        let temporary = self.path.with_extension(format!("json.{}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true).mode(0o600);
        std::io::Write::write_all(&mut options.open(&temporary)?, serde_json::to_string(&self.entries)?.as_bytes())?;
        std::fs::rename(&temporary, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_corrupt_ledger_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claims.json");
        std::fs::write(&path, "{\"x\":1}").unwrap();
        assert!(Claims::load(&path).is_err());
    }
}
