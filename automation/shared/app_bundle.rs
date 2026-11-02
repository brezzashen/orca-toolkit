//! Fixed-identity app bundle for a resident binary that reaches the local network.
//!
//! macOS Local Network privacy stores the user's Allow by signing identifier and matches a running
//! process through its Mach-O UUID, which `nehelper` resolves through LaunchServices. A bare
//! linker-signed binary in `~/.local/bin` is not in LaunchServices, so after every rebuild or
//! UUID-cache flush `nehelper` logs "Local network allowed by preference for <name>, but received
//! prompt" and the dialog returns. A bundle signed with a fixed identifier and registered with
//! LaunchServices lets the system resolve the current executable, so one Allow persists across
//! rebuilds (proved on `browser-mcp-gateway`, 2026-10-19).
//!
//! Registration alone did not hold: on 2026-10-27 13:00 a rebuilt `cpu-watchdog` inside its
//! registered bundle still logged "allowed by preference … but received prompt" and the dialog sat
//! unanswered, because `nehelper` caches the executable's Mach-O UUID and every link mints a new one.
//! `install_at` therefore rewrites `LC_UUID` to a value derived from the bundle id before signing,
//! so a rebuild keeps the UUID the cache already holds.
//!
//! `adopt` makes this self-healing for launchd jobs: `cargo install` replaces the
//! `~/.local/bin/<name>` symlink with a bare file, so on its next start the job copies that file
//! into the bundle, signs and registers it, restores the symlink and re-executes from the bundle
//! with the original argv[0], which keeps argv-based process markers matching.

use std::io::{Error, Result};
use std::os::unix::fs::symlink;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const LSREGISTER: &str =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const REEXEC_ENV: &str = "APP_BUNDLE_ADOPTED";

pub struct AppBundle {
    /// Bundle identifier and signing identifier, e.g. `local.orca-toolkit.fkey-tap`.
    pub id: &'static str,
    /// Executable name in `~/.local/bin` and `Contents/MacOS`.
    pub executable: &'static str,
    /// Bundle directory name without `.app`, under `~/Applications`.
    pub name: &'static str,
    pub version: &'static str,
    /// `NSLocalNetworkUsageDescription` shown in the dialog.
    pub usage: &'static str,
}

