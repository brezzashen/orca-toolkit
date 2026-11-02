//! orca-fkey-tap: lets the Orca account function keys (F1-F9) open a new account terminal while a
//! terminal has focus, run by `~/Library/LaunchAgents/local.orca-toolkit.fkey-tap.plist`.
//!
//! The keys are macOS Services scoped to Orca (`~/.orca/account-shortcuts/install.ts`). A Service
//! fires only for a key the web content leaves unhandled. The Chat UI composer leaves F1 alone, but
//! a focused xterm encodes it as an escape sequence and calls preventDefault, so the Service never
//! sees it. This program sits in front of Orca instead: a session event tap takes every
//! modifier-free function key that `accounts.json` maps to an account while Orca is frontmost,
//! swallows it (and its key-up), and opens the account tab itself on a worker thread (`open.rs`):
//! no node, osascript or launcher process sits between the key and Orca (2026-10-28; the old
//! child-process chain cost ~0.3-0.4 s before Orca saw the chord). Chat UI and terminal focus
//! therefore take one path, and the Service never fires twice.
//!
//! The tap needs Accessibility. Until it is granted the program registers itself in the
//! Accessibility list, retries every 15 s, and the Services keep working from the Chat UI.
//!
//! One press opens one tab. An accepted press plays a short system sound at once, and every
//! function-key press that arrives while that launch is still opening (and for a short tail after
//! the launch finishes, while the agent boots) is swallowed instead of queuing another tab
//! (2026-10-28: three F5 presses in two seconds opened three conversations).
//!
//! The launched account terminal reaches the remote Orca runtime on the LAN, and this job is the
//! responsible process for that Local Network check. As a bare binary its Allow never stuck:
//! nehelper logged "Local network allowed by preference for orca-fkey-tap, but received prompt"
//! and asked again (2026-10-27), so `run` executes from `~/Applications/OrcaFkeyTap.app`
//! (`shared/app_bundle.rs`).
//!
//!   orca-fkey-tap          run the tap (launchd)
//!   orca-fkey-tap check    print trust, the frontmost app and the key map, then exit

mod account;
#[path = "../../../shared/app_bundle.rs"]
mod app_bundle;
mod keymap;
mod open;
mod remote;
#[path = "../../../shared/orca_rpc.rs"]
mod orca_rpc;

use anyhow::{Context, Result};
use serde_json::Value;
use std::ffi::{c_char, c_void, CStr};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicPtr, AtomicU16, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ORCA_BUNDLE_ID: &str = "com.stablyai.orca";
const RETRY_UNTRUSTED: Duration = Duration::from_secs(15);
// Upper bound on how long one launch may block further presses if it hangs.
const LAUNCH_HOLD_MS: u64 = 15_000;
// Presses this soon after a launch finishes still belong to the tab whose agent is booting.
const LAUNCH_TAIL_MS: u64 = 1_500;
const ACCEPT_SOUND: &CStr = c"Hero";
const BUNDLE: app_bundle::AppBundle = app_bundle::AppBundle {
    id: "local.orca-toolkit.fkey-tap",
    executable: "orca-fkey-tap",
    name: "OrcaFkeyTap",
    version: env!("CARGO_PKG_VERSION"),
    usage: "Orca F-key Tap opens account terminals that connect to the Orca runtime on your local network.",
};

type CFTypeRef = *const c_void;
type CGEventRef = *mut c_void;
type Id = *mut c_void;
type Sel = *mut c_void;
type TapCallback = extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

const SESSION_EVENT_TAP: u32 = 1;
const HEAD_INSERT_EVENT_TAP: u32 = 0;
const TAP_OPTION_DEFAULT: u32 = 0;
const EVENT_KEY_DOWN: u32 = 10;
const EVENT_KEY_UP: u32 = 11;
const EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
const FIELD_KEYBOARD_AUTOREPEAT: u32 = 8;
const FIELD_KEYBOARD_KEYCODE: u32 = 9;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: CFTypeRef;
    static kCFBooleanTrue: CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFDictionaryCreate(alloc: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, count: isize, key_cb: *const c_void, value_cb: *const c_void) -> CFTypeRef;
    fn CFRelease(value: CFTypeRef);
    fn CFMachPortCreateRunLoopSource(alloc: CFTypeRef, port: *mut c_void, order: isize) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(run_loop: *mut c_void, source: *mut c_void, mode: CFTypeRef);
    fn CFRunLoopRun();
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, callback: TapCallback, user: *mut c_void) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    static kAXTrustedCheckOptionPrompt: CFTypeRef;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
}

