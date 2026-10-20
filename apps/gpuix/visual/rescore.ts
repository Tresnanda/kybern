import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
export function rescore(out: string, themes: string[], names: string[], bases: Record<string,string>) {
 const scratch=mkdtempSync(path.join(tmpdir(),'kybern-delta-'))
 const binary=path.join(scratch,'state-delta')
 try {
 const compile=Bun.spawnSync(['swiftc','-O',path.join(import.meta.dir,'state-delta.swift'),'-o',binary],{stdout:'pipe',stderr:'pipe'})
 if (compile.exitCode) throw new Error(compile.stderr.toString())
 const results: Record<string,unknown>[] = []
 console.log('| Screen | Theme | Delta match | Worst region | Verdict |\n|---|---|---:|---:|---|')
 for (const theme of themes) for (const name of names) {
  const base=bases[name]; if (!base) continue
  const inputs=[`${base}-${theme}-tauri`,`${name}-${theme}-tauri`,`${base}-${theme}-gpuix`,`${name}-${theme}-gpuix`].map(s=>path.join(out,`${s}.png`))
  if (!inputs.every(existsSync)) {
   results.push({screen:name,theme,base,verdict:'MISSING',missing:inputs.filter(p=>!existsSync(p))})
   console.log(`| ${name} | ${theme} | — | — | MISSING |`); continue
  }
  const heatmap=path.join(out,`${name}-${theme}-delta.png`)
  const run=Bun.spawnSync([binary,...inputs,heatmap,'--ui'],{stdout:'pipe',stderr:'pipe'})
  if (run.exitCode) {
   results.push({screen:name,theme,base,verdict:'INVALID_CAPTURE',error:run.stderr.toString().slice(0,1500)})
   console.log(`| ${name} | ${theme} | — | — | INVALID_CAPTURE |`); continue
  }
  const result=JSON.parse(run.stdout.toString())
  results.push({screen:name,theme,base,heatmap,...result})
  writeFileSync(path.join(out,`${name}-${theme}-delta.json`),JSON.stringify(result,null,2))
  console.log(`| ${name} | ${theme} | ${result.score.toFixed(1)}% | ${result.worstRegionScore.toFixed(1)}% | ${result.verdict} |`)
 }
 writeFileSync(path.join(out,'state-deltas.json'),JSON.stringify(results,null,2))
 return results
 } finally { rmSync(scratch,{recursive:true,force:true}) }
}
