use std::io::{BufRead, Write};

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    if std::env::var_os("KYBERN_TEST_OMP").is_some() {
        omp();
        return;
    }
    if std::env::var_os("KYBERN_TEST_SLEEP").is_some() {
        std::thread::sleep(std::time::Duration::from_secs(30));
        return;
    }
    if std::env::var_os("KYBERN_TEST_ECHO").is_none() {
        let args = std::env::args().skip(1).map(|a| json_string(&a)).collect::<Vec<_>>();
        std::fs::write("argv.tmp", format!("[{}]", args.join(","))).unwrap();
        std::fs::rename("argv.tmp", "argv.json").unwrap();
        let env = ["CLAUDE_CODE_ARTIFACT", "CLAUDE_CODE_ARTIFACT_AUTO_OPEN"]
            .map(|key| format!("{}:{}", json_string(key), json_string(&std::env::var(key).unwrap_or_default())));
        std::fs::write("env.tmp", format!("{{{}}}", env.join(","))).unwrap();
        std::fs::rename("env.tmp", "env.json").unwrap();
        for line in std::io::stdin().lock().lines() {
            if line.is_err() {
                break;
            }
        }
    } else {
        let mut stdout = std::io::stdout().lock();
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if writeln!(stdout, "{line}").and_then(|_| stdout.flush()).is_err() {
                break;
            }
        }
    }
}

fn omp() {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{}", r#"{"type":"agent_end","isTerminal":true}"#).unwrap();
    stdout.flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let id = line.split("\"id\":\"").nth(1).unwrap().split('"').next().unwrap();
        let (command, data) = if line.contains("\"type\":\"get_branch_messages\"") {
            ("get_branch_messages", r#"{"messages":[{"entryId":"entry-1"}]}"#)
        } else if line.contains("\"type\":\"get_state\"") {
            ("get_state", r#"{"hasPendingAsyncWork":false}"#)
        } else {
            assert!(line.contains("\"type\":\"get_messages\""));
            (
                "get_messages",
                r#"{"messages":[{"role":"custom","customType":"async-result","content":"<system-notice>\nBackground job bg_7 has completed. Resume your work using the result below.\nnope\nCommand exited with code 1\n</system-notice>","details":{"jobs":[{"jobId":"bg_7","type":"bash","durationMs":900}]}}]}"#,
            )
        };
        writeln!(
            stdout,
            "{{\"id\":{},\"type\":\"response\",\"command\":{},\"success\":true,\"data\":{}}}",
            json_string(id),
            json_string(command),
            data
        )
        .unwrap();
        stdout.flush().unwrap();
    }
}
