//! Spaces: groups of projects. Every project except free chat is in exactly one.
//!
//! `spaces.delete` moves its projects in the same transaction that removes the
//! row, so the `projects.space_id` reference has no `ON DELETE` action.

use anyhow::Result;
use kybern_protocol::{ProjectId, Space, SpaceColor, SpaceId, SpaceLogo, is_free_chat_project};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{Store, other, parse_time, parse_uuid};

/// A failure the caller can act on. Everything else is an internal error.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SpaceError {
    #[error("{0}")]
    NotFound(&'static str),
    #[error("You can't delete your only space.")]
    OnlySpace,
    #[error("List every space exactly once to reorder them.")]
    NotAPermutation,
    #[error("Free chat isn't in a space.")]
    FreeChat,
}

const SPACE_SELECT: &str = "SELECT id, name, color, logo, position, created_at, updated_at FROM spaces";

impl Store {
    /// Every space in rail order.
    pub fn spaces_list(&self) -> Result<Vec<Space>> {
        self.with(list_spaces)
    }

    pub fn space_get(&self, id: SpaceId) -> Result<Option<Space>> {
        self.with(|c| Ok(c.query_row(&format!("{SPACE_SELECT} WHERE id = ?1"), [id.to_string()], row_to_space).optional()?))
    }

    /// Insert a space at the end of the rail. The stored `position` of `space` is ignored.
    pub fn space_insert(&self, space: &Space) -> Result<Space> {
        self.with(|c| {
            c.execute(
                "INSERT INTO spaces(id, name, color, logo, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(position), -1) + 1 FROM spaces), ?5, ?6)",
                params![
                    space.id.to_string(),
                    space.name,
                    space.color.as_str(),
                    serde_json::to_string(&space.logo)?,
                    space.created_at.to_rfc3339(),
                    space.updated_at.to_rfc3339()
                ],
            )?;
            Ok(c.query_row(&format!("{SPACE_SELECT} WHERE id = ?1"), [space.id.to_string()], row_to_space)?)
        })
    }

    /// Write the name, colour, logo and `updated_at`. Returns whether the space exists.
    pub fn space_update(&self, space: &Space) -> Result<bool> {
        self.with(|c| {
            Ok(c.execute(
                "UPDATE spaces SET name = ?2, color = ?3, logo = ?4, updated_at = ?5 WHERE id = ?1",
                params![
                    space.id.to_string(),
                    space.name,
                    space.color.as_str(),
                    serde_json::to_string(&space.logo)?,
                    space.updated_at.to_rfc3339()
                ],
            )? > 0)
        })
    }

    /// Delete a space, moving its projects to the space directly above it (or
    /// the next one when it is the first). Returns that space and how many
    /// projects moved.
    pub fn space_delete_moving(&self, id: SpaceId) -> Result<(SpaceId, u32)> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let spaces = list_spaces(&tx)?;
            let index = spaces.iter().position(|s| s.id == id).ok_or(SpaceError::NotFound("space"))?;
            if spaces.len() < 2 {
                return Err(SpaceError::OnlySpace.into());
            }
            let target = if index == 0 { spaces[1].id } else { spaces[index - 1].id };
            let moved = tx.execute("UPDATE projects SET space_id = ?1 WHERE space_id = ?2", params![target.to_string(), id.to_string()])?;
            tx.execute("DELETE FROM spaces WHERE id = ?1", [id.to_string()])?;
            let remaining: Vec<SpaceId> = spaces.iter().map(|s| s.id).filter(|s| *s != id).collect();
            write_positions(&tx, &remaining)?;
            tx.commit()?;
            Ok((target, moved as u32))
        })
    }

    /// Reorder the rail. `ids` must hold every space exactly once.
    pub fn spaces_reorder(&self, ids: &[SpaceId]) -> Result<()> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let mut current: Vec<SpaceId> = list_spaces(&tx)?.into_iter().map(|s| s.id).collect();
            let mut wanted = ids.to_vec();
            current.sort();
            wanted.sort();
            if current != wanted {
                return Err(SpaceError::NotAPermutation.into());
            }
            write_positions(&tx, ids)?;
            tx.commit()?;
            Ok(())
        })
    }

    /// Move a project to a space. Returns whether a row changed. Free chat is refused.
    pub fn project_set_space(&self, project_id: ProjectId, space_id: SpaceId) -> Result<bool> {
        if is_free_chat_project(project_id) {
            return Err(SpaceError::FreeChat.into());
        }
        self.with(|c| {
            Ok(c.execute(
                "UPDATE projects SET space_id = ?2, updated_at = ?3 WHERE id = ?1 AND space_id IS NOT ?2",
                params![project_id.to_string(), space_id.to_string(), chrono::Utc::now().to_rfc3339()],
            )? > 0)
        })
    }
}

