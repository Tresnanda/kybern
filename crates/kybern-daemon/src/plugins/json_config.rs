//! Read JSONC and replace one top-level property, preserving unrelated bytes and comments.
use serde_json::Value;
fn string_end(b: &[u8], start: usize) -> Result<usize, String> {
    let mut i = start + 1;
    while i < b.len() {
        if b[i] == b'\\' {
            i += 2;
        } else if b[i] == b'"' {
            return Ok(i + 1);
        } else {
            i += 1;
        }
    }
    Err("Unclosed JSON string".into())
}
fn cleaned(text: &str) -> Result<Vec<u8>, String> {
    let mut b = text.as_bytes().to_vec();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'"' {
            i = string_end(&b, i)?;
            continue;
        }
        if b.get(i..i + 2) == Some(b"//") {
            while i < b.len() && b[i] != b'\n' {
                b[i] = b' ';
                i += 1;
            }
        } else if b.get(i..i + 2) == Some(b"/*") {
            b[i] = b' ';
            b[i + 1] = b' ';
            i += 2;
            while i + 1 < b.len() && &b[i..i + 2] != b"*/" {
                b[i] = b' ';
                i += 1;
            }
            if i + 1 >= b.len() {
                return Err("Unclosed JSON comment".into());
            }
            b[i] = b' ';
            b[i + 1] = b' ';
            i += 2;
        } else {
            i += 1;
        }
    }
    i = 0;
    while i < b.len() {
        if b[i] == b'"' {
            i = string_end(&b, i)?;
            continue;
        }
        if b[i] == b',' && b[i + 1..].iter().find(|c| !c.is_ascii_whitespace()).is_some_and(|c| *c == b'}' || *c == b']') {
            b[i] = b' ';
        }
        i += 1;
    }
    Ok(b)
}
pub(super) fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_slice(&cleaned(text)?).map_err(|e| e.to_string())
}
pub(super) fn replace(text: &str, key: &str, value: &Value) -> Result<String, String> {
    let text = if text.trim().is_empty() { "{}" } else { text };
    let parsed = parse(text)?;
    if !parsed.is_object() {
        return Err("Expected a JSON object".into());
    }
    let b = cleaned(text)?;
    let mut depth = 0;
    let mut i = 0;
    let mut found = None;
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            b'"' => {
                let end = string_end(&b, i)?;
                if depth == 1 && serde_json::from_slice::<String>(&b[i..end]).ok().as_deref() == Some(key) {
                    let mut start = end;
                    while b.get(start).is_some_and(u8::is_ascii_whitespace) {
                        start += 1;
                    }
                    if b.get(start) != Some(&b':') {
                        i = end;
                        continue;
                    }
                    start += 1;
                    while b.get(start).is_some_and(u8::is_ascii_whitespace) {
                        start += 1;
                    }
                    let mut stream = serde_json::Deserializer::from_slice(&b[start..]).into_iter::<Value>();
                    stream.next().ok_or("Missing value")?.map_err(|e| e.to_string())?;
                    if found.is_some() {
                        return Err("Duplicate config property; resolve it before copying".into());
                    }
                    found = Some((start, start + stream.byte_offset()));
                }
                i = end;
                continue;
            }
            _ => (),
        }
        i += 1;
    }
    let encoded = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let result = if let Some((start, end)) = found {
        format!("{}{}{}", &text[..start], encoded, &text[end..])
    } else {
        let start = b.iter().position(|c| *c == b'{').unwrap() + 1;
        let comma = if parsed.as_object().unwrap().is_empty() { "" } else { "," };
        format!("{}\n{}: {}{}{}", &text[..start], serde_json::to_string(key).unwrap(), encoded, comma, &text[start..])
    };
    parse(&result)?;
    Ok(result)
}