impl AppBundle {
    fn info_plist(&self) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>{id}</string>
	<key>CFBundleExecutable</key>
	<string>{executable}</string>
	<key>CFBundleName</key>
	<string>{name}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>{version}</string>
	<key>CFBundleVersion</key>
	<string>{version}</string>
	<key>LSBackgroundOnly</key>
	<true/>
	<key>NSLocalNetworkUsageDescription</key>
	<string>{usage}</string>
</dict>
</plist>
"#,
            id = self.id,
            executable = self.executable,
            name = self.name,
            version = self.version,
            usage = self.usage
        )
    }

    /// Installs into `bundle` from the binary at `link`, then points `link` at the bundle executable.
    pub fn install_at(&self, link: &Path, bundle: &Path) -> Result<PathBuf> {
        let macos = bundle.join("Contents/MacOS");
        let target = macos.join(self.executable);
        std::fs::create_dir_all(&macos)?;
        let metadata = std::fs::symlink_metadata(link)?;
        if metadata.file_type().is_symlink() {
            if std::fs::canonicalize(link)? != std::fs::canonicalize(&target).unwrap_or_default() {
                return Err(Error::other(format!("{} is a symlink to somewhere other than {}", link.display(), target.display())));
            }
        } else {
            // Copy then rename so a running instance keeps its old inode and launchd never sees a partial file.
            let staged = macos.join(format!("{}.new", self.executable));
            std::fs::copy(link, &staged)?;
            let mut image = std::fs::read(&staged)?;
            if set_macho_uuid(&mut image, fixed_uuid(self.id)) {
                std::fs::write(&staged, &image)?;
            } else {
                eprintln!("app bundle: no LC_UUID in a thin 64-bit Mach-O; Local Network may ask again after this rebuild");
            }
            std::fs::rename(&staged, &target)?;
        }
        std::fs::write(bundle.join("Contents/Info.plist"), self.info_plist())?;
        let bundle_arg = bundle.to_str().ok_or_else(|| Error::other("bundle path is not UTF-8"))?;
        sign(self.id, bundle_arg)?;
        run(LSREGISTER, &["-f", bundle_arg])?;
        if !metadata.file_type().is_symlink() {
            let staged_link = link.with_extension("app-link");
            let _ = std::fs::remove_file(&staged_link);
            symlink(&target, &staged_link)?;
            std::fs::rename(&staged_link, link)?;
        }
        Ok(target)
    }

    /// When this process runs from a bare `~/.local/bin` file, moves it into the bundle and
    /// re-executes from there; returns `Ok(())` when already bundled or not installed there.
    pub fn adopt(&self) -> Result<()> {
        if std::env::var_os(REEXEC_ENV).is_some() {
            // Keep the marker away from children; this runs before any thread starts.
            std::env::remove_var(REEXEC_ENV);
            return Ok(());
        }
        let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| Error::other("HOME is not set"))?;
        let link = home.join(".local/bin").join(self.executable);
        let bundle = home.join("Applications").join(format!("{}.app", self.name));
        let current = std::fs::canonicalize(std::env::current_exe()?)?;
        if current.starts_with(&bundle) || std::fs::canonicalize(&link).ok() != Some(current) {
            return Ok(());
        }
        // A CLI (local-search) can start many copies right after `cargo install`. The lock lets one
        // install; the rest find the symlink and only re-exec, never re-signing a running bundle.
        std::fs::create_dir_all(&bundle)?;
        let guard = std::fs::File::open(&bundle)?;
        guard.lock()?;
        let installed = bundle.join("Contents/MacOS").join(self.executable);
        let target = if std::fs::symlink_metadata(&link)?.file_type().is_symlink()
            && std::fs::canonicalize(&link).ok() == std::fs::canonicalize(&installed).ok()
        {
            installed
        } else {
            self.install_at(&link, &bundle)?
        };
        let mut args = std::env::args_os();
        let arg0 = args.next().unwrap_or_else(|| link.clone().into_os_string());
        Err(Command::new(target).arg0(arg0).args(args).env(REEXEC_ENV, "1").exec())
    }
}

/// Signs with the login keychain's Apple Development identity when one is valid, else ad hoc.
/// An ad hoc signature changes with every build, so TCC (removable volumes, Local Network) asks again
/// after each rebuild, and an unanswered prompt behind a locked screen blocks sandboxd for every
/// process reading that volume. A certificate signature keeps the designated requirement
/// (identifier + leaf CN) stable, so one Allow survives rebuilds. `APP_BUNDLE_SIGN_IDENTITY` overrides.
fn sign(id: &str, bundle: &str) -> Result<()> {
    if let Some(identity) = std::env::var("APP_BUNDLE_SIGN_IDENTITY").ok().or_else(development_identity) {
        match run("/usr/bin/codesign", &["--force", "--sign", &identity, "--identifier", id, bundle]) {
            Ok(()) => return Ok(()),
            Err(error) => eprintln!("app bundle: signing with {identity} failed ({error}); signing ad hoc"),
        }
    }
    run("/usr/bin/codesign", &["--force", "--sign", "-", "--identifier", id, bundle])
}

pub fn development_identity() -> Option<String> {
    let out = Command::new("/usr/bin/security").args(["find-identity", "-v", "-p", "codesigning"]).output().ok()?;
    first_development_identity(&String::from_utf8_lossy(&out.stdout))
}

/// The SHA-1 of the first valid `Apple Development` identity in `security find-identity -v` output.
fn first_development_identity(listing: &str) -> Option<String> {
    listing.lines().find(|l| l.contains("\"Apple Development:")).and_then(|l| l.split_whitespace().nth(1))
        .filter(|hash| hash.len() == 40 && hash.chars().all(|c| c.is_ascii_hexdigit())).map(str::to_string)
}

/// A stable RFC 4122-shaped UUID from two FNV-1a passes over the bundle id.
pub fn fixed_uuid(id: &str) -> [u8; 16] {
    let fnv = |seed: u64| id.bytes().fold(seed, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3));
    let mut uuid = [0u8; 16];
    uuid[..8].copy_from_slice(&fnv(0xcbf2_9ce4_8422_2325).to_be_bytes());
    uuid[8..].copy_from_slice(&fnv(0x8422_2325_cbf2_9ce4).to_be_bytes());
    uuid[6] = (uuid[6] & 0x0f) | 0x50;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    uuid
}

