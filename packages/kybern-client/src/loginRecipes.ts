// Signed-out messages of the CLIs Kybern can sign in (`kybern_request_login`), for the "Sign in to GitHub" chip on a finished
// tool row. Client-side only: the chip asks the agent to raise the sign-in card, so nothing here runs a login.

export interface LoginRecipe {
  /** The CLI the sign-in card signs in, as `kybern_request_login` takes it. */
  cli: string
  /** The service as the chip names it. */
  service: string
  /** Other names the same CLI runs under (`flyctl` for `fly`). */
  aliases: readonly string[]
  /** Output that means the CLI is signed out. Matched case-sensitively as plain text. */
  patterns: readonly string[]
}

export const LOGIN_RECIPES: readonly LoginRecipe[] = [
  { cli: "gh", service: "GitHub", aliases: [], patterns: ["gh auth login", "not logged in to any GitHub hosts"] },
  { cli: "vercel", service: "Vercel", aliases: [], patterns: ["vercel login", "No existing credentials found", "Error: The specified token is not valid"] },
  { cli: "supabase", service: "Supabase", aliases: [], patterns: ["Access token not provided"] },
  { cli: "npm", service: "npm", aliases: ["pnpm", "yarn"], patterns: ["E401", "npm login", "ENEEDAUTH"] },
  { cli: "gcloud", service: "Google Cloud", aliases: [], patterns: ["gcloud auth login", "You do not currently have an active account"] },
  { cli: "fly", service: "Fly.io", aliases: ["flyctl"], patterns: ["flyctl auth login", "No access token available"] },
  { cli: "wrangler", service: "Cloudflare", aliases: [], patterns: ["wrangler login", "You are not authenticated", "Authentication error"] },
  { cli: "eas", service: "Expo", aliases: [], patterns: ["eas login", "An Expo user account is required"] },
]

/** The program names a shell command runs: the first word of every segment, plus the word after `npx`, `pnpm dlx`, `bunx` and `yarn dlx`. */
export function commandPrograms(command: string): Set<string> {
  const programs = new Set<string>()
  for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
    const words = segment.trim().split(/\s+/).filter((word) => word && !/^[A-Z_][A-Z0-9_]*=/.test(word))
    const base = (word: string | undefined) => word?.replace(/^.*\//, "")
    const first = base(words[0])
    if (!first) continue
    programs.add(first)
    const runner = first === "npx" || first === "bunx" ? 1 : (first === "pnpm" || first === "yarn") && words[1] === "dlx" ? 2 : 0
    const run = runner ? words.slice(runner).find((word) => !word.startsWith("-")) : undefined
    if (run) programs.add(base(run)!.replace(/@[^/]*$/, ""))
  }
  return programs
}

/** The recipe whose CLI the command ran and whose signed-out message the output contains, or null. */
export function signedOutRecipe(command: string, output: string): LoginRecipe | null {
  if (!command || !output) return null
  const programs = commandPrograms(command)
  for (const recipe of LOGIN_RECIPES) {
    if (!programs.has(recipe.cli) && !recipe.aliases.some((alias) => programs.has(alias))) continue
    if (recipe.patterns.some((pattern) => output.includes(pattern))) return recipe
  }
  return null
}

export interface FinishedCommand {
  id: string
  command: string
  output: string
  complete: boolean
}

/** One chip per CLI and turn: the latest finished row whose output says that CLI is signed out (rows in turn order). */
export function signInChips(rows: readonly FinishedCommand[]): Map<string, LoginRecipe> {
  const latest = new Map<string, { id: string; recipe: LoginRecipe }>()
  for (const row of rows) {
    if (!row.complete) continue
    const recipe = signedOutRecipe(row.command, row.output)
    if (recipe) latest.set(recipe.cli, { id: row.id, recipe })
  }
  return new Map([...latest.values()].map(({ id, recipe }) => [id, recipe]))
}

/** The message the chip queues: the daemon has no user-started sign-in card, so the agent raises it. */
export function signInRequestMessage(recipe: Pick<LoginRecipe, "cli" | "service">): string {
  return `Sign in to ${recipe.service} with kybern_request_login (cli ${recipe.cli}), then retry what failed.`
}
