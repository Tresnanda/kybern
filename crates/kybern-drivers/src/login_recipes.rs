//! Sign-in recipes for developer CLIs (`kybern_request_login`), the table the
//! daemon's CLI login runner (`cli_login.rs`) follows. Unlike harness accounts
//! (`account_auth`), these logins are global: they change the user's own `gh`,
//! `vercel`, ... login, and the card says so. Recipes drift with CLI versions,
//! so every one carries a non-interactive `verify` command and the runner
//! decides success by running it, never by reading the login's output.

/// How a recipe's verify command answers "signed in?" and "as whom?".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verify {
    /// Exit code 0. The account is the first word after `account ` in the output, if any.
    ExitZero,
    /// Exit code 0 and the last non-empty output line is the account (`vercel whoami`).
    LastLine,
    /// Exit code 0 and non-empty output; the account is the first line (`gcloud auth list`).
    NonEmpty,
    /// Exit code 0 and the output contains this text (`wrangler whoami`).
    Contains(&'static str),
}

#[derive(Debug, Clone, Copy)]
pub struct LoginRecipe {
    /// What the agent passes, e.g. `gh`.
    pub cli: &'static str,
    /// For the title, e.g. `GitHub`.
    pub service: &'static str,
    /// The executable names to look for, in order (`fly` is also `flyctl`).
    pub binaries: &'static [&'static str],
    /// Arguments of the sign-in the daemon drives in a hidden terminal.
    pub login_args: &'static [&'static str],
    pub verify_args: &'static [&'static str],
    pub verify: Verify,
    /// The Account line of the card.
    pub account: &'static str,
    /// The Access line, when the CLI has scopes.
    pub access: Option<&'static str>,
    /// What the sign-in changes.
    pub signs_in: &'static str,
    /// Text in the login's output that asks for a code the page shows.
    pub paste_markers: &'static [&'static str],
    /// Arguments run once after a successful sign-in (`gh auth setup-git`).
    pub post_login_args: Option<&'static [&'static str]>,
    /// Only a visible terminal can sign in (it asks for a password in the terminal).
    pub terminal_only: bool,
    /// Output of a signed-out CLI, for the "Sign in" chip on tool rows (the
    /// client keeps its own copy in `loginRecipes.ts`).
    pub signed_out: &'static [&'static str],
}

pub const RECIPES: &[LoginRecipe] = &[
    LoginRecipe {
        cli: "gh",
        service: "GitHub",
        binaries: &["gh"],
        login_args: &["auth", "login", "-h", "github.com", "--web", "-p", "https", "-s", "repo,read:org,workflow"],
        verify_args: &["auth", "status", "-h", "github.com"],
        verify: Verify::ExitZero,
        account: "github.com, any account you choose",
        access: Some("repo, read:org, workflow"),
        signs_in: "`gh` for this Mac, so your terminal uses it too",
        paste_markers: &[],
        post_login_args: Some(&["auth", "setup-git"]),
        terminal_only: false,
        signed_out: &["gh auth login", "not logged in to any GitHub hosts"],
    },
    LoginRecipe {
        cli: "vercel",
        service: "Vercel",
        binaries: &["vercel"],
        login_args: &["login"],
        verify_args: &["whoami"],
        verify: Verify::LastLine,
        account: "vercel.com, any account you choose",
        access: None,
        signs_in: "`vercel` for this Mac, so your terminal uses it too",
        paste_markers: &[],
        post_login_args: None,
        terminal_only: false,
        signed_out: &["vercel login", "No existing credentials found", "token is not valid"],
    },
    LoginRecipe {
        cli: "supabase",
        service: "Supabase",
        binaries: &["supabase"],
        login_args: &["login", "--no-browser", "--output-format", "text"],
        verify_args: &["projects", "list", "-o", "json"],
        verify: Verify::ExitZero,
        account: "supabase.com, any account you choose",
        access: None,
        signs_in: "`supabase` for this Mac, so your terminal uses it too",
        paste_markers: &["verification code"],
        post_login_args: None,
        terminal_only: false,
        signed_out: &["Access token not provided", "supabase login"],
    },
    LoginRecipe {
        cli: "npm",
        service: "npm",
        binaries: &["npm"],
        login_args: &["login", "--auth-type=web"],
        verify_args: &["whoami"],
        verify: Verify::LastLine,
        account: "the registry this folder uses, any account you choose",
        access: None,
        signs_in: "`npm` for this Mac, so your terminal uses it too",
        paste_markers: &[],
        post_login_args: None,
        terminal_only: false,
        signed_out: &["E401", "ENEEDAUTH", "npm login"],
    },
    LoginRecipe {
        cli: "gcloud",
        service: "Google Cloud",
        binaries: &["gcloud"],
        login_args: &["auth", "login"],
        verify_args: &["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
        verify: Verify::NonEmpty,
        account: "accounts.google.com, any account you choose",
        access: None,
        signs_in: "`gcloud` for this Mac, so your terminal uses it too",
        paste_markers: &["authorization code", "verification code"],
        post_login_args: None,
        terminal_only: false,
        signed_out: &["gcloud auth login", "do not currently have an active account"],
    },
    LoginRecipe {
        cli: "fly",
        service: "Fly.io",
        binaries: &["fly", "flyctl"],
        login_args: &["auth", "login"],
        verify_args: &["auth", "whoami"],
        verify: Verify::LastLine,
        account: "fly.io, any account you choose",
        access: None,
        signs_in: "`fly` for this Mac, so your terminal uses it too",
        paste_markers: &[],
        post_login_args: None,
        terminal_only: false,
        signed_out: &["flyctl auth login", "fly auth login", "No access token available"],
    },
    LoginRecipe {
        cli: "wrangler",
        service: "Cloudflare",
        binaries: &["wrangler"],
        login_args: &["login"],
        verify_args: &["whoami"],
        verify: Verify::Contains("logged in"),
        account: "dash.cloudflare.com, any account you choose",
        access: None,
        signs_in: "`wrangler` for this Mac, so your terminal uses it too",
        paste_markers: &[],
        post_login_args: None,
        terminal_only: false,
        signed_out: &["wrangler login", "You are not authenticated", "Authentication error"],
    },
    LoginRecipe {
        cli: "eas",
        service: "Expo",
        binaries: &["eas"],
        login_args: &["login"],
        verify_args: &["whoami"],
        verify: Verify::LastLine,
        account: "expo.dev, any account you choose",
        access: None,
        signs_in: "`eas` for this Mac, so your terminal uses it too",
        paste_markers: &[],
        post_login_args: None,
        terminal_only: true,
        signed_out: &["eas login", "An Expo user account is required"],
    },
];

pub fn recipe(cli: &str) -> Option<&'static LoginRecipe> {
    let cli = cli.trim();
    RECIPES.iter().find(|recipe| recipe.cli.eq_ignore_ascii_case(cli) || (cli == "flyctl" && recipe.cli == "fly"))
}