fn list_spaces(c: &Connection) -> Result<Vec<Space>> {
    let mut st = c.prepare(&format!("{SPACE_SELECT} ORDER BY position, created_at"))?;
    let rows = st.query_map([], row_to_space)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn write_positions(c: &Connection, ids: &[SpaceId]) -> Result<()> {
    for (position, id) in ids.iter().enumerate() {
        c.execute("UPDATE spaces SET position = ?2 WHERE id = ?1", params![id.to_string(), position as i64])?;
    }
    Ok(())
}

fn row_to_space(r: &rusqlite::Row<'_>) -> rusqlite::Result<Space> {
    Ok(Space {
        id: parse_uuid(r.get::<_, String>(0)?)?,
        name: r.get(1)?,
        color: SpaceColor::from_stored(&r.get::<_, String>(2)?),
        logo: serde_json::from_str::<SpaceLogo>(&r.get::<_, String>(3)?).map_err(other)?,
        position: r.get::<_, i64>(4)?.max(0) as u32,
        created_at: parse_time(r.get::<_, String>(5)?)?,
        updated_at: parse_time(r.get::<_, String>(6)?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use kybern_protocol::{FREE_CHAT_PROJECT_ID, Project};
    use uuid::Uuid;

    fn space(name: &str) -> Space {
        let now = Utc::now();
        Space {
            id: Uuid::now_v7(),
            name: name.into(),
            color: SpaceColor::Blue,
            logo: SpaceLogo::Initials,
            position: 99,
            created_at: now,
            updated_at: now,
        }
    }

    fn project(path: &str, space_id: Option<SpaceId>) -> Project {
        let now = Utc::now();
        Project {
            id: Uuid::now_v7(),
            name: path.trim_start_matches('/').into(),
            path: path.into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id,
            created_at: now,
            updated_at: now,
        }
    }

    fn store_with_spaces(names: &[&str]) -> (Store, Vec<Space>) {
        let store = Store::open_in_memory().unwrap();
        // A fresh database has the migration's default space; drop it so tests control the list.
        let seeded = store.spaces_list().unwrap();
        for n in names {
            store.space_insert(&space(n)).unwrap();
        }
        for s in seeded {
            store.space_delete_moving(s.id).unwrap();
        }
        let spaces = store.spaces_list().unwrap();
        (store, spaces)
    }

    #[test]
    fn fresh_databases_start_with_personal() {
        let store = Store::open_in_memory().unwrap();
        let spaces = store.spaces_list().unwrap();
        assert_eq!(spaces.len(), 1);
        assert_eq!(spaces[0].name, "Personal");
        assert_eq!(spaces[0].position, 0);
    }

    #[test]
    fn upgrading_a_v26_database_puts_every_project_in_personal() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::schema::migrate_to(&conn, 26).unwrap();
        for (id, path) in
            [(Uuid::now_v7().to_string(), "/a"), (Uuid::now_v7().to_string(), "/b"), (FREE_CHAT_PROJECT_ID.to_string(), "/chat")]
        {
            conn.execute(
                "INSERT INTO projects(id, name, path, is_git, created_at, updated_at) VALUES (?1, ?1, ?2, 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
                params![id, path],
            )
            .unwrap();
        }
        crate::schema::migrate(&conn).unwrap();
        let (id, name, color, logo, position): (String, String, String, String, i64) = conn
            .query_row("SELECT id, name, color, logo, position FROM spaces", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        assert_eq!((name.as_str(), color.as_str(), position), ("Personal", "green", 0));
        assert_eq!(serde_json::from_str::<SpaceLogo>(&logo).unwrap(), SpaceLogo::Initials);
        let parsed: Uuid = id.parse().unwrap();
        assert_eq!(parsed.get_version_num(), 4);
        let in_personal: i64 = conn.query_row("SELECT COUNT(*) FROM projects WHERE space_id = ?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(in_personal, 2);
        let chat: Option<String> =
            conn.query_row("SELECT space_id FROM projects WHERE id = ?1", [FREE_CHAT_PROJECT_ID.to_string()], |r| r.get(0)).unwrap();
        assert_eq!(chat, None);
    }

    #[test]
    fn project_insert_lands_in_the_first_space_or_the_named_one() {
        let (store, spaces) = store_with_spaces(&["Work", "Home"]);
        let a = project("/a", None);
        store.project_insert(&a).unwrap();
        assert_eq!(store.project_get(a.id).unwrap().unwrap().space_id, Some(spaces[0].id));
        let b = project("/b", Some(spaces[1].id));
        store.project_insert(&b).unwrap();
        assert_eq!(store.project_get(b.id).unwrap().unwrap().space_id, Some(spaces[1].id));
        assert_eq!(store.projects_list().unwrap().iter().find(|p| p.id == b.id).unwrap().space_id, Some(spaces[1].id));
    }

    #[test]
    fn delete_moves_projects_up_and_renumbers() {
        let (store, spaces) = store_with_spaces(&["One", "Two", "Three"]);
        let mid = project("/mid", Some(spaces[1].id));
        let last = project("/last", Some(spaces[2].id));
        store.project_insert(&mid).unwrap();
        store.project_insert(&last).unwrap();
        // Middle: projects go to the space above.
        assert_eq!(store.space_delete_moving(spaces[1].id).unwrap(), (spaces[0].id, 1));
        assert_eq!(store.project_get(mid.id).unwrap().unwrap().space_id, Some(spaces[0].id));
        let left = store.spaces_list().unwrap();
        assert_eq!(left.iter().map(|s| (s.id, s.position)).collect::<Vec<_>>(), vec![(spaces[0].id, 0), (spaces[2].id, 1)]);
        // First: projects go to the next space.
        assert_eq!(store.space_delete_moving(spaces[0].id).unwrap(), (spaces[2].id, 1));
        assert_eq!(store.project_get(mid.id).unwrap().unwrap().space_id, Some(spaces[2].id));
        // The only space cannot go.
        let err = store.space_delete_moving(spaces[2].id).unwrap_err();
        assert_eq!(err.downcast_ref::<SpaceError>(), Some(&SpaceError::OnlySpace));
        let err = store.space_delete_moving(Uuid::now_v7()).unwrap_err();
        assert_eq!(err.downcast_ref::<SpaceError>(), Some(&SpaceError::NotFound("space")));
    }

    #[test]
    fn reorder_needs_a_permutation() {
        let (store, spaces) = store_with_spaces(&["One", "Two", "Three"]);
        let (a, b, c) = (spaces[0].id, spaces[1].id, spaces[2].id);
        store.spaces_reorder(&[c, a, b]).unwrap();
        assert_eq!(store.spaces_list().unwrap().iter().map(|s| (s.id, s.position)).collect::<Vec<_>>(), vec![(c, 0), (a, 1), (b, 2)]);
        for bad in [vec![a, b], vec![a, a, b], vec![a, b, c, Uuid::now_v7()], vec![a, b, Uuid::now_v7()]] {
            let err = store.spaces_reorder(&bad).unwrap_err();
            assert_eq!(err.downcast_ref::<SpaceError>(), Some(&SpaceError::NotAPermutation));
        }
    }

    #[test]
    fn project_set_space_refuses_free_chat_and_update_leaves_the_space_alone() {
        let (store, spaces) = store_with_spaces(&["One", "Two"]);
        let mut p = project("/p", Some(spaces[0].id));
        store.project_insert(&p).unwrap();
        assert!(store.project_set_space(p.id, spaces[1].id).unwrap());
        assert!(!store.project_set_space(p.id, spaces[1].id).unwrap());
        // A rename built from a stale copy must not undo the move.
        p.name = "renamed".into();
        store.project_update(&p).unwrap();
        let stored = store.project_get(p.id).unwrap().unwrap();
        assert_eq!((stored.name.as_str(), stored.space_id), ("renamed", Some(spaces[1].id)));
        let err = store.project_set_space(FREE_CHAT_PROJECT_ID, spaces[0].id).unwrap_err();
        assert_eq!(err.downcast_ref::<SpaceError>(), Some(&SpaceError::FreeChat));
    }

    #[test]
    fn unknown_colours_read_as_blue() {
        let (store, spaces) = store_with_spaces(&["One"]);
        store.with(|c| Ok(c.execute("UPDATE spaces SET color = 'chartreuse'", [])?)).unwrap();
        assert_eq!(store.space_get(spaces[0].id).unwrap().unwrap().color, SpaceColor::Blue);
    }
}
