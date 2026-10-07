/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { useState } from "react"
import { AccountSettings, useSettings } from "../src/views/SettingsScreen"
import { AccountPicker } from "../src/components/kybern/AccountPicker"
import { toast } from "sonner"
import { Toaster } from "../src/components/ui/sonner"
import { ThemeProviderContext } from "../src/components/theme-context"
import { useStore } from "../src/state/store"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { accountsFixture, rpc } from "./accounts-rpc"
import type { Methods, Settings } from "../src/protocol"
import "../src/index.css"

declare const __COLLAB_THEME__: "dark" | "light"
const theme = __COLLAB_THEME__
const longName = "Research and international collaboration — Asia Pacific enterprise engineering"
const directory = "/fixture/existing accounts/international collaboration/native authentication and session storage"
const checks: Record<string, boolean> = {}
const root=createRoot(document.getElementById("root")!)
const mount=()=>flushSync(()=>root.render(<Shell />))
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
function trigger() { return document.querySelector<HTMLButtonElement>('[aria-label^="Account:"]')! }
function input(label: string) {
  const found = [...document.querySelectorAll<HTMLLabelElement>("label")].find(node => node.textContent?.trim() === label)
  if (!found) throw new Error(`Missing visible label: ${label}`)
  return document.getElementById(found.htmlFor) as HTMLInputElement
}
async function write(label: string, value: string) {
  const field = input(label)
  field.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value)
  field.dispatchEvent(new Event("input",{bubbles:true}))
  await sleep()
}
async function choose(label: string, option: string) {
  const control=button(label)
  if (control.getAttribute("aria-expanded")!=="true") control.click()
  await sleep()
  await waitFor(()=>control.getAttribute("aria-expanded")==="true" && !!control.getAttribute("aria-controls"),"Account menu opens")
  const menu=document.getElementById(control.getAttribute("aria-controls")!)!
  const found=[...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node=>node.textContent?.trim()===option)
  if (!found) throw new Error(`Missing account option: ${option}`)
  found.click()
  await sleep(250)
}
async function openKeyboardPicker() {
  trigger().focus()
  trigger().dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}))
  await waitFor(()=>document.querySelector('[role="menu"][data-open] [role="menuitemradio"]'),"Keyboard opens account picker")
  await sleep(150)
  // Locked macOS pauses WebKit's rAF that places initial menu focus. Start from
  // its real roving tab stop; all subsequent arrow/Enter handling is production.
  if (document.hidden) document.querySelector<HTMLElement>('[role="menu"][data-open] [role="menuitemradio"][tabindex="0"]')?.focus()
}
async function chooseKeyboard(option: string) {
  await openKeyboardPicker()
  const items = [...document.querySelectorAll<HTMLElement>('[role="menu"][data-open] [role="menuitemradio"]')]
  const target = items.find(node=>node.textContent?.trim()===option)
  if (!target) throw new Error(`Missing keyboard account: ${option}`)
  for (let count=0;document.activeElement!==target && count<=items.length;count++) {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}))
    await sleep(30)
  }
  check("keyboard reaches named account",document.activeElement===target)
  target.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))
  await sleep(250)
}
async function screenshot(name: string) {
  await new Promise<void>(resolve=>{
    (window as unknown as {__screenshotContinue:()=>void}).__screenshotContinue=resolve
    report({screenshot:`accounts-${theme}-${innerWidth}-${name}`})
  })
}
function Shell() {
  const {settings: current,update} = useSettings()
  const settings = current!
  const [override,setOverride] = useState<string|null>(null)
  const provider = settings.providers["claude-code"]!
  const instance = override ?? provider.project_accounts?.["/fixture/project"] ?? provider.default_account ?? "default"
  const change = async (instance: string|null) => {
    const result = await rpc().call("threads.target.set",{thread_id:"fixture-thread",target:{provider:{kind:"claude-code",instance:instance ?? "default"}},inherit_account:instance===null})
    setOverride(result.account_override ? result.target.provider.instance : null)
  }
  return <ThemeProviderContext value={{theme,translucent:false,setTheme:()=>{},setTranslucent:()=>{}}}>
    <main className="app-settings-surface mx-auto max-w-3xl space-y-6 p-4 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
        <span className="text-sm font-medium">Account for the next message</span>
        <AccountPicker provider={{kind:"claude-code",instance}} settings={provider} inherited={override===null} onChange={instance=>void change(instance)} />
      </header>
      <AccountSettings settings={settings} update={update} />
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
  const settings: Settings = {default_provider:"claude-code",default_permission_mode:"supervised",worktrees_default:true,generate_titles:true,notifications:true,auto_update_harnesses:false,auto_update_daemon:false,tell_agents_about_kybern:true,background:{session_idle_minutes:15,max_idle_sessions:3,terminal_idle_minutes:30,daemon_idle_exit_minutes:0,save_power_on_battery:true},access:{tailscale:false},computer_use:{enabled:false,foreground:"ask"},orchestration:{max_active_children:4,max_depth:2},providers:{"claude-code":{binary:"/fixture/claude",model:"sonnet",env:{KEEP_ME:"yes"},default_account:"default",project_accounts:{"/fixture/project":"work"},accounts:{work:{name:"Work",directory:"/fixture/accounts/work"},research:{name:longName,directory:"/fixture/accounts/research and international collaboration/native authentication and session storage"}}}}}
  useStore.getState().set({settings,projects:{project:{id:"project",name:"International collaboration application",path:"/fixture/project",is_git:true,created_at:"",updated_at:""}},providers:[{kind:"claude-code",display_name:"Claude Code",available:true,instances:["default","work","research"],models:[],supports_fork:true,supports_model_switch:true,supported_permission_modes:["supervised"]}]})
  mount()
  await sleep(200)
  check("persistent visible labels",!!input("Account name") && !!input("Existing directory (optional)"))
  check("placeholders are examples",input("Account name").placeholder==="e.g. Work" && input("Existing directory (optional)").placeholder.startsWith("e.g. /"))
  check("empty name cannot create",button("Add account").disabled)
  check("project account inherited",trigger().textContent?.includes("Work") && trigger().getAttribute("aria-label")?.includes("follows defaults"))
  await chooseKeyboard(longName)
  const override=accountsFixture.calls.find(call=>call.method==="threads.target.set")!.params as Methods["threads.target.set"][0]
  check("thread override acknowledged",trigger().title===`${longName} · This thread` && override.target.provider.instance==="research" && override.inherit_account===false)
  await openKeyboardPicker()
  check("named accounts appear in keyboard menu",document.querySelector('[role="menu"][data-open]')?.textContent?.includes(longName))
  check("menu stays inside viewport",[...document.querySelectorAll<HTMLElement>('[role="menu"][data-open]')].every(node=>node.getBoundingClientRect().left>=0 && node.getBoundingClientRect().right<=innerWidth+1))
  await screenshot("picker")
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))
  if (document.hidden) {
    // The real logical close is testable while locked; animation completion and
    // focus restoration are explicitly reported as needing a visible rerun.
    await waitFor(()=>trigger().getAttribute("aria-expanded")==="false","Escape logically closes account menu")
    check("Escape logically closes account menu",true)
  } else {
    await waitFor(()=>!document.querySelector('[role="menu"][data-open]'),"Escape closes account menu")
    await waitFor(()=>document.activeElement===trigger(),"Escape returns focus")
    check("Escape returns focus",true)
  }
  await chooseKeyboard("Follow project and global defaults")
  const inherit=accountsFixture.calls.filter(call=>call.method==="threads.target.set").at(-1)!.params as Methods["threads.target.set"][0]
  check("inherit clears thread override",inherit.inherit_account===true && inherit.target.provider.instance==="default" && trigger().getAttribute("aria-label")?.includes("follows defaults") && trigger().textContent?.includes("Work"))
  await choose("Global account",longName)
  check("global selection saves",useStore.getState().settings!.providers["claude-code"]!.default_account==="research")
  await choose("Choose account project","International collaboration application")
  await choose("Project account",longName)
  check("project selection saves",useStore.getState().settings!.providers["claude-code"]!.project_accounts?.["/fixture/project"]==="research")
  accountsFixture.failSave=true
  await choose("Global account","Default account")
  check("failed global save preserves value",useStore.getState().settings!.providers["claude-code"]!.default_account==="research" && button("Global account").textContent?.includes(longName))
  await choose("Project account","Default account")
  check("failed project save preserves value",useStore.getState().settings!.providers["claude-code"]!.project_accounts?.["/fixture/project"]==="research" && button("Project account").textContent?.includes(longName))
  check("save error gives next action",document.querySelector("[data-sonner-toaster]")?.textContent?.includes("Check your connection and try again"))
  toast.dismiss()
  accountsFixture.failSave=false
  await choose("Project account","Follow global account")
  check("project inheritance removes override",!Object.hasOwn(useStore.getState().settings!.providers["claude-code"]!.project_accounts!,"/fixture/project"))
  accountsFixture.failSignIn=true
  button("Sign in").click();await sleep(100)
  check("sign-in error gives next action",document.body.textContent?.includes("Check the agent installation, then try signing in again"))
  accountsFixture.failSignIn=false
  button("Sign in").click();await waitFor(()=>document.querySelector('[data-account-sign-in]'),"Mock sign-in terminal opens")
  check("no real terminal mounted",!document.querySelector(".xterm"))
  button("Cancel sign-in").click();await waitFor(()=>!document.querySelector('[data-account-sign-in]'),"Cancel closes mock sign-in")
  check("cancel addresses exact terminal",(accountsFixture.calls.filter(call=>call.method==="terminals.close").at(-1)?.params as {terminal_id:string})?.terminal_id==="fixture-sign-in")
  await write("Account name","Imported research")
  await write("Existing directory (optional)",`  ${directory}  `)
  accountsFixture.failCreate=true
  button("Add account").click();await sleep(100)
  check("create failure preserves fields",input("Account name").value==="Imported research" && input("Existing directory (optional)").value===`  ${directory}  `)
  check("create error gives next action",document.body.textContent?.includes("Check the account name and directory, then try again"))
  await screenshot("create-error")
  accountsFixture.failCreate=false
  button("Add account").click();await waitFor(()=>input("Account name").value==="","Created account refresh clears fields")
  const create=accountsFixture.calls.filter(call=>call.method==="providers.accounts.create").at(-1)?.params as {kind:string;name:string;directory:string}
  check("existing directory sent exactly",create.kind==="claude-code" && create.name==="Imported research" && create.directory===directory)
  check("existing account persisted",useStore.getState().settings!.providers["claude-code"]!.accounts?.["created-1"]?.directory===directory)
  const provider=useStore.getState().settings!.providers["claude-code"]!
  check("other provider settings preserved",provider.binary==="/fixture/claude" && provider.model==="sonnet" && provider.env.KEEP_ME==="yes")
  check("no horizontal overflow",document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll<HTMLElement>("input,button")].every(node=>node.getBoundingClientRect().left>=-1 && node.getBoundingClientRect().right<=innerWidth+1))
  check("theme text is readable",getComputedStyle(input("Account name")).color!==(theme==="dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)"))
  window.scrollTo(0,0)
  await sleep(100)
  report({pass:true,checks,theme,width:innerWidth,keyboardFocusAssisted:document.hidden,limits:document.hidden ? ["Locked macOS: initial roving menu focus was set by the fixture; native exit animation, Escape focus restoration, and open-menu appearance require a visible rerun."] : []})
}
void run().catch(problem=>report({pass:false,checks,error:String(problem)}))