impl LoginRecipe {
    /// The command line a terminal runs to sign in, for display and the terminal path.
    pub fn command_line(&self) -> String {
        std::iter::once(self.cli).chain(self.login_args.iter().copied()).map(shell_word).collect::<Vec<_>>().join(" ")
    }

    /// Whether a verify run (exit success, standard output) means signed in, and as whom.
    pub fn read_verify(&self, success: bool, output: &str) -> Option<Option<String>> {
        if !success {
            return None;
        }
        let output = crate::account_auth::strip_ansi(output);
        let lines = || output.lines().map(str::trim).filter(|line| !line.is_empty());
        match self.verify {
            Verify::ExitZero => Some(account_word(&output)),
            Verify::LastLine => lines().next_back().map(|line| Some(line.to_string())),
            Verify::NonEmpty => lines().next().map(|line| Some(line.to_string())),
            Verify::Contains(text) => output.contains(text).then(|| email(&output)),
        }
    }
}

/// `gh auth status` prints "Logged in to github.com account NAME (keyring)".
fn account_word(output: &str) -> Option<String> {
    let rest = output.split("account ").nth(1)?;
    let word = rest.split_whitespace().next()?;
    (!word.is_empty()).then(|| word.to_string())
}

fn email(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '-' | '_' | '+'))))
        .find(|word| word.contains('@') && word.contains('.'))
        .map(|word| word.trim_end_matches('.').to_string())
}

fn shell_word(word: &str) -> String {
    if word.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ',' | '/' | '=' | ':')) {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_recipe_is_found_by_its_name() {
        for recipe in RECIPES {
            assert_eq!(super::recipe(recipe.cli).map(|r| r.cli), Some(recipe.cli));
            assert!(!recipe.binaries.is_empty() && !recipe.verify_args.is_empty());
        }
        assert_eq!(super::recipe("flyctl").map(|r| r.cli), Some("fly"));
        assert!(super::recipe("rm").is_none());
    }

    #[test]
    fn verify_reads_each_kind_of_output() {
        let gh = super::recipe("gh").unwrap();
        let status = "github.com\n  ✓ Logged in to github.com account Tresnanda (keyring)\n  - Active account: true\n";
        assert_eq!(gh.read_verify(true, status), Some(Some("Tresnanda".into())));
        assert_eq!(gh.read_verify(false, status), None);
        let vercel = super::recipe("vercel").unwrap();
        assert_eq!(vercel.read_verify(true, "Vercel CLI 54.14.0\ntresnanda\n"), Some(Some("tresnanda".into())));
        assert_eq!(vercel.read_verify(true, "\n"), None);
        let gcloud = super::recipe("gcloud").unwrap();
        assert_eq!(gcloud.read_verify(true, ""), None, "gcloud exits 0 with no output when nobody is signed in");
        assert_eq!(gcloud.read_verify(true, "me@example.com\n"), Some(Some("me@example.com".into())));
        let wrangler = super::recipe("wrangler").unwrap();
        assert_eq!(
            wrangler.read_verify(true, "You are logged in with an OAuth Token, associated with the email me@x.dev."),
            Some(Some("me@x.dev".into()))
        );
        assert_eq!(wrangler.read_verify(true, "You are not authenticated."), None);
    }

    #[test]
    fn command_lines_quote_odd_arguments() {
        assert_eq!(super::recipe("gh").unwrap().command_line(), "gh auth login -h github.com --web -p https -s repo,read:org,workflow");
        assert_eq!(shell_word("a b"), "'a b'");
    }
}
