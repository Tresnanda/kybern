//! Media kept outside the event log (issue #298).
//!
//! Agents read images and PDFs and take screenshots; their tool results, and
//! images pasted into prompts, used to be stored in `events.payload` as base64.
//! One boundary, [`externalize_payload`], runs before every event is written:
//! a base64 block above [`MEDIA_INLINE_MAX_BASE64`] characters is written to
//! `<data dir>/assets/<sha256>` (once per distinct content) and replaced by a
//! typed [`MediaRef`]. [`inline_value`] and [`inline_message`] restore the exact
//! original value for anything that hands it to a provider again.
//!
//! The replacement keeps the result's structure: the string becomes the
//! one-entry object `{"kybern_media": MediaRef}` at the same place, and a
//! user message's `image` part becomes a `media` part.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine;
use kybern_protocol::{ContentPart, EventPayload, MEDIA_INLINE_MAX_BASE64, MEDIA_REF_KEY, MediaEncoding, MediaRef, UserMessage};
use serde_json::Value;
use sha2::{Digest, Sha256};

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Keys whose string value is the bytes of a block (`source.data`, Claude's
/// `file.base64`, a generated image's `result`). Other keys keep their value.
const BYTES_KEYS: &[&str] = &["data", "base64", "result", "image", "bytes", "blob"];

/// Nesting deeper than this is left as it is.
const MAX_DEPTH: usize = 64;

/// Where media files live: the data folder's `assets/`, beside uploads.
#[derive(Debug, Clone)]
pub struct MediaDir(PathBuf);

impl MediaDir {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// The file for `hash`, or `None` when `hash` is not a SHA-256 in lowercase hex.
    pub fn file(&self, hash: &str) -> Option<PathBuf> {
        is_hash(hash).then(|| self.0.join(hash))
    }

    pub fn read(&self, media: &MediaRef) -> Result<Vec<u8>> {
        let path = self.file(&media.hash).with_context(|| format!("not a media hash: {}", media.hash))?;
        std::fs::read(&path).with_context(|| format!("read media {}", path.display()))
    }

    /// Store `bytes` under their hash. A file that is already there with the
    /// same length is reused, and touched so the sweep, which spares files
    /// changed within its grace period, cannot delete it before the event that
    /// now refers to it is written. The bytes are flushed to disk before this
    /// returns, so a reference written afterwards never points at a partial file.
    pub fn write(&self, bytes: &[u8]) -> Result<String> {
        let hash = hex_sha256(bytes);
        let path = self.0.join(&hash);
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() == bytes.len() as u64) && touch(&path) {
            return Ok(hash);
        }
        std::fs::create_dir_all(&self.0).with_context(|| format!("create {}", self.0.display()))?;
        let temp = self.0.join(format!(".{hash}.{}.part", uuid::Uuid::new_v4().simple()));
        let written = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::create(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temp);
            return Err(error).with_context(|| format!("write media {}", temp.display()));
        }
        if let Err(error) = std::fs::rename(&temp, &path) {
            let _ = std::fs::remove_file(&temp);
            // Another writer stored the same content first.
            if !std::fs::metadata(&path).is_ok_and(|meta| meta.len() == bytes.len() as u64) {
                return Err(error).with_context(|| format!("store media {}", path.display()));
            }
        }
        sync_dir(&self.0);
        Ok(hash)
    }
}

/// Mark a reused file as just written. False when it is gone (the sweep took it), so it is written again.
fn touch(path: &Path) -> bool {
    std::fs::OpenOptions::new().write(true).open(path).and_then(|file| file.set_modified(std::time::SystemTime::now())).is_ok()
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(dir) = std::fs::File::open(dir) {
        let _ = dir.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

pub fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The media type the bytes start with, for blocks that do not name one.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") {
        Some("image/avif")
    } else if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else {
        None
    }
}

/// Bytes of a strict base64 string that encodes back to exactly the same text,
/// so restoring it gives the provider the value it sent.
fn strict_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = BASE64.decode(text).ok()?;
    (base64::encoded_len(bytes.len(), true) == Some(text.len()) && BASE64.encode(&bytes) == text).then_some(bytes)
}

/// `data:<mime>;base64,<payload>` in exactly that form.
fn split_data_url(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    let valid_mime = mime.split_once('/').is_some_and(|(kind, sub)| {
        let token = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b));
        token(kind) && token(sub)
    });
    valid_mime.then_some((mime, payload))
}

