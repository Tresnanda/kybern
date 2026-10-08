/* eslint-disable react-refresh/only-export-components */
// Native WebKit check of Settings › Accounts over a fixture transport: the CLI
// account first, row details, the ⋯ menu (rename, color, make default, use for
// projects, remove), rollback of a refused settings write and narrow layout.
// No daemon, harness, terminal or credential is involved.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Toaster } from "../src/components/ui/sonner"
import { ThemeProviderContext } from "../src/components/theme-context"
import { AccountsSettings } from "../src/views/settings/AccountsSettings"
import { useStore } from "../src/state/store"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { accountsFixture } from "./accounts-rpc"
import type { Settings } from "../src/protocol"
import "../src/index.css"

declare const __COLLAB_THEME__: "dark" | "light"
const theme = __COLLAB_THEME__
const longName = "Research and international collaboration — Asia Pacific enterprise engineering"
const checks: Record<string, boolean> = {}
const root = createRoot(document.getElementById("root")!)
const sleep = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const report = (value: unknown) => (window as unknown as {webkit:{messageHandlers:{bench:{postMessage:(text:string)=>void}}}}).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
function check(name: string, value: unknown) { checks[name] = !!value; if (!value) throw new Error(name) }
async function waitFor(predicate: () => unknown, label: string) {
  const deadline = performance.now() + 5000
  while (!predicate() && performance.now() < deadline) await sleep(20)
  if (!predicate()) throw new Error(label)
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function menuItem(trigger: string, item: string) {
  button(trigger).click()
  await waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some(node => node.textContent?.trim() === item), `Menu shows ${item}`)
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === item)!.click()
  await sleep(150)
}
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-account]")].map(node => node.dataset.account)
const claude = () => useStore.getState().settings!.providers["claude-code"]!
async function screenshot(name: string) {
  await new Promise<void>(resolve => {
    (window as unknown as {__screenshotContinue:()=>void}).__screenshotContinue = resolve
    report({screenshot:`accounts-${theme}-${innerWidth}-${name}`})
  })
}
function Shell() {
  return <ThemeProviderContext value={{theme,translucent:false,setTheme:()=>{},setTranslucent:()=>{}}}>
    <main className="app-settings-surface mx-auto max-w-3xl space-y-6 p-4 text-foreground">
      <AccountsSettings />
      <Toaster theme={theme} />
    </main>
  </ThemeProviderContext>
}
async function run() {
  document.documentElement.classList.toggle("dark",theme==="dark")
  document.documentElement.dataset.runtime="electron"
  document.documentElement.dataset.platform="macos"
  document.documentElement.dataset.windowMaterial="opaque"
  const tokens=buildThemeCssVariables({codeThemeId:DEFAULT_THEME_STATE.codeThemeIds[theme],theme:DEFAULT_THEME_STATE.chromeThemes[theme]},theme,{electron:true,isMac:true,systemUiFont:true})
  for (const [key,value] of Object.entries(tokens.variables)) document.documentElement.style.setProperty(key,value)
  const settings: Settings = {default_provider:"claude-code",default_permission_mode:"supervised",worktrees_default:true,generate_titles:true,notifications:true,auto_update_harnesses:false,auto_update_daemon:false,tell_agents_about_kybern:true,background:{session_idle_minutes:15,max_idle_sessions:3,terminal_idle_minutes:30,daemon_idle_exit_minutes:0,save_power_on_battery:true},access:{tailscale:false},computer_use:{enabled:false,foreground:"ask"},orchestration:{max_active_children:4,max_depth:2},providers:{"claude-code":{binary:"/fixture/claude",model:"sonnet",env:{KEEP_ME:"yes"},default_account:"work",project_accounts:{},accounts:{work:{name:"Work",directory:"/fixture/data/accounts/claude-code/work",color:"blue",email:"dev@arunika.co",plan:"Max"},research:{name:longName,directory:"/fixture/existing/research",color:"green"}}}}}
  useStore.getState().set({settings,projects:{project:{id:"project",name:"International collaboration application",path:"/fixture/project",is_git:true,created_at:"",updated_at:""}},providers:[{kind:"claude-code",display_name:"Claude Code",available:true,instances:["default","work","research"],models:[],supports_fork:true,supports_model_switch:true,supported_permission_modes:["supervised"]}]})
  flushSync(()=>root.render(<Shell />))
  await waitFor(()=>rows().length===3,"Accounts load")
  check("CLI account first, named in order",rows().join()==="claude-code:default,claude-code:work,claude-code:research")
  check("CLI row says it matches the terminal",document.querySelector('[data-account="claude-code:default"]')?.textContent?.includes("Same as your terminal"))
  check("default badge on the default",document.querySelector('[data-account="claude-code:work"]')?.textContent?.includes("Default"))
  check("needs sign-in offers sign-in",document.querySelector('[data-account="claude-code:research"]')?.textContent?.includes("Needs sign-in") && !!button("Sign in"))
  await screenshot("list")

  await menuItem("CLI account options","Make default")
  await waitFor(()=>claude().default_account===null,"Make default clears default_account for the CLI account")
  check("CLI default never stores \"default\"",claude().default_account===null)
  check("other provider settings preserved",claude().binary==="/fixture/claude" && claude().env.KEEP_ME==="yes")

  accountsFixture.failSave=true
  await menuItem("Work options","Make default")
  await sleep(150)
  check("refused settings write rolls back",claude().default_account===null)
  accountsFixture.failSave=false

  await menuItem("Work options","Rename…")
  const field=document.querySelector<HTMLInputElement>('input[aria-label="Work name"]')!
  check("rename edits in place",!!field)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,"Client")
  field.dispatchEvent(new Event("input",{bubbles:true}))
  field.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))
  await waitFor(()=>claude().accounts?.work?.name==="Client","Rename saves")
  check("rename goes through accounts.update",accountsFixture.calls.some(call=>call.method==="providers.accounts.update"))
  await waitFor(()=>document.querySelector('[aria-label="Client options"]'),"Renamed row refreshes")

  await menuItem("Client options","Use for projects…")
  await waitFor(()=>document.querySelector('[role="dialog"] [role="checkbox"]'),"Projects dialog opens")
  const projectBox=()=>document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')
  projectBox()!.click()
  await waitFor(()=>projectBox()?.getAttribute("aria-checked")==="true","Project checkbox checks")
  const save=[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node=>node.textContent?.trim()==="Save")
  check("projects dialog has Save",save && !save.disabled)
  save!.click()
  await waitFor(()=>claude().project_accounts?.["/fixture/project"]==="work",`Project override saved ${JSON.stringify({checked:projectBox()?.getAttribute("aria-checked"),calls:accountsFixture.calls.slice(-3).map(call=>call.method),projects:claude().project_accounts})}`)
  check("project override saved",true)

  await menuItem("Client options","Remove…")
  await waitFor(()=>document.querySelector('[role="alertdialog"]'),"Remove dialog opens")
  check("managed folder is deleted on remove",document.querySelector('[role="alertdialog"]')?.textContent?.includes("deletes its folder"))
  button("Remove account").click()
  await waitFor(()=>rows().length===2,"Removed account leaves the list")
  check("remove clears its project override",!claude().project_accounts?.["/fixture/project"])

  check("no horizontal overflow",document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll<HTMLElement>("[data-account] button")].every(node=>node.getBoundingClientRect().right<=innerWidth+1))
  window.scrollTo(0,0)
  await sleep(100)
  await screenshot("after")
  // The CI gate requires unassisted focus and a visible window: menus are
  // driven by real clicks here, so only a hidden window limits the result.
  report({pass:true,fixture:"accounts",checks,theme,width:innerWidth,keyboardFocusAssisted:false,documentHidden:document.hidden,limits:document.hidden ? ["Hidden window: menu motion and open-menu appearance require a visible rerun."] : []})
}
void run().catch(problem=>report({pass:false,checks,error:String(problem)}))
