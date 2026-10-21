//! Spaces: groups of projects. The daemon only stores them; which space is
//! active is client state. Every change is published on the spaces channel
//! (and the projects channel when a project moves), so each connection can
//! forward `spaces.changed` / `projects.changed`.

use chrono::Utc;
use kybern_protocol::methods::{SpacesChangedNotification, SpacesDeleteResult};
use kybern_protocol::rpc::{RpcError, codes};
use kybern_protocol::{Project, ProjectId, Space, SpaceColor, SpaceId, SpaceLogo, is_free_chat_project};
use kybern_store::SpaceError;
use tokio::sync::broadcast;
use uuid::Uuid;

use super::Orchestrator;

const NAME_MAX_CHARS: usize = 32;
const SPACE_LIMIT: usize = 50;
const LOGO_MAX_BYTES: u64 = 2 * 1024 * 1024;

const LOGO_ERROR: &str = "Space logos must be PNG, JPEG or WebP images up to 2 MB.";
const ICON_ERROR: &str = "Icons are named with lowercase letters, numbers and dashes.";

fn invalid(message: &str) -> RpcError {
    RpcError::new(codes::INVALID_PARAMS, message)
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::internal(error)
}

fn store_error(error: anyhow::Error) -> RpcError {
    match error.downcast_ref::<SpaceError>() {
        Some(SpaceError::NotFound(what)) => RpcError::not_found(what),
        Some(other) => invalid(&other.to_string()),
        None => internal(error),
    }
}