/// Writes media files and collects the references it made.
pub struct Externalizer<'a> {
    dir: &'a MediaDir,
    pub made: Vec<MediaRef>,
}

impl<'a> Externalizer<'a> {
    pub fn new(dir: &'a MediaDir) -> Self {
        Self { dir, made: Vec::new() }
    }

    fn store(&mut self, bytes: &[u8], mime: &str, encoding: MediaEncoding) -> Result<MediaRef> {
        let hash = self.dir.write(bytes)?;
        let media = MediaRef { hash, mime: mime.to_string(), size: bytes.len() as u64, encoding };
        self.made.push(media.clone());
        Ok(media)
    }

    /// A data URL above the limit becomes a reference.
    fn data_url(&mut self, text: &str) -> Result<Option<MediaRef>> {
        if text.len() <= MEDIA_INLINE_MAX_BASE64 {
            return Ok(None);
        }
        let Some((mime, payload)) = split_data_url(text) else { return Ok(None) };
        let Some(bytes) = strict_base64(payload) else { return Ok(None) };
        self.store(&bytes, mime, MediaEncoding::DataUrl).map(Some)
    }

    /// A plain base64 value above the limit, of a block that names its type or
    /// whose bytes are a known image or PDF.
    fn base64(&mut self, text: &str, hint: Option<&str>) -> Result<Option<MediaRef>> {
        if text.len() <= MEDIA_INLINE_MAX_BASE64 {
            return Ok(None);
        }
        let Some(bytes) = strict_base64(text) else { return Ok(None) };
        let Some(mime) = hint.map(str::to_string).or_else(|| sniff(&bytes).map(str::to_string)) else { return Ok(None) };
        self.store(&bytes, &mime, MediaEncoding::Base64).map(Some)
    }

    pub fn value(&mut self, value: &mut Value) -> Result<()> {
        self.walk(value, 0)
    }

