//! Sets and verifies the current Codex thread name through app-server JSON-RPC. Port of
//! `codex.ts`: spawns `$CODEX_APP_SERVER_BIN` (default `codex`) as `app-server --stdio`, speaks
//! newline-delimited JSON on its stdin/stdout, and sends, in order: `initialize` (id 1), the
//! `initialized` notification, `thread/name/set` (id 2) and `thread/read` (id 3). The read-back
//! name must equal the requested title. The whole exchange is bounded by 10 seconds.

use crate::{env_nonempty, errno_name};
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(10);
const STDERR_TAIL_CHARS: usize = 1000;

#[derive(Serialize)]
struct Request<'a, P: Serialize> {
    id: u64,
    method: &'a str,
    params: P,
}

#[derive(Serialize)]
struct Notification<'a, P: Serialize> {
    method: &'a str,
    params: P,
}

#[derive(Serialize)]
struct Empty {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    client_info: ClientInfo,
    capabilities: Empty,
}

#[derive(Serialize)]
struct ClientInfo {
    name: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NameSetParams<'a> {
    thread_id: &'a str,
    name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams<'a> {
    thread_id: &'a str,
    include_turns: bool,
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `response.error.message || "Codex RPC failed"`.
fn error_message(error: &Value) -> String {
    match error.get("message") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f != 0.0) => n.to_string(),
        Some(other @ (Value::Array(_) | Value::Object(_))) => other.to_string(),
        _ => "Codex RPC failed".to_string(),
    }
}

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Arc<Mutex<String>>,
    stderr_done: Receiver<()>,
    deadline: Instant,
    next_id: u64,
    exited: bool,
}

impl Session {
    fn spawn() -> Result<Self, String> {
        let bin = env_nonempty("CODEX_APP_SERVER_BIN").unwrap_or_else(|| "codex".to_string());
        let mut child = Command::new(&bin)
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn {bin} {}", errno_name(&e)))?;

        let stdout = child.stdout.take().expect("piped stdout");
        let (line_tx, lines) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if buf.last() == Some(&b'\n') {
                            buf.pop();
                        }
                        if buf.last() == Some(&b'\r') {
                            buf.pop();
                        }
                        if line_tx.send(String::from_utf8_lossy(&buf).into_owned()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let stderr = Arc::new(Mutex::new(String::new()));
        let (done_tx, stderr_done) = mpsc::channel();
        let mut err_pipe = child.stderr.take().expect("piped stderr");
        let tail = Arc::clone(&stderr);
        thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = err_pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut text = tail.lock().unwrap_or_else(|p| p.into_inner());
                text.push_str(&String::from_utf8_lossy(&chunk[..n]));
                let count = text.chars().count();
                if count > STDERR_TAIL_CHARS {
                    let cut = text.char_indices().nth(count - STDERR_TAIL_CHARS).map_or(0, |(i, _)| i);
                    text.drain(..cut);
                }
            }
            let _ = done_tx.send(());
        });

        Ok(Self {
            stdin: child.stdin.take(),
            child,
            lines,
            stderr,
            stderr_done,
            deadline: Instant::now() + TIMEOUT,
            next_id: 0,
            exited: false,
        })
    }

    fn timed_out() -> String {
        "Codex title update timed out after 10 seconds".to_string()
    }

    fn write_line<T: Serialize>(&mut self, message: &T) -> Result<(), String> {
        let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
        line.push('\n');
        let stdin = self.stdin.as_mut().ok_or_else(|| "write EPIPE".to_string())?;
        let written = match stdin.write_all(line.as_bytes()) {
            Ok(()) => stdin.flush(),
            Err(e) => Err(e),
        };
        written.map_err(|e| {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                "write EPIPE".to_string()
            } else {
                e.to_string()
            }
        })
    }

    /// The app-server closed stdout: wait for its exit and report it like the TS `exit` handler.
    fn exited_error(&mut self) -> String {
        let code = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.exited = true;
                    break status.code().map_or_else(|| "null".to_string(), |c| c.to_string());
                }
                Ok(None) if Instant::now() >= self.deadline => return Self::timed_out(),
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(e) => return e.to_string(),
            }
        };
        let _ = self.stderr_done.recv_timeout(Duration::from_millis(500));
        let stderr = self.stderr.lock().unwrap_or_else(|p| p.into_inner()).clone();
        format!("Codex app-server exited ({code}): {}", stderr.trim())
    }

    fn request<P: Serialize>(&mut self, method: &str, params: P) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.write_line(&Request { id, method, params })?;
        loop {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Self::timed_out());
            }
            let line = match self.lines.recv_timeout(remaining) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => return Err(Self::timed_out()),
                Err(RecvTimeoutError::Disconnected) => return Err(self.exited_error()),
            };
            let Ok(response) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(response_id) = response.get("id") else { continue };
            if response_id.as_f64() != Some(id as f64) {
                continue;
            }
            return match response.get("error") {
                Some(error) if truthy(error) => Err(error_message(error)),
                _ => Ok(response.get("result").cloned().unwrap_or(Value::Null)),
            };
        }
    }

    fn exchange(&mut self, thread_id: &str, title: &str) -> Result<(), String> {
        self.request(
            "initialize",
            InitializeParams {
                client_info: ClientInfo { name: "session-title", version: "1.0.0" },
                capabilities: Empty {},
            },
        )?;
        self.write_line(&Notification { method: "initialized", params: Empty {} })?;
        self.request("thread/name/set", NameSetParams { thread_id, name: title })?;
        let result = self.request("thread/read", ReadParams { thread_id, include_turns: false })?;
        let name = result.get("thread").and_then(|t| t.get("name")).and_then(Value::as_str);
        if name != Some(title) {
            return Err("Codex title read-back did not match the requested title".to_string());
        }
        println!("codex thread: renamed and verified ({thread_id})");
        Ok(())
    }

    /// The TS `finally`: close stdin and SIGTERM the app-server.
    fn close(&mut self) {
        self.stdin.take();
        if !self.exited && matches!(self.child.try_wait(), Ok(None)) {
            // SAFETY: plain kill(2) on our own unreaped child.
            unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM) };
        }
    }
}

pub fn set_codex_title(thread_id: &str, title: &str) -> Result<(), String> {
    let mut session = Session::spawn()?;
    let outcome = session.exchange(thread_id, title);
    session.close();
    outcome
}
