//! Local Orca IPC; the implementation is shared with orca-fkey-tap.
#[path = "../../../shared/orca_rpc.rs"]
mod shared;
pub use shared::Rpc;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::Write;
    use std::{
        io::{BufRead, BufReader},
        os::unix::net::UnixListener,
        thread,
    };

    fn server(reply: &'static str) -> (tempfile::TempDir, Rpc, thread::JoinHandle<Value>) {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("orca.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let task = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let response = reply.replace("REQUEST_ID", request["id"].as_str().unwrap());
            writeln!(stream, "{response}").unwrap();
            request
        });
        let rpc = Rpc {
            socket: socket.to_string_lossy().into(),
            token: "fixture-token".into(),
        };
        (dir, rpc, task)
    }

    #[test]
    fn authenticated_create_is_sent_once_and_keepalives_are_ignored() {
        // Exercise the Darwin close-after-reply race repeatedly, including a buffered heartbeat.
        for _ in 0..32 {
            let (_dir, rpc, task) = server("{\"_keepalive\":true}\n{\"id\":\"REQUEST_ID\",\"ok\":true,\"result\":{\"tab\":{\"terminal\":\"new\"}}}");
            let result = crate::launch::create(&rpc, json!({"worktree":"id:local"})).unwrap();
            assert_eq!(result["tab"]["terminal"], "new");
            let request = task.join().unwrap();
            assert_eq!(request["method"], "session.tabs.createTerminal");
            assert_eq!(request["authToken"], "fixture-token");
        }
    }

    #[test]
    fn rejected_or_ambiguous_mutations_are_not_retried() {
        let (_dir, rpc, task) =
            server("{\"id\":\"REQUEST_ID\",\"ok\":false,\"error\":{\"message\":\"denied\"}}");
        assert!(crate::launch::create(&rpc, json!({}))
            .unwrap_err()
            .to_string()
            .contains("denied"));
        task.join().unwrap();
    }

    #[test]
    fn mismatched_response_cannot_confirm_another_terminal() {
        let (_dir, rpc, task) = server("{\"id\":\"different\",\"ok\":true,\"result\":{}}");
        assert!(rpc
            .call("terminal.show", json!({}))
            .unwrap_err()
            .to_string()
            .contains("response id"));
        task.join().unwrap();
    }
}

