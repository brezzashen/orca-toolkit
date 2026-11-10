//! Maps a plain function-key press to the account id whose Service claims it in `accounts.json`.
//!
//! `accounts.json` stores each Service key as an AppKit key equivalent: optional modifier prefixes
//! (`@` Command, `^` Control, `~` Option, `$` Shift) and one key character. F1-F12 are the
//! private-use characters U+F704-U+F70F. Only modifier-free function keys are taken over here,
//! because those are the keys a focused xterm turns into escape sequences.

use serde_json::Value;

/// macOS virtual key codes for F1-F12, in order.
const FUNCTION_KEY_CODES: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
const F1_KEY_EQUIVALENT: u32 = 0xF704;
const KEY_CODE_T: u16 = 17;

// CGEventFlags masks for the modifiers that make a chord, not a plain key.
const SHIFT_FLAG: u64 = 0x0002_0000;
const COMMAND_FLAG: u64 = 0x0010_0000;
const MODIFIER_MASK: u64 = SHIFT_FLAG | 0x0004_0000 | 0x0008_0000 | COMMAND_FLAG;

/// Returns the 1-based function-key number for a virtual key code.
pub fn function_key_number(key_code: u16) -> Option<u8> {
    FUNCTION_KEY_CODES.iter().position(|&code| code == key_code).map(|index| index as u8 + 1)
}

/// True when Shift, Control, Option or Command is held. Fn and NumericPad do not count:
/// macOS sets the Fn flag on every function-key event.
pub fn has_chord_modifier(flags: u64) -> bool {
    flags & MODIFIER_MASK != 0
}

/// True when `Shift+Cmd+T` (with no Control or Option) is pressed (`tab.reopenClosed`).
pub fn is_reopen_closed_chord(key_code: u16, flags: u64) -> bool {
    key_code == KEY_CODE_T && (flags & MODIFIER_MASK) == (SHIFT_FLAG | COMMAND_FLAG)
}

/// Returns the function-key number of a plain AppKit key equivalent such as "\u{F704}" (F1).
fn plain_function_key(key_equivalent: &str) -> Option<u8> {
    let mut chars = key_equivalent.chars();
    let only = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    let offset = (only as u32).checked_sub(F1_KEY_EQUIVALENT)?;
    (offset < 12).then(|| offset as u8 + 1)
}

/// Finds the account whose primary or extra shortcut is the plain function key `number`.
pub fn account_for_function_key(accounts: &Value, number: u8) -> Option<String> {
    let map = accounts.get("accounts")?.as_object()?;
    for (id, account) in map {
        let primary = account.get("key").and_then(Value::as_str);
        let extras = account
            .get("extraShortcuts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|shortcut| shortcut.get("key").and_then(Value::as_str));
        if primary.into_iter().chain(extras).any(|key| plain_function_key(key) == Some(number)) {
            return Some(id.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shipped_template_fills_f1_to_f12() {
        let accounts: Value =
            serde_json::from_str(include_str!("../../../../account-shortcuts/accounts.json")).unwrap();
        let slots = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "C1", "C2", "AG1", "AG2", "G1"];
        for (index, id) in slots.iter().enumerate() {
            assert_eq!(account_for_function_key(&accounts, index as u8 + 1).as_deref(), Some(*id));
        }
    }

    #[test]
    fn maps_virtual_key_codes_to_function_numbers() {
        assert_eq!(function_key_number(122), Some(1));
        assert_eq!(function_key_number(98), Some(7));
        assert_eq!(function_key_number(101), Some(9));
        assert_eq!(function_key_number(0), None);
    }

    #[test]
    fn fn_flag_alone_is_not_a_chord() {
        assert!(!has_chord_modifier(0x0080_0000 | 0x0020_0000));
        assert!(has_chord_modifier(0x0080_0000 | 0x0010_0000));
        assert!(has_chord_modifier(0x0004_0000));
    }

    #[test]
    fn detects_shift_cmd_t_reopen_chord() {
        assert!(is_reopen_closed_chord(17, 0x0002_0000 | 0x0010_0000));
        assert!(is_reopen_closed_chord(17, 0x0002_0000 | 0x0010_0000 | 0x0080_0000));
        assert!(!is_reopen_closed_chord(17, 0x0010_0000));
        assert!(!is_reopen_closed_chord(17, 0x0002_0000 | 0x0010_0000 | 0x0008_0000));
        assert!(!is_reopen_closed_chord(122, 0x0002_0000 | 0x0010_0000));
    }

    #[test]
    fn resolves_primary_and_extra_plain_function_keys() {
        let accounts = json!({
            "accounts": {
                "A1": { "key": "\u{F704}" },
                "C1": { "key": "\u{F708}" },
                "AG1": { "key": "", "extraShortcuts": [{ "key": "\u{F70A}" }] },
                "T": { "key": "@t" },
                "X": { "key": "@\u{F705}" }
            }
        });
        assert_eq!(account_for_function_key(&accounts, 1).as_deref(), Some("A1"));
        assert_eq!(account_for_function_key(&accounts, 5).as_deref(), Some("C1"));
        assert_eq!(account_for_function_key(&accounts, 7).as_deref(), Some("AG1"));
        // Command+F2 is a chord the terminal never swallows; it stays with its Service.
        assert_eq!(account_for_function_key(&accounts, 2), None);
        assert_eq!(account_for_function_key(&accounts, 12), None);
    }
}
