//! Group projects: a parent folder whose members are git repositories inside it.
//!
//! Members live in `project_members` (ordered, '/'-separated relative paths, "." for
//! the folder itself) and are attached to every project read, so `Project.members`
//! is always the stored list. The daemon validates paths before they get here.

use std::collections::HashMap;

use anyhow::Result;
use chrono::Utc;
use kybern_protocol::{MemberStatus, Project, ProjectId, ProjectKind, ProjectMember};
use rusqlite::{Connection, params};

use crate::{Store, other};

/// "." is the group folder itself.
pub const GROUP_FOLDER_MEMBER: &str = ".";

impl Store {
    /// A group's members in order (primary first). Empty for single projects.
    pub fn project_members(&self, project_id: ProjectId) -> Result<Vec<ProjectMember>> {
        let Some(project) = self.project_get(project_id)? else { return Ok(Vec::new()) };
        Ok(project.members)
    }

    /// Replace a group's members in one transaction. Positions follow `paths`;
    /// kept members keep their `added_at` and cached status.
    pub fn project_set_members(&self, project_id: ProjectId, paths: &[String]) -> Result<()> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            write_members(&tx, project_id, paths)?;
            tx.execute("UPDATE projects SET updated_at = ?2 WHERE id = ?1", params![project_id.to_string(), Utc::now().to_rfc3339()])?;
            tx.commit()?;
            Ok(())
        })
    }

    /// Persist a member probe. Returns whether the stored status changed.
    pub fn project_set_member_status(&self, project_id: ProjectId, path: &str, status: MemberStatus) -> Result<bool> {
        self.with(|c| {
            Ok(c.execute(
                "UPDATE project_members SET status = ?3 WHERE project_id = ?1 AND path = ?2 AND status != ?3",
                params![project_id.to_string(), path, status_str(status)],
            )? > 0)
        })
    }
}

pub(crate) fn write_members(c: &Connection, project_id: ProjectId, paths: &[String]) -> Result<()> {
    let id = project_id.to_string();
    let mut kept: HashMap<String, (String, String)> = HashMap::new();
    {
        let mut st = c.prepare("SELECT path, status, added_at FROM project_members WHERE project_id = ?1")?;
        let rows = st.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        for row in rows {
            let (path, status, added_at) = row?;
            kept.insert(path, (status, added_at));
        }
    }
    c.execute("DELETE FROM project_members WHERE project_id = ?1", [&id])?;
    let now = Utc::now().to_rfc3339();
    for (position, path) in paths.iter().enumerate() {
        let (status, added_at) = kept.remove(path).unwrap_or_else(|| ("ok".into(), now.clone()));
        c.execute(
            "INSERT INTO project_members(project_id, path, position, status, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, path, position as i64, status, added_at],
        )?;
    }
    Ok(())
}

/// Fill `members` for the group projects among `projects` with one query.
pub(crate) fn attach_members(c: &Connection, projects: &mut [Project]) -> Result<()> {
    if !projects.iter().any(|p| p.kind == ProjectKind::Group) {
        return Ok(());
    }
    let mut by_project: HashMap<String, Vec<(String, MemberStatus)>> = HashMap::new();
    let mut st = c.prepare("SELECT project_id, path, status FROM project_members ORDER BY project_id, position")?;
    let rows = st.query_map([], |r| {
        let status: String = r.get(2)?;
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, parse_status(&status).map_err(other)?))
    })?;
    for row in rows {
        let (project, path, status) = row?;
        by_project.entry(project).or_default().push((path, status));
    }
    for project in projects.iter_mut().filter(|p| p.kind == ProjectKind::Group) {
        let rows = by_project.remove(&project.id.to_string()).unwrap_or_default();
        let paths: Vec<&str> = rows.iter().map(|(path, _)| path.as_str()).collect();
        let names = member_display_names(&project.path, &paths);
        project.members = rows
            .into_iter()
            .zip(names)
            .map(|((path, status), name)| ProjectMember { path, name, status })
            .collect();
    }
    Ok(())
}

