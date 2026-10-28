//! The machine network (ADE-86, design: `docs/design/machine-network.md`).
//!
//! This package is identity and membership (N2): per-OS machine keys, the signed membership
//! operations and the rules that validate them, the projection from operations to machines, and
//! the in-process sync functions the peer manager calls. Discovery, sessions, joining flows and
//! the RPC handlers are built on top of it by N3 and N4.
//!
//! Start it once at the daemon's startup:
//!
//! ```ignore
//! let membership = network::start(&paths.root, &store, &environment_id)?;
//! ```

pub mod keys;
pub mod membership;
pub mod ops;

#[allow(unused_imports)]
pub use keys::MachineKeys;
#[allow(unused_imports)]
pub use membership::{ApplyOutcome, IdentityReset, Membership, MembershipError, SelfInfo, previous_machine_ids, start};
#[allow(unused_imports)]
pub use ops::{OpError, Projection, Rejection};

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};

    /// A directory under the system temp directory that is removed on drop. The daemon's
    /// dev-dependencies carry no `tempfile`, and these tests must never touch `~/.kybern`.
    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("kybern-net-{label}-{}", uuid::Uuid::now_v7()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
