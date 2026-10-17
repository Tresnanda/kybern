/** Resource/cadence controls wait outside the UI lease when possible. */
export function nativeBuildProcesses():string[]{
 return Bun.spawnSync(['ps','-axo','comm=']).stdout.toString().split('\n').map(line=>line.trim()).filter(line=>/\/(cargo|rustc)$/.test(line)||/^(cargo|rustc)$/.test(line))
}
export async function waitForNativeBuilds(){
 const deadline=Date.now()+30*60_000
 while(nativeBuildProcesses().length){if(Date.now()>deadline)throw Error('Native builds did not finish before the measurement');await Bun.sleep(1000)}
}