/// Display names for member paths: the last component, the parent segment too when
/// two members share it ("a/api", "b/api"), and the folder's own name for ".".
pub fn member_display_names(folder: &str, paths: &[&str]) -> Vec<String> {
    let last = |path: &str| path.rsplit('/').next().unwrap_or(path).to_string();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for path in paths.iter().filter(|p| **p != GROUP_FOLDER_MEMBER) {
        *counts.entry(last(path)).or_default() += 1;
    }
    paths
        .iter()
        .map(|path| {
            if *path == GROUP_FOLDER_MEMBER {
                return folder_name(folder);
            }
            let name = last(path);
            if counts.get(&name).copied().unwrap_or(0) > 1 {
                let mut parts = path.rsplitn(3, '/');
                let leaf = parts.next().unwrap_or_default();
                match parts.next() {
                    Some(parent) => format!("{parent}/{leaf}"),
                    None => leaf.to_string(),
                }
            } else {
                name
            }
        })
        .collect()
}

/// The last component of an absolute folder path, on any platform.
pub fn folder_name(folder: &str) -> String {
    std::path::Path::new(folder)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_string())
}

pub(crate) fn status_str(status: MemberStatus) -> &'static str {
    match status {
        MemberStatus::Ok => "ok",
        MemberStatus::Missing => "missing",
        MemberStatus::NotGit => "not_git",
    }
}

fn parse_status(value: &str) -> std::result::Result<MemberStatus, std::io::Error> {
    match value {
        "ok" => Ok(MemberStatus::Ok),
        "missing" => Ok(MemberStatus::Missing),
        "not_git" => Ok(MemberStatus::NotGit),
        other => Err(std::io::Error::other(format!("unknown member status {other}"))),
    }
}

