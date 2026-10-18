import path from 'node:path'
if(process.env.TRANSCRIPT_BASELINE==='1')Bun.plugin({name:'transcript-baseline',setup(build){build.onLoad({filter:/\/src\/(Transcript\.tsx|transcript\/(Turn|motion|bubble|images|markdown)\.tsx)$/},args=>{const file=path.relative(path.resolve(import.meta.dir,'../../../..'),args.path);const git=Bun.spawnSync(['git','show',`${process.env.TRANSCRIPT_BASE_REF??'9befd131'}:${file}`]);if(git.exitCode)throw Error(git.stderr.toString());return {contents:git.stdout.toString(),loader:'tsx'}})}})
await import('./fixture.tsx')
