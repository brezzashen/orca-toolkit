//! Authenticated local Orca IPC shared by orca-account-launch and orca-fkey-tap.
//! No paired environments, SSH, or remote fallback.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::Path,
    time::Duration,
};

pub struct Rpc {
    pub(crate) socket: String,
    pub(crate) token: String,
}

// Distinguishes requests from one long-lived process (orca-fkey-tap makes many).
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Rpc {
    pub fn local(home: &Path) -> Result<Self> {
        let path = home.join("Library/Application Support/orca/orca-runtime.json");
        let metadata: Value =
            serde_json::from_slice(&fs::read(&path).context("read local Orca runtime")?)?;
        let transport = metadata["transports"]
            .as_array()
            .and_then(|items| items.iter().find(|t| t["kind"] == "unix"))
            .or_else(|| (metadata["transport"]["kind"] == "unix").then_some(&metadata["transport"]))
            .context("local Orca Unix socket unavailable; open Orca on this Mac")?;
        Ok(Self {
            socket: transport["endpoint"]
                .as_str()
                .context("Unix socket endpoint")?
                .into(),
            token: metadata["authToken"]
                .as_str()
                .context("local authentication token")?
                .into(),
        })
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        let mut stream = UnixStream::connect(&self.socket).context("connect local Orca")?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        let id = format!("account-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let request = json!({"id":id,"authToken":self.token,"method":method,"params":params});
        writeln!(stream, "{request}")?;
        stream.set_nonblocking(true)?;
        let mut pending = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if std::time::Instant::now() >= deadline {
                bail!("local Orca {method} timed out; request is not retried");
            }
            let Some(end) = pending.iter().position(|byte| *byte == b'\n') else {
                read_ready(&mut stream, &mut pending, deadline, method)?;
                continue;
            };
            let line: Vec<u8> = pending.drain(..=end).collect();
            let response: Value = serde_json::from_slice(&line)?;
            if response["_keepalive"] == true {
                continue;
            }
            if response["id"] != id {
                bail!("unexpected Orca response id");
            }
            if response["ok"] != true {
                bail!(
                    "Orca {method}: {}",
                    response["error"]["message"]
                        .as_str()
                        .unwrap_or("request refused")
                );
            }
            return Ok(response["result"].clone());
        }
    }
}

fn read_ready(
    stream: &mut UnixStream,
    pending: &mut Vec<u8>,
    deadline: std::time::Instant,
    method: &str,
) -> Result<()> {
    let mut fd = libc::pollfd {
        fd: stream.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    // poll also wakes for peer shutdown, so buffered final frames remain readable on Darwin.
    let ready = unsafe { libc::poll(&mut fd, 1, remaining.as_millis().max(1) as i32) };
    if ready < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            return Ok(());
        }
        return Err(error).context("poll local Orca socket");
    }
    if ready == 0 {
        bail!("local Orca {method} timed out; request is not retried");
    }
    let mut bytes = [0; 8192];
    match stream.read(&mut bytes) {
        Ok(0) => bail!("local Orca closed {method}; request is not retried"),
        Ok(size) => pending.extend_from_slice(&bytes[..size]),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            ) =>
        {
            return Ok(())
        }
        Err(error) => return Err(error).context("read local Orca socket"),
    }
    anyhow::ensure!(pending.len() <= 16 * 1024 * 1024, "Orca response too large");
    Ok(())
}
