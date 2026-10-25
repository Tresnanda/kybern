//! The project map as the orchestrator serves it: the `kybern_project_map` tool,
//! the `projects.map` RPC, and the header a Coordinator's session starts with.
//! The map itself is built and cached by `crate::project_map`.
//!
//! The header is read from the cache and refreshed only where a session starts
//! (`spawn_session`) or a client asks, so the prefix of a running session never
//! changes under it. Changes reach a Coordinator through the change report.

use std::path::PathBuf;

use anyhow::{Result, anyhow, ensure};
use kybern_protocol::methods::{self, ProjectMap};
use kybern_protocol::*;
use serde_json::Value;

use super::Orchestrator;

impl Orchestrator {
    fn project_map_cache_root(&self) -> PathBuf {
        self.inner.paths.root.join("cache").join("project-map")
    }

    fn map_project(&self, project_id: ProjectId) -> Result<Project> {
        ensure!(!is_free_chat_project(project_id), "Chats without a project have no map. Choose a project.");
        self.inner.store.project_get(project_id)?.ok_or_else(|| anyhow!("Project not found."))
    }

    /// The map of the project for its repositories' HEADs as they are now: cached
    /// when the cache describes them, else rebuilt (well under a second) and cached.
    pub(crate) async fn project_map(&self, project_id: ProjectId) -> Result<ProjectMap> {
        let project = self.map_project(project_id)?;
        crate::project_map::current(&self.project_map_cache_root(), &project).await
    }

    /// Bring the cached map up to the repositories' HEADs. A failure is logged and
    /// leaves the cache as it was: a session without a map header still works.
    pub(super) async fn refresh_project_map(&self, project_id: ProjectId) {
        if let Err(error) = self.project_map(project_id).await {
            tracing::debug!(%project_id, %error, "no project map for this session");
        }
    }

    /// The map header (at most 6 KiB, starting `Map as of {repo}@{sha}`) from the
    /// cache, as of the last build. It does not run git: call [`Self::refresh_project_map`]
    /// first where HEAD may have moved, or use [`Self::fresh_map_header`].
    pub(crate) fn map_header(&self, project_id: ProjectId) -> Option<String> {
        crate::project_map::read_cache(&self.project_map_cache_root(), project_id).and_then(|map| crate::project_map::header_of(&map))
    }

    /// The map header for the repositories' HEADs as they are now. For the rotation
    /// seed, which is built where a rebuild is affordable.
    #[allow(dead_code)]
    pub(crate) async fn fresh_map_header(&self, project_id: ProjectId) -> Option<String> {
        self.project_map(project_id).await.ok().and_then(|map| crate::project_map::header_of(&map))
    }

    /// `projects.map`.
    pub async fn projects_map(&self, params: methods::ProjectsMapParams) -> Result<methods::ProjectsMapResult> {
        let map = self.project_map(params.project_id).await?;
        Ok(methods::ProjectsMapResult { project_id: params.project_id, map })
    }

    /// `kybern_project_map`: for any thread, about the project it belongs to.
    pub(super) async fn execute_project_map(&self, thread: &Thread, arguments: Value) -> Result<Value> {
        let args = crate::project_map::tool_args(arguments)?;
        let project = self.map_project(thread.project_id)?;
        crate::project_map::tool_result(&self.project_map_cache_root(), &project, args).await
    }
}
