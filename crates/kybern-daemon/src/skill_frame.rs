//! A skill from another agent's folder, used in a thread that runs a different agent (#219).
//!
//! The composer's `$` picker lists those under "Other agents" and sends them as an ordinary `Skill` part. The agent running
//! the turn cannot load it (the folder is not one it reads), so its copy of the message carries the skill instead: its name,
//! its folder and its `SKILL.md`, framed as the user's instruction. Nothing is written to disk, so every agent gets it the same
//! way and the source never drifts from a copy. A skill the agent reads itself keeps its native invocation; the stored message
//! keeps the chip either way.

use std::path::{Path, PathBuf};

use kybern_protocol::{ContentPart, ProviderKind, SkillHome, UserMessage};

/// The `SKILL.md` text a message carries before it is cut; the rest is left on disk, and the frame says where.
const MAX_BODY_BYTES: usize = 24 * 1024;
const SKILL_FILE: &str = "SKILL.md";

/// The provider's copy of `message`, or `None` when no skill in it comes from a home `provider` does not read.
/// `homes` are the user skill folders (`SkillHomes::resolve`).
pub(crate) fn expand(message: &UserMessage, provider: ProviderKind, homes: &[(SkillHome, PathBuf)]) -> Option<UserMessage> {
    let foreign: Vec<Option<PathBuf>> = message
        .parts
        .iter()
        .map(|part| match part {
            ContentPart::Skill { path, .. } => foreign_skill(Path::new(path), provider, homes),
            _ => None,
        })
        .collect();
    if foreign.iter().all(Option::is_none) {
        return None;
    }
    let parts = message
        .parts
        .iter()
        .zip(foreign)
        .map(|(part, file)| match (part, file) {
            (ContentPart::Skill { name, .. }, Some(file)) => ContentPart::Text { text: frame(name, &file) },
            _ => part.clone(),
        })
        .collect();
    Some(UserMessage { parts })
}

/// The canonical `SKILL.md` of a skill that sits in a home `provider` does not read. A path that is not a `SKILL.md`, or
/// is outside every home, is never read: the daemon opens only skill files the user keeps in their own skill folders.
fn foreign_skill(path: &Path, provider: ProviderKind, homes: &[(SkillHome, PathBuf)]) -> Option<PathBuf> {
    if path.file_name().and_then(|name| name.to_str()) != Some(SKILL_FILE) {
        return None;
    }
    let file = std::fs::canonicalize(path).ok()?;
    homes
        .iter()
        .any(|(home, root)| !home.readers().contains(&provider) && std::fs::canonicalize(root).is_ok_and(|root| file.starts_with(root)))
        .then_some(file)
}

fn frame(name: &str, file: &Path) -> String {
    let folder = shown(file.parent().unwrap_or(file));
    let intro = format!(
        "Use the skill \"{name}\" for this request. It comes from another agent's skill folder, so it is given here rather than loaded for you. \
Its folder is {folder}; paths in it are relative to that folder."
    );
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(_) => return format!("{intro}\n\nIts {SKILL_FILE} could not be read."),
    };
    let (body, cut) = cap(&text, MAX_BODY_BYTES);
    let more = if cut { format!("\n[Cut here. Read the rest in {}]", shown(file)) } else { String::new() };
    format!("{intro}\n\n<skill name=\"{name}\" path=\"{}\">\n{}{more}\n</skill>", shown(file), body.trim_end())
}

/// A path as the agent should read it: without the `\\?\` prefix Windows adds when canonicalizing.
fn shown(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(text)
}

/// `text` cut to at most `max` bytes on a character boundary.
fn cap(text: &str, max: usize) -> (&str, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Home(PathBuf);
    impl Home {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("kybern-skill-frame-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn skill(&self, home: &str, name: &str, body: &str) -> PathBuf {
            let folder = self.0.join(home).join(name);
            std::fs::create_dir_all(&folder).unwrap();
            let file = folder.join(SKILL_FILE);
            std::fs::write(&file, body).unwrap();
            file
        }
        fn homes(&self) -> Vec<(SkillHome, PathBuf)> {
            vec![(SkillHome::Claude, self.0.join("claude")), (SkillHome::Agents, self.0.join("agents"))]
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn message(name: &str, path: &Path) -> UserMessage {
        UserMessage {
            parts: vec![
                ContentPart::Text { text: "Use ".into() },
                ContentPart::Skill { name: name.into(), path: path.to_string_lossy().into_owned() },
                ContentPart::Text { text: " now".into() },
            ],
        }
    }

    #[test]
    fn a_skill_from_another_agents_home_becomes_its_text_in_the_providers_copy() {
        let tree = Home::new();
        let file = tree.skill("claude", "polish", "---\nname: polish\n---\nMake it tidy.");
        let stored = message("polish", &file);
        let copy = expand(&stored, ProviderKind::Codex, &tree.homes()).expect("codex does not read the Claude folder");
        let ContentPart::Text { text } = &copy.parts[1] else { panic!("the skill part is replaced by text") };
        assert!(text.contains("\"polish\"") && text.contains("Make it tidy.") && text.contains("<skill name=\"polish\""), "{text}");
        assert!(text.contains(&shown(&tree.0.join("claude").join("polish").canonicalize().unwrap())), "names the folder: {text}");
        // The text around it stays, and the stored message still holds the chip.
        assert_eq!(copy.parts[0], stored.parts[0]);
        assert_eq!(copy.parts[2], stored.parts[2]);
        assert!(matches!(stored.parts[1], ContentPart::Skill { .. }));
    }

    #[test]
    fn a_skill_the_agent_reads_itself_is_left_to_its_native_invocation() {
        let tree = Home::new();
        let claude = tree.skill("claude", "polish", "Body");
        let shared = tree.skill("agents", "review", "Body");
        // Claude Code reads the Claude folder, Codex the shared one.
        assert!(expand(&message("polish", &claude), ProviderKind::ClaudeCode, &tree.homes()).is_none());
        assert!(expand(&message("review", &shared), ProviderKind::Codex, &tree.homes()).is_none());
        // A skill outside every home (a project's own, a plugin's) is never touched.
        let project = tree.skill("project", "local", "Body");
        assert!(expand(&message("local", &project), ProviderKind::Codex, &tree.homes()).is_none());
    }

    #[test]
    fn only_a_skill_file_inside_a_home_is_ever_read() {
        let tree = Home::new();
        std::fs::create_dir_all(tree.0.join("claude/notes")).unwrap();
        let other = tree.0.join("claude/notes/secret.txt");
        std::fs::write(&other, "private").unwrap();
        assert!(expand(&message("x", &other), ProviderKind::Codex, &tree.homes()).is_none());
        let missing = tree.0.join("claude/gone/SKILL.md");
        assert!(expand(&message("gone", &missing), ProviderKind::Codex, &tree.homes()).is_none());
    }

    #[test]
    fn a_long_skill_is_cut_and_says_where_the_rest_is() {
        let tree = Home::new();
        let file = tree.skill("claude", "big", &"é".repeat(MAX_BODY_BYTES));
        let copy = expand(&message("big", &file), ProviderKind::Pi, &tree.homes()).unwrap();
        let ContentPart::Text { text } = &copy.parts[1] else { panic!() };
        assert!(text.contains("[Cut here. Read the rest in") && text.len() < MAX_BODY_BYTES + 1024);
    }
}