/// `^[a-z0-9][a-z0-9-]{0,31}$`
fn valid_icon_slug(slug: &str) -> bool {
    let mut chars = slug.chars();
    slug.len() <= 32
        && chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl Orchestrator {
    /// Changes to the space list, for forwarding to connected clients.
    pub fn subscribe_spaces(&self) -> broadcast::Receiver<SpacesChangedNotification> {
        self.inner.spaces_changed.subscribe()
    }

    /// Tell clients the space list changed. Each notification carries the whole
    /// list, so a client that misses one catches up with the next.
    pub fn publish_spaces(&self) {
        match self.inner.store.spaces_list() {
            Ok(spaces) => {
                let _ = self.inner.spaces_changed.send(SpacesChangedNotification { spaces });
            }
            Err(error) => tracing::warn!(%error, "could not read spaces to announce a change"),
        }
    }

    pub fn list_spaces(&self) -> Result<Vec<Space>, RpcError> {
        self.inner.store.spaces_list().map_err(internal)
    }

    pub async fn create_space(&self, name: String, color: Option<SpaceColor>, logo: Option<SpaceLogo>) -> Result<Space, RpcError> {
        let name = self.checked_name(&name, None)?;
        let existing = self.list_spaces()?;
        if existing.len() >= SPACE_LIMIT {
            return Err(invalid("You can have up to 50 spaces."));
        }
        let color = color.unwrap_or_else(|| {
            SpaceColor::ALL
                .into_iter()
                .find(|candidate| existing.iter().all(|space| space.color != *candidate))
                .unwrap_or(SpaceColor::ALL[existing.len() % SpaceColor::ALL.len()])
        });
        let logo = match logo {
            Some(logo) => self.prepared_logo(logo, None).await?,
            None => SpaceLogo::Initials,
        };
        let now = Utc::now();
        let space = Space { id: Uuid::now_v7(), name, color, logo, position: 0, created_at: now, updated_at: now };
        let _guard = self.inner.space_writes.lock().unwrap_or_else(|e| e.into_inner());
        // Re-check under the lock so two clients cannot both take the same name.
        self.checked_name(&space.name, None)?;
        let stored = self.inner.store.space_insert(&space).map_err(internal)?;
        self.publish_spaces();
        Ok(stored)
    }

    pub async fn update_space(
        &self,
        space_id: SpaceId,
        name: Option<String>,
        color: Option<SpaceColor>,
        logo: Option<SpaceLogo>,
    ) -> Result<Space, RpcError> {
        let mut space = self.inner.store.space_get(space_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("space"))?;
        let mut changed = false;
        if let Some(name) = name {
            let name = self.checked_name(&name, Some(space_id))?;
            changed |= name != space.name;
            space.name = name;
        }
        if let Some(color) = color {
            changed |= color != space.color;
            space.color = color;
        }
        if let Some(logo) = logo {
            let logo = self.prepared_logo(logo, Some(&space.logo)).await?;
            changed |= logo != space.logo;
            space.logo = logo;
        }
        if !changed {
            return Ok(space);
        }
        space.updated_at = Utc::now();
        let _guard = self.inner.space_writes.lock().unwrap_or_else(|e| e.into_inner());
        self.checked_name(&space.name, Some(space_id))?;
        if !self.inner.store.space_update(&space).map_err(internal)? {
            return Err(RpcError::not_found("space"));
        }
        self.publish_spaces();
        self.inner.store.space_get(space_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("space"))
    }

    /// Delete a space; its projects move to the space above (the next one for the first).
    pub fn delete_space(&self, space_id: SpaceId) -> Result<SpacesDeleteResult, RpcError> {
        let _guard = self.inner.space_writes.lock().unwrap_or_else(|e| e.into_inner());
        let (moved_to, moved_projects) = self.inner.store.space_delete_moving(space_id).map_err(store_error)?;
        self.publish_spaces();
        self.publish_projects();
        Ok(SpacesDeleteResult { moved_to, moved_projects })
    }

    pub fn reorder_spaces(&self, space_ids: &[SpaceId]) -> Result<Vec<Space>, RpcError> {
        let _guard = self.inner.space_writes.lock().unwrap_or_else(|e| e.into_inner());
        self.inner.store.spaces_reorder(space_ids).map_err(store_error)?;
        self.publish_spaces();
        self.list_spaces()
    }

    /// Move a project into a space. Moving it where it already is changes nothing and announces nothing.
    pub fn move_project(&self, project_id: ProjectId, space_id: SpaceId) -> Result<Project, RpcError> {
        if is_free_chat_project(project_id) {
            return Err(invalid("Free chat isn't in a space."));
        }
        if self.inner.store.space_get(space_id).map_err(internal)?.is_none() {
            return Err(RpcError::not_found("space"));
        }
        if self.inner.store.project_get(project_id).map_err(internal)?.is_none() {
            return Err(RpcError::not_found("project"));
        }
        if self.inner.store.project_set_space(project_id, space_id).map_err(store_error)? {
            self.publish_projects();
        }
        self.inner.store.project_get(project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))
    }

    /// Trim and validate a name; `except` is the space being renamed.
    fn checked_name(&self, name: &str, except: Option<SpaceId>) -> Result<String, RpcError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(invalid("Give the space a name."));
        }
        if name.chars().count() > NAME_MAX_CHARS {
            return Err(invalid("Space names can be up to 32 characters."));
        }
        let lowered = name.to_lowercase();
        let taken = self.list_spaces()?.iter().any(|space| Some(space.id) != except && space.name.to_lowercase() == lowered);
        if taken {
            return Err(invalid(&format!("You already have a space named {name}.")));
        }
        Ok(name.to_string())
    }

    /// Validate a logo. An image that differs from the stored logo is replaced by a
    /// new asset holding the 128×128 crop, so clients can cache logos by asset id.
    async fn prepared_logo(&self, logo: SpaceLogo, stored: Option<&SpaceLogo>) -> Result<SpaceLogo, RpcError> {
        match logo {
            SpaceLogo::Initials => Ok(SpaceLogo::Initials),
            SpaceLogo::Icon { icon } => {
                if !valid_icon_slug(&icon) {
                    return Err(invalid(ICON_ERROR));
                }
                Ok(SpaceLogo::Icon { icon })
            }
            SpaceLogo::Image { asset_id } => {
                if stored == Some(&SpaceLogo::Image { asset_id }) {
                    return Ok(SpaceLogo::Image { asset_id });
                }
                let info = self.inner.store.asset_get(asset_id).map_err(internal)?.filter(|info| info.size <= LOGO_MAX_BYTES);
                let Some(info) = info else { return Err(invalid(LOGO_ERROR)) };
                let source = self.inner.paths.assets.join(info.id.to_string());
                let bytes = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
                    let bytes = std::fs::read(source)?;
                    crate::thumbnail::square_logo(&bytes)
                })
                .await
                .map_err(internal)?
                .map_err(|_| invalid(LOGO_ERROR))?;
                let derived = Uuid::now_v7();
                std::fs::create_dir_all(&self.inner.paths.assets).map_err(internal)?;
                tokio::fs::write(self.inner.paths.assets.join(derived.to_string()), &bytes).await.map_err(internal)?;
                self.inner
                    .store
                    .asset_insert(&kybern_protocol::methods::AssetInfo {
                        id: derived,
                        name: "space-logo.png".into(),
                        media_type: "image/png".into(),
                        size: bytes.len() as u64,
                        created_at: Utc::now(),
                    })
                    .map_err(internal)?;
                Ok(SpaceLogo::Image { asset_id: derived })
            }
        }
    }
}
