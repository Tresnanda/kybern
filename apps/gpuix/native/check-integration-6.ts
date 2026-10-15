// Typecheck an unapplied unified diff through a virtual compiler host.
import ts from 'typescript'
import path from 'node:path'
import {readFileSync} from 'node:fs'
const root=path.resolve(import.meta.dir,'..'), repo=path.resolve(root,'../..')
const patch=readFileSync(path.join(import.meta.dir,'app-integration-6.patch'),'utf8').split('\n')
const overrides=new Map<string,string>()
let filename='',source:string[]=[],result:string[]=[],cursor=0
const finish=()=>{if(filename){result.push(...source.slice(cursor));overrides.set(filename,result.join('\n'))}}
for(let i=0;i<patch.length;i++){
 const line=patch[i]!
 if(line.startsWith('--- '))continue
 if(line.startsWith('+++ b/')){finish();filename=path.join(repo,line.slice(6));source=readFileSync(filename,'utf8').split('\n');result=[];cursor=0;continue}
 const hunk=/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line)
 if(hunk){const begin=Number(hunk[1])-1;result.push(...source.slice(cursor,begin));cursor=begin;continue}
 if(!filename||line==='')continue
 if(line[0]===' '||line[0]==='-'){if(source[cursor]!==line.slice(1))throw Error(`Patch context mismatch: ${filename}:${cursor+1}`);cursor++}
 if(line[0]===' '||line[0]==='+')result.push(line.slice(1))
}
finish()
const config=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile)
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root)
const host=ts.createCompilerHost(parsed.options),get=host.getSourceFile.bind(host)
host.getSourceFile=(file,version,onError,create)=>overrides.has(file)?ts.createSourceFile(file,overrides.get(file)!,version,true):get(file,version,onError,create)
const program=ts.createProgram(parsed.fileNames,parsed.options,host),diagnostics=ts.getPreEmitDiagnostics(program)
if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:f=>f,getNewLine:()=> '\n'}));process.exit(1)}
console.log(`Unapplied integration typecheck passed (${overrides.size} files)`)