// Referenced so the linker keeps AppKit, which defines the NSWorkspace class looked up at runtime.
#[link(name = "AppKit", kind = "framework")]
extern "C" {
    static NSWorkspaceDidActivateApplicationNotification: Id;
}

extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}

static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
// Bit n is set while the key-down of function key n was swallowed and its key-up is still due.
static SWALLOWED: AtomicU16 = AtomicU16::new(0);
// Epoch milliseconds until which a new launch is refused; 0 when idle.
static BUSY_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

fn main() -> Result<()> {
    let _ = unsafe { NSWorkspaceDidActivateApplicationNotification };
    match std::env::args().nth(1).as_deref() {
        None | Some("run") => {
            if let Err(error) = BUNDLE.adopt() {
                log(&format!("app bundle adoption failed ({error}); running unbundled"));
            }
            run()
        }
        Some("check") => check(),
        Some(other) => anyhow::bail!("unknown command {other:?}; use `run` or `check`"),
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn shortcuts_dir() -> PathBuf {
    home().join(".orca/account-shortcuts")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn log(message: &str) {
    let secs = now_ms() / 1_000;
    eprintln!("{secs} {message}");
}

/// Plays a named system sound through `[NSSound soundNamed:]`; returns whether playback started.
fn play_sound(name: &CStr) -> bool {
    unsafe {
        let send_cstr: unsafe extern "C" fn(Id, Sel, *const c_char) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_obj: unsafe extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_bool: unsafe extern "C" fn(Id, Sel) -> bool = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let sel = |name: &CStr| sel_registerName(name.as_ptr());
        let pool = objc_autoreleasePoolPush();
        let string = send_cstr(objc_getClass(c"NSString".as_ptr()), sel(c"stringWithUTF8String:"), name.as_ptr());
        let sound = send_obj(objc_getClass(c"NSSound".as_ptr()), sel(c"soundNamed:"), string);
        let played = !sound.is_null() && send_bool(sound, sel(c"play"));
        objc_autoreleasePoolPop(pool);
        played
    }
}

fn read_accounts() -> Result<Value> {
    let path = shortcuts_dir().join("accounts.json");
    let text = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

/// Asks once with the system prompt so the binary appears in the Accessibility list.
fn accessibility_trusted(prompt: bool) -> bool {
    unsafe {
        if !prompt {
            return AXIsProcessTrustedWithOptions(std::ptr::null());
        }
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        let trusted = AXIsProcessTrustedWithOptions(options);
        CFRelease(options);
        trusted
    }
}

/// Bundle identifier of the frontmost application, read through NSWorkspace.
fn frontmost_bundle_id() -> Option<String> {
    unsafe {
        let send_id: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_cstr: unsafe extern "C" fn(Id, Sel) -> *const c_char = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let sel = |name: &CStr| sel_registerName(name.as_ptr());
        let pool = objc_autoreleasePoolPush();
        let workspace = send_id(objc_getClass(c"NSWorkspace".as_ptr()), sel(c"sharedWorkspace"));
        let app = send_id(workspace, sel(c"frontmostApplication"));
        let bundle = if app.is_null() { std::ptr::null_mut() } else { send_id(app, sel(c"bundleIdentifier")) };
        let text = if bundle.is_null() { std::ptr::null() } else { send_cstr(bundle, sel(c"UTF8String")) };
        let result = (!text.is_null()).then(|| CStr::from_ptr(text).to_string_lossy().into_owned());
        objc_autoreleasePoolPop(pool);
        result
    }
}

/// Opens the account tab on a worker thread; the event tap callback must return at once.
fn launch_account(id: &str, pressed_ms: u64) {
    let id = id.to_owned();
    std::thread::spawn(move || {
        let result = open::run(&home(), &id, || frontmost_bundle_id().as_deref() == Some(ORCA_BUNDLE_ID));
        BUSY_UNTIL_MS.store(now_ms() + LAUNCH_TAIL_MS, Ordering::SeqCst);
        match result {
            Ok(timing) => log(&format!(
                "shortcut-timing {}",
                serde_json::json!({
                    "account": id, "terminal": timing.terminal,
                    "transport": if timing.terminal == "paired-host" { "rust-local+paired-search" } else { "rust-local" },
                    "keyToSentMs": now_ms().saturating_sub(pressed_ms), "prepareMs": timing.prepare_ms,
                    "discoverMs": timing.discover_ms, "sendMs": timing.send_ms,
                })
            )),
            Err(error) => {
                log(&format!("launch {id} failed: {error:#}"));
                notify(&format!("{id}: {error:#}"));
            }
        }
    });
}

/// A failed launch is the only case worth a banner; the accept sound covers success.
fn notify(message: &str) {
    let script = format!("display notification {} with title \"Orca F-key\"", serde_json::Value::from(message));
    if let Err(error) = Command::new("/usr/bin/osascript").arg("-e").arg(script).status() {
        log(&format!("notification failed: {error}"));
    }
}

extern "C" fn on_event(_proxy: *mut c_void, kind: u32, event: CGEventRef, _user: *mut c_void) -> CGEventRef {
    if kind == EVENT_TAP_DISABLED_BY_TIMEOUT || kind == EVENT_TAP_DISABLED_BY_USER_INPUT {
        log(&format!("tap disabled ({kind:#x}); re-enabling"));
        unsafe { CGEventTapEnable(TAP.load(Ordering::SeqCst), true) };
        return event;
    }
    let key_code = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYBOARD_KEYCODE) } as u16;
    let Some(number) = keymap::function_key_number(key_code) else { return event };
    let bit = 1u16 << number;

    if kind == EVENT_KEY_UP {
        let held = SWALLOWED.fetch_and(!bit, Ordering::SeqCst);
        return if held & bit != 0 { std::ptr::null_mut() } else { event };
    }
    if kind != EVENT_KEY_DOWN || keymap::has_chord_modifier(unsafe { CGEventGetFlags(event) }) {
        return event;
    }
    if frontmost_bundle_id().as_deref() != Some(ORCA_BUNDLE_ID) {
        return event;
    }
    let account = match read_accounts() {
        Ok(accounts) => keymap::account_for_function_key(&accounts, number),
        Err(error) => {
            log(&format!("F{number}: {error:#}"));
            None
        }
    };
    let Some(account) = account else { return event };

    SWALLOWED.fetch_or(bit, Ordering::SeqCst);
    // A held key repeats; only its first key-down opens a terminal.
    if unsafe { CGEventGetIntegerValueField(event, FIELD_KEYBOARD_AUTOREPEAT) } != 0 {
        return std::ptr::null_mut();
    }
    let now = now_ms();
    if !accepts_launch(BUSY_UNTIL_MS.load(Ordering::SeqCst), now) {
        log(&format!("F{number} -> {account} ignored: the previous launch is still opening"));
        return std::ptr::null_mut();
    }
    BUSY_UNTIL_MS.store(now + LAUNCH_HOLD_MS, Ordering::SeqCst);
    let chimed = play_sound(ACCEPT_SOUND);
    log(&format!("F{number} -> {account}{}", if chimed { "" } else { " (sound failed)" }));
    launch_account(&account, now);
    std::ptr::null_mut()
}

/// A press launches only when no earlier launch is still opening or booting.
fn accepts_launch(busy_until_ms: u64, now_ms: u64) -> bool {
    now_ms >= busy_until_ms
}

fn run() -> Result<()> {
    let mask = (1u64 << EVENT_KEY_DOWN) | (1u64 << EVENT_KEY_UP);
    let mut prompted = false;
    let tap = loop {
        let tap = unsafe { CGEventTapCreate(SESSION_EVENT_TAP, HEAD_INSERT_EVENT_TAP, TAP_OPTION_DEFAULT, mask, on_event, std::ptr::null_mut()) };
        if !tap.is_null() {
            break tap;
        }
        if !prompted {
            log("event tap refused: grant Accessibility to ~/.local/bin/orca-fkey-tap; retrying every 15 s");
            accessibility_trusted(true);
            prompted = true;
        }
        std::thread::sleep(RETRY_UNTRUSTED);
    };
    TAP.store(tap, Ordering::SeqCst);
    log("event tap active");
    unsafe {
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        CFRunLoopRun();
    }
    anyhow::bail!("run loop exited")
}

fn check() -> Result<()> {
    println!("accessibility trusted: {}", accessibility_trusted(false));
    println!("frontmost app: {}", frontmost_bundle_id().unwrap_or_else(|| "-".into()));
    let accounts = read_accounts()?;
    for number in 1..=12u8 {
        if let Some(id) = keymap::account_for_function_key(&accounts, number) {
            println!("F{number} -> {id}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presses_during_an_open_launch_are_refused() {
        assert!(accepts_launch(0, 1_000));
        assert!(!accepts_launch(1_000 + LAUNCH_HOLD_MS, 1_200));
        assert!(!accepts_launch(5_000 + LAUNCH_TAIL_MS, 5_100));
        assert!(accepts_launch(5_000 + LAUNCH_TAIL_MS, 5_000 + LAUNCH_TAIL_MS));
    }
}