    fn walk(&mut self, value: &mut Value, depth: usize) -> Result<()> {
        if depth > MAX_DEPTH {
            return Ok(());
        }
        match value {
            Value::String(text) => {
                if let Some(media) = self.data_url(text)? {
                    *value = marker(media);
                }
            }
            Value::Array(items) => {
                for item in items {
                    self.walk(item, depth + 1)?;
                }
            }
            Value::Object(map) => {
                if media_marker(map).is_some() {
                    return Ok(());
                }
                let hint = mime_hint(map);
                for (key, child) in map.iter_mut() {
                    match child {
                        Value::String(text) if text.len() > MEDIA_INLINE_MAX_BASE64 => {
                            let made = match self.data_url(text)? {
                                Some(media) => Some(media),
                                None if BYTES_KEYS.contains(&key.as_str()) => self.base64(text, hint.as_deref())?,
                                None => None,
                            };
                            if let Some(media) = made {
                                *child = marker(media);
                            }
                        }
                        Value::String(_) => {}
                        _ => self.walk(child, depth + 1)?,
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn message(&mut self, message: &mut UserMessage) -> Result<()> {
        for part in &mut message.parts {
            if let ContentPart::Image { media_type, data } = part
                && data.len() > MEDIA_INLINE_MAX_BASE64
                && let Some(bytes) = strict_base64(data)
            {
                let media = self.store(&bytes, media_type, MediaEncoding::Base64)?;
                *part = ContentPart::Media { media };
            }
        }
        Ok(())
    }

    /// Move the large media of one event out of its payload.
    pub fn payload(&mut self, payload: &mut EventPayload) -> Result<()> {
        match payload {
            EventPayload::ToolCallCompleted { output, .. } => self.value(output),
            EventPayload::TurnStarted { message, .. }
            | EventPayload::MessageSteered { message, .. }
            | EventPayload::AsyncQuestionsAnswered { message, .. } => self.message(message),
            EventPayload::MessageQueued { message } | EventPayload::MessageQueueUpdated { message } => self.message(&mut message.message),
            EventPayload::VisualAnswered { message: Some(message), .. } => self.message(message),
            EventPayload::ImageReceived { source, media, .. } if media.is_none() => {
                if let Some(made) = self.data_url(source)? {
                    *media = Some(made);
                    source.clear();
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

/// The media type a block names for its bytes.
fn mime_hint(map: &serde_json::Map<String, Value>) -> Option<String> {
    for key in ["media_type", "mimeType", "mime_type", "mime", "type"] {
        if let Some(Value::String(mime)) = map.get(key)
            && mime.contains('/')
        {
            return Some(mime.clone());
        }
    }
    if map.get("type").and_then(Value::as_str) == Some("imageGeneration") {
        let format = map.get("outputFormat").and_then(Value::as_str).filter(|f| matches!(*f, "jpeg" | "webp")).unwrap_or("png");
        return Some(format!("image/{format}"));
    }
    None
}

fn marker(media: MediaRef) -> Value {
    let mut map = serde_json::Map::new();
    map.insert(MEDIA_REF_KEY.into(), serde_json::to_value(media).expect("media reference serializes"));
    Value::Object(map)
}

/// The reference a `{"kybern_media": …}` object holds.
pub fn media_marker(map: &serde_json::Map<String, Value>) -> Option<MediaRef> {
    if map.len() != 1 {
        return None;
    }
    serde_json::from_value(map.get(MEDIA_REF_KEY)?.clone()).ok()
}

/// Move the large media of `payload` to `dir`. Returns the references the
/// payload holds afterwards, including ones it already held.
#[cfg(test)]
pub fn externalize_payload(payload: &mut EventPayload, dir: &MediaDir) -> Result<Vec<MediaRef>> {
    let mut externalizer = Externalizer::new(dir);
    externalizer.payload(payload)?;
    Ok(payload_refs(payload))
}

/// Every reference an event payload holds.
pub fn payload_refs(payload: &EventPayload) -> Vec<MediaRef> {
    fn message(message: &UserMessage, out: &mut Vec<MediaRef>) {
        out.extend(message.parts.iter().filter_map(|part| match part {
            ContentPart::Media { media } => Some(media.clone()),
            _ => None,
        }));
    }
    let mut out = Vec::new();
    match payload {
        EventPayload::ToolCallCompleted { output, .. } => value_refs(output, &mut out, 0),
        EventPayload::TurnStarted { message: m, .. }
        | EventPayload::MessageSteered { message: m, .. }
        | EventPayload::AsyncQuestionsAnswered { message: m, .. } => message(m, &mut out),
        EventPayload::MessageQueued { message: m } | EventPayload::MessageQueueUpdated { message: m } => message(&m.message, &mut out),
        EventPayload::VisualAnswered { message: Some(m), .. } => message(m, &mut out),
        EventPayload::ImageReceived { media: Some(media), .. } => out.push(media.clone()),
        _ => {}
    }
    out
}

pub fn value_refs(value: &Value, out: &mut Vec<MediaRef>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    match value {
        Value::Array(items) => items.iter().for_each(|item| value_refs(item, out, depth + 1)),
        Value::Object(map) => match media_marker(map) {
            Some(media) => out.push(media),
            None => map.values().for_each(|child| value_refs(child, out, depth + 1)),
        },
        _ => {}
    }
}

fn restore(media: &MediaRef, dir: &MediaDir) -> Result<String> {
    let encoded = BASE64.encode(dir.read(media)?);
    Ok(match media.encoding {
        MediaEncoding::Base64 => encoded,
        MediaEncoding::DataUrl => format!("data:{};base64,{encoded}", media.mime),
    })
}

/// Put the bytes back where references stand, for a provider or a driver.
pub fn inline_value(value: &mut Value, dir: &MediaDir) -> Result<()> {
    fn walk(value: &mut Value, dir: &MediaDir, depth: usize) -> Result<()> {
        if depth > MAX_DEPTH {
            return Ok(());
        }
        match value {
            Value::Array(items) => items.iter_mut().try_for_each(|item| walk(item, dir, depth + 1)),
            Value::Object(map) => match media_marker(map) {
                Some(media) => {
                    *value = Value::String(restore(&media, dir)?);
                    Ok(())
                }
                None => map.values_mut().try_for_each(|child| walk(child, dir, depth + 1)),
            },
            _ => Ok(()),
        }
    }
    walk(value, dir, 0)
}

/// Turn `media` parts back into inline `image` parts.
pub fn inline_message(message: &mut UserMessage, dir: &MediaDir) -> Result<()> {
    for part in &mut message.parts {
        if let ContentPart::Media { media } = part {
            let data = BASE64.encode(dir.read(media)?);
            *part = ContentPart::Image { media_type: media.mime.clone(), data };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn png(size: usize) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend((0..size).map(|i| (i * 31 % 251) as u8));
        bytes
    }

    #[test]
    fn tool_blocks_move_out_and_restore_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let media = MediaDir::new(dir.path());
        let image = BASE64.encode(png(40_000));
        let pdf = BASE64.encode([b"%PDF-1.7\n".as_slice(), &[7u8; 30_000]].concat());
        let original = json!([
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": image } },
            { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": pdf } },
            { "type": "input_image", "image_url": format!("data:image/png;base64,{image}") },
            { "type": "text", "text": "small", "data": "aGk=" },
            { "file": { "base64": image, "type": "image/png" } },
            { "type": "text", "text": "x".repeat(40_000) },
        ]);
        let mut value = original.clone();
        let mut externalizer = Externalizer::new(&media);
        externalizer.value(&mut value).unwrap();
        assert_eq!(externalizer.made.len(), 4);
        // The same image three times is stored once.
        let files = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(files, 2);
        assert_eq!(value[0]["source"]["data"][MEDIA_REF_KEY]["mime"], "image/png");
        assert_eq!(value[1]["source"]["data"][MEDIA_REF_KEY]["mime"], "application/pdf");
        assert_eq!(value[2]["image_url"][MEDIA_REF_KEY]["encoding"], "data_url");
        assert_eq!(value[3]["data"], "aGk=");
        assert_eq!(value[5]["text"].as_str().unwrap().len(), 40_000);
        assert!(serde_json::to_string(&value).unwrap().len() < 42_000);
        let mut refs = Vec::new();
        value_refs(&value, &mut refs, 0);
        assert_eq!(refs.len(), 4);
        inline_value(&mut value, &media).unwrap();
        assert_eq!(value, original);
    }

    #[test]
    fn unknown_or_loose_base64_stays_inline() {
        let dir = tempfile::tempdir().unwrap();
        let media = MediaDir::new(dir.path());
        // No type and bytes that are not an image: could be anything.
        let opaque = BASE64.encode(vec![1u8; 30_000]);
        // Wrapped base64 does not encode back to the same text.
        let wrapped =
            BASE64.encode(png(30_000)).as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("\n");
        let original = json!({ "data": opaque, "content": [{ "type": "image", "mimeType": "image/png", "data": wrapped }] });
        let mut value = original.clone();
        Externalizer::new(&media).value(&mut value).unwrap();
        assert_eq!(value, original);
        assert!(!dir.path().join("x").exists());
    }

    #[test]
    fn prompt_images_and_received_images_become_references() {
        let dir = tempfile::tempdir().unwrap();
        let media = MediaDir::new(dir.path());
        let data = BASE64.encode(png(20_000));
        let message = UserMessage {
            parts: vec![
                ContentPart::Text { text: "look".into() },
                ContentPart::Image { media_type: "image/png".into(), data: data.clone() },
                ContentPart::Image { media_type: "image/png".into(), data: "aGk=".into() },
            ],
        };
        let mut payload = EventPayload::TurnStarted { message_id: uuid::Uuid::nil(), message: message.clone() };
        let refs = externalize_payload(&mut payload, &media).unwrap();
        assert_eq!(refs.len(), 1);
        let EventPayload::TurnStarted { message: mut stored, .. } = payload else { unreachable!() };
        assert!(matches!(&stored.parts[1], ContentPart::Media { media } if media.size == 20_008 && media.mime == "image/png"));
        assert!(matches!(&stored.parts[2], ContentPart::Image { .. }));
        inline_message(&mut stored, &media).unwrap();
        assert_eq!(stored, message);

        let source = format!("data:image/png;base64,{data}");
        let mut received = EventPayload::ImageReceived { id: "i".into(), origin: Default::default(), source, media: None };
        assert_eq!(externalize_payload(&mut received, &media).unwrap().len(), 1);
        assert!(matches!(&received, EventPayload::ImageReceived { source, media: Some(_), .. } if source.is_empty()));
        // Externalizing again changes nothing.
        let before = serde_json::to_string(&received).unwrap();
        externalize_payload(&mut received, &media).unwrap();
        assert_eq!(serde_json::to_string(&received).unwrap(), before);
    }
}
