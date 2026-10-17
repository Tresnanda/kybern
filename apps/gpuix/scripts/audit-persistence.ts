export {}
for(const phase of ['write','read']){
 const p=Bun.spawn(['bun','src/shell/verify.persistence.ts',phase],{env:process.env,stdout:'inherit',stderr:'inherit'})
 if(await p.exited)throw Error(`Persistence ${phase} failed`)
}
