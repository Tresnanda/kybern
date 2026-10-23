import assert from "node:assert/strict"
import test from "node:test"

import { commandPrograms, LOGIN_RECIPES, signedOutRecipe, signInChips, signInRequestMessage } from "../src/loginRecipes.ts"

test("lists every CLI the contract names", () => {
  assert.deepEqual(LOGIN_RECIPES.map((r) => r.cli), ["gh", "vercel", "supabase", "npm", "gcloud", "fly", "wrangler", "eas"])
})

test("finds the programs of a chained command, through runners and env assignments", () => {
  assert.deepEqual([...commandPrograms("cd web && FOO=1 npx vercel@latest deploy --prebuilt | tee log")].sort(), ["cd", "npx", "tee", "vercel"])
  assert.ok(commandPrograms("pnpm dlx wrangler deploy").has("wrangler"))
  assert.ok(commandPrograms("/opt/homebrew/bin/gh pr create --fill").has("gh"))
  assert.ok(commandPrograms("bunx --bun eas build").has("eas"))
})

test("matches each recipe's signed-out output only when its CLI ran", () => {
  const cases = [
    ["gh pr create --fill", "To get started with GitHub CLI, please run:  gh auth login", "gh"],
    ["gh repo view", "You are not logged in to any GitHub hosts. Run gh auth login to authenticate.", "gh"],
    ["vercel deploy --prebuilt", "Error: No existing credentials found. Please run `vercel login` or pass \"--token\"", "vercel"],
    ["vercel env pull", "Error: The specified token is not valid. Use `vercel login` to generate a new token.", "vercel"],
    ["supabase db push", "Access token not provided. Supply an access token by running supabase login", "supabase"],
    ["npm publish", "npm ERR! code E401\nnpm ERR! Unable to authenticate", "npm"],
    ["pnpm publish", "ERR_PNPM_ENEEDAUTH This command requires you to be logged in", "npm"],
    ["gcloud run deploy", "ERROR: (gcloud.run.deploy) You do not currently have an active account selected.", "gcloud"],
    ["flyctl deploy", "Error: No access token available. Please login with 'flyctl auth login'", "fly"],
    ["fly status", "Error: No access token available.", "fly"],
    ["npx wrangler deploy", "✘ [ERROR] You are not authenticated. Please run `wrangler login`.", "wrangler"],
    ["eas build -p ios", "An Expo user account is required to proceed.", "eas"],
  ]
  for (const [command, output, cli] of cases) assert.equal(signedOutRecipe(command, output)?.cli, cli, command)
})

test("ignores matching text from a command that did not run the CLI", () => {
  assert.equal(signedOutRecipe("cat notes.md", "remember: run gh auth login"), null)
  assert.equal(signedOutRecipe("curl -I https://example.com", "HTTP/2 401 E401"), null)
  assert.equal(signedOutRecipe("gh pr create", "Created pull request #12"), null)
  assert.equal(signedOutRecipe("", "gh auth login"), null)
})

test("keeps one chip per CLI: the turn's latest failure", () => {
  const rows = [
    { id: "a", command: "gh pr create", output: "please run: gh auth login", complete: true },
    { id: "b", command: "vercel deploy", output: "No existing credentials found", complete: true },
    { id: "c", command: "gh pr view", output: "not logged in to any GitHub hosts", complete: true },
    { id: "d", command: "gh auth status", output: "gh auth login", complete: false },
  ]
  const chips = signInChips(rows)
  assert.deepEqual([...chips.keys()].sort(), ["b", "c"])
  assert.equal(chips.get("c")?.service, "GitHub")
})

test("asks the agent to raise the sign-in card", () => {
  assert.equal(signInRequestMessage({ cli: "gh", service: "GitHub" }), "Sign in to GitHub with kybern_request_login (cli gh), then retry what failed.")
})