pub(crate) fn parse_kind(value: &str) -> ProjectKind {
    match value {
        "group" => ProjectKind::Group,
        _ => ProjectKind::Single,
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use kybern_protocol::*;
    use uuid::Uuid;

    use super::*;

    fn group(store: &Store, members: &[&str]) -> Project {
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "acme".into(),
            path: format!("/tmp/{}/acme", Uuid::now_v7()),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: ProjectKind::Group,
            members: members
                .iter()
                .map(|path| ProjectMember { path: path.to_string(), name: String::new(), status: MemberStatus::Ok })
                .collect(),
            worktree_copy: vec!["Makefile".into()],
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        project
    }

    fn paths(project: &Project) -> Vec<&str> {
        project.members.iter().map(|m| m.path.as_str()).collect()
    }

    #[test]
    fn group_projects_store_kind_members_and_copy_list() {
        let store = Store::open_in_memory().unwrap();
        let project = group(&store, &[".", "a/api", "b/api", "web"]);
        let stored = store.project_get(project.id).unwrap().unwrap();
        assert_eq!(stored.kind, ProjectKind::Group);
        assert_eq!(paths(&stored), [".", "a/api", "b/api", "web"]);
        let names: Vec<&str> = stored.members.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["acme", "a/api", "b/api", "web"]);
        assert_eq!(stored.worktree_copy, ["Makefile"]);
        let listed = store.projects_list().unwrap().into_iter().find(|p| p.id == project.id).unwrap();
        assert_eq!(paths(&listed), paths(&stored));
        assert_eq!(store.project_by_path(&project.path).unwrap().unwrap().members.len(), 4);

        let mut edited = stored.clone();
        edited.instructions_offer_dismissed = true;
        edited.worktree_copy.clear();
        store.project_update(&edited).unwrap();
        let stored = store.project_get(project.id).unwrap().unwrap();
        assert!(stored.instructions_offer_dismissed);
        assert!(stored.worktree_copy.is_empty());
        assert_eq!(stored.members.len(), 4, "a project update leaves the members alone");
    }

    #[test]
    fn single_projects_have_no_members() {
        let store = Store::open_in_memory().unwrap();
        let mut project = group(&store, &[]);
        project.id = Uuid::now_v7();
        project.path = format!("/tmp/{}", Uuid::now_v7());
        project.kind = ProjectKind::Single;
        project.worktree_copy.clear();
        store.project_insert(&project).unwrap();
        let stored = store.project_get(project.id).unwrap().unwrap();
        assert_eq!(stored.kind, ProjectKind::Single);
        assert!(stored.members.is_empty());
        let json = serde_json::to_value(&stored).unwrap();
        assert!(json.get("kind").is_none() && json.get("members").is_none() && json.get("worktree_copy").is_none());
    }

    #[test]
    fn replacing_members_keeps_status_and_order_and_delete_cascades() {
        let store = Store::open_in_memory().unwrap();
        let project = group(&store, &["api", "web"]);
        assert!(store.project_set_member_status(project.id, "web", MemberStatus::Missing).unwrap());
        assert!(!store.project_set_member_status(project.id, "web", MemberStatus::Missing).unwrap(), "unchanged probes stay quiet");
        store.project_set_members(project.id, &["infra".into(), "web".into()]).unwrap();
        let members = store.project_members(project.id).unwrap();
        assert_eq!(members.iter().map(|m| (m.path.as_str(), m.status)).collect::<Vec<_>>(), [
            ("infra", MemberStatus::Ok),
            ("web", MemberStatus::Missing)
        ]);
        store.project_delete(project.id).unwrap();
        let left: i64 = store.with(|c| Ok(c.query_row("SELECT COUNT(*) FROM project_members", [], |r| r.get(0))?)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn thread_member_snapshots_and_group_checkpoints_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        let project = group(&store, &["api", "web"]);
        let now = Utc::now();
        let member = |path: &str| ThreadMember {
            path: path.into(),
            name: path.into(),
            included: true,
            source_path: format!("{}/{path}", project.path),
            worktree: None,
            base_branch: Some("main".into()),
            base_commit: None,
            worktree_state: None,
            missing: false,
        };
        let mut thread: Thread = serde_json::from_value(serde_json::json!({
            "id": Uuid::now_v7(), "project_id": project.id, "title": "t",
            "provider": { "kind": "codex", "instance": "default" }, "permission_mode": "supervised",
            "status": "idle", "cwd": project.path, "pinned": false, "created_at": now, "updated_at": now, "last_seq": 0,
        }))
        .unwrap();
        thread.members = vec![member("api"), member("web")];
        store.thread_upsert(&thread).unwrap();
        assert_eq!(store.thread_get(thread.id).unwrap().unwrap().members, thread.members);
        // A write without members (an older code path) keeps the snapshot.
        let mut bare = thread.clone();
        bare.members.clear();
        bare.title = "renamed".into();
        store.thread_upsert(&bare).unwrap();
        let stored = store.thread_get(thread.id).unwrap().unwrap();
        assert_eq!((stored.title.as_str(), stored.members.len()), ("renamed", 2));
        assert_eq!(store.threads_list(Some(project.id), false).unwrap()[0].members.len(), 2);

        let turn_id = Uuid::now_v7();
        let repo = |repo: &str, before: &str, after: Option<&str>| RepoCheckpoint {
            repo: repo.into(),
            before: before.into(),
            after: after.map(Into::into),
        };
        let start = Checkpoint {
            thread_id: thread.id,
            turn_id,
            before: "a1".into(),
            after: None,
            provider_turn_id: None,
            provider_turn_end: None,
            created_at: now,
            repos: vec![repo("api", "a1", None), repo("web", "w1", None)],
            incomplete: true,
        };
        store.checkpoint_upsert(&start).unwrap();
        let end = Checkpoint {
            after: Some("a2".into()),
            repos: vec![repo("api", "ignored", Some("a2")), repo("web", "ignored", Some("w2"))],
            incomplete: false,
            ..start.clone()
        };
        store.checkpoint_upsert(&end).unwrap();
        let stored = store.checkpoint_get(turn_id).unwrap().unwrap();
        assert_eq!(stored.repos, [repo("api", "a1", Some("a2")), repo("web", "w1", Some("w2"))]);
        assert!(stored.incomplete, "an incomplete snapshot stays incomplete");
        assert_eq!(store.checkpoints_for_thread(thread.id).unwrap()[0].repos.len(), 2);
    }

    #[test]
    fn display_names_disambiguate_shared_leaf_names() {
        assert_eq!(member_display_names("/w/acme", &[".", "api", "svc/web", "apps/web"]), ["acme", "api", "svc/web", "apps/web"]);
        assert_eq!(member_display_names("/w/acme", &["x/y/api", "z/api"]), ["y/api", "z/api"]);
    }
}