/// Overwrites `LC_UUID` in a thin little-endian 64-bit Mach-O; false when the image has none.
pub fn set_macho_uuid(image: &mut [u8], uuid: [u8; 16]) -> bool {
    const MH_MAGIC_64: u32 = 0xfeed_facf;
    const LC_UUID: u32 = 0x1b;
    let word = |image: &[u8], at: usize| image.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if word(image, 0) != Some(MH_MAGIC_64) {
        return false;
    }
    let count = word(image, 16).unwrap_or(0);
    let mut at = 32;
    for _ in 0..count {
        let (Some(cmd), Some(size)) = (word(image, at), word(image, at + 4)) else { return false };
        if cmd == LC_UUID && size >= 24 && image.len() >= at + 24 {
            image[at + 8..at + 24].copy_from_slice(&uuid);
            return true;
        }
        if size < 8 {
            return false;
        }
        at += size as usize;
    }
    false
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program).args(args).status()?;
    if !status.success() {
        return Err(Error::other(format!("{program} {} exited with {status}", args.join(" "))));
    }
    Ok(())
}

#[cfg(test)]
mod app_bundle_tests {
    use super::*;

    const TEST: AppBundle = AppBundle {
        id: "local.example.app-bundle-test",
        executable: "app-bundle-test",
        name: "AppBundleTest",
        version: "0.1.0",
        usage: "Test",
    };

    #[test]
    fn info_plist_names_the_fixed_identifier_and_executable() {
        let plist = TEST.info_plist();
        assert!(plist.contains("<string>local.example.app-bundle-test</string>"));
        assert!(plist.contains("<key>CFBundleExecutable</key>\n\t<string>app-bundle-test</string>"));
    }

    #[test]
    fn the_first_valid_development_identity_is_chosen() {
        let listing = "  1) 9BCBA8BBF9C8F41C838C0C80F4845D3D4C6B2885 \"Apple Development: Created via API (37AK3G6FHM)\"\n     1 valid identities found\n";
        assert_eq!(first_development_identity(listing).as_deref(), Some("9BCBA8BBF9C8F41C838C0C80F4845D3D4C6B2885"));
        assert_eq!(first_development_identity("     0 valid identities found\n"), None);
        assert_eq!(first_development_identity("  1) ABC \"Developer ID Application: X\"\n"), None);
    }

    #[test]
    fn rebuilt_images_get_the_same_fixed_uuid() {
        let image = |uuid: u8| {
            let mut bytes = vec![0u8; 32];
            bytes[..4].copy_from_slice(&0xfeed_facfu32.to_le_bytes());
            bytes[16..20].copy_from_slice(&2u32.to_le_bytes());
            bytes.extend_from_slice(&0x19u32.to_le_bytes());
            bytes.extend_from_slice(&16u32.to_le_bytes());
            bytes.extend_from_slice(&[0; 8]);
            bytes.extend_from_slice(&0x1bu32.to_le_bytes());
            bytes.extend_from_slice(&24u32.to_le_bytes());
            bytes.extend_from_slice(&[uuid; 16]);
            bytes
        };
        let (mut first, mut second) = (image(1), image(2));
        assert!(set_macho_uuid(&mut first, fixed_uuid(TEST.id)));
        assert!(set_macho_uuid(&mut second, fixed_uuid(TEST.id)));
        assert_eq!(first, second);
        assert_ne!(fixed_uuid(TEST.id), fixed_uuid("local.example.other"));
        assert!(!set_macho_uuid(&mut b"#!/bin/sh\n".to_vec(), fixed_uuid(TEST.id)));
    }

    #[test]
    fn foreign_symlink_is_refused() {
        let directory = std::env::temp_dir().join(format!("app-bundle-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let elsewhere = directory.join("elsewhere");
        std::fs::write(&elsewhere, b"x").unwrap();
        let link = directory.join(TEST.executable);
        let _ = std::fs::remove_file(&link);
        symlink(&elsewhere, &link).unwrap();
        let error = TEST.install_at(&link, &directory.join("Test.app")).unwrap_err();
        std::fs::remove_dir_all(&directory).unwrap();
        assert!(error.to_string().contains("somewhere other than"));
    }
}
