//! Resolves an F-key account to the shell line its new tab runs, and Orca's New Terminal chord.
//! Mirrors `accountCommand` and `terminalChord` in `~/.orca/account-shortcuts/shortcut-launch.mjs`,
//! which the macOS Services path still uses; keep both in step.

use anyhow::{bail, Context, Result};
use serde_json::Value;

/// The bare account alias plus the Chat flag, e.g. `cl5 --chat`. This Mac's shell defines every
/// alias, so a local tab never needs the probing fallback that sparse remote hosts use.
pub fn local_command(config: &Value, requested: &str) -> Result<String> {
    let name = requested.to_uppercase();
    let aliases = config["aliases"].as_object();
    let id = aliases.and_then(|map| map.get(&name)).and_then(Value::as_str).unwrap_or(&name);
    let account = config["accounts"].get(id).with_context(|| format!("unknown account {requested}"))?;
    let alias = aliases
        .and_then(|map| map.iter().find(|(_, value)| value.as_str() == Some(id)))
        .map(|(alias, _)| alias.to_lowercase())
        .filter(|alias| !alias.is_empty() && alias.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
        .with_context(|| format!("missing safe alias for account {id}"))?;
    let chat = if account["viewMode"] == "chat" { " --chat" } else { "" };
    Ok(format!("{alias}{chat}"))
}

#[derive(Debug, PartialEq)]
pub struct Chord {
    pub label: String,
    pub key_code: u16,
    pub flags: u64,
}

/// Parses the darwin `tab.newTerminal` binding from `~/.orca/keybindings.json`.
pub fn terminal_chord(bindings: &Value) -> Result<Chord> {
    let label = bindings["platforms"]["darwin"]["tab.newTerminal"][0]
        .as_str()
        .or_else(|| bindings["keybindings"]["tab.newTerminal"][0].as_str())
        .context("bind tab.newTerminal in ~/.orca/keybindings.json")?;
    let mut parts: Vec<&str> = label.split('+').collect();
    let key = parts.pop().unwrap_or_default().to_uppercase();
    const KEYS: &str = "ASDFHGZXCV BQWERYT";
    let key_code = match key.as_str() {
        "O" => 31, "U" => 32, "I" => 34, "P" => 35, "L" => 37, "J" => 38, "K" => 40, "N" => 45, "M" => 46,
        k if k.len() == 1 && k != " " => match KEYS.find(k) {
            Some(index) => index as u16,
            None => bail!("unsupported chord {label}"),
        },
        _ => bail!("unsupported chord {label}"),
    };
    let mut flags = 0;
    for part in parts {
        flags |= match part {
            "Shift" => 0x20000,
            "Ctrl" => 0x40000,
            "Alt" | "Option" => 0x80000,
            "Cmd" | "Mod" => 0x100000,
            _ => bail!("unsupported chord {label}"),
        };
    }
    Ok(Chord { label: label.to_owned(), key_code, flags })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accounts_resolve_to_their_alias_and_chat_flag() {
        let config = json!({
            "aliases": { "CL5": "A5", "CO2": "C2" },
            "accounts": { "A5": { "viewMode": "chat" }, "C2": {}, "X9": {} }
        });
        assert_eq!(local_command(&config, "A5").unwrap(), "cl5 --chat");
        assert_eq!(local_command(&config, "cl5").unwrap(), "cl5 --chat");
        assert_eq!(local_command(&config, "C2").unwrap(), "co2");
        assert!(local_command(&config, "X9").is_err());
        assert!(local_command(&config, "ZZ").is_err());
    }

    #[test]
    fn chords_match_the_javascript_key_table() {
        let bindings = json!({ "platforms": { "darwin": { "tab.newTerminal": ["Ctrl+Alt+T"] } } });
        assert_eq!(terminal_chord(&bindings).unwrap(), Chord { label: "Ctrl+Alt+T".into(), key_code: 17, flags: 0xC0000 });
        let codes = [("A", 0), ("S", 1), ("V", 9), ("B", 11), ("Q", 12), ("Y", 16), ("N", 45), ("M", 46)];
        for (key, code) in codes {
            let bindings = json!({ "keybindings": { "tab.newTerminal": [format!("Cmd+{key}")] } });
            assert_eq!(terminal_chord(&bindings).unwrap().key_code, code, "{key}");
        }
        assert!(terminal_chord(&json!({ "keybindings": { "tab.newTerminal": ["Hyper+T"] } })).is_err());
        assert!(terminal_chord(&json!({})).is_err());
    }
}
