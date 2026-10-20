import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
const out=path.join(import.meta.dir,'build/syntax-check');mkdirSync(out,{recursive:true})
const fixtures: readonly [string,string,boolean?][]=[
 ['typescript','/* start\n😀 comment\nend */\nconst x = `multiline\né string`;\nconst y = 12;'],
 ['python','text = """start\n😀 continued\nend"""\nprint(text)'],
 ['bash','cat <<\'EOF\'\n😀 heredoc\nEOF\necho "$HOME"'],
 ['html','<script>\n/* embedded\n😀 comment */\nconst n = 1;\n</script>'],
 ['unsupported-language','plain 😀\né text\n\n'],
 ['typescript','/* A comment that wraps while retaining its lexical context across a range boundary and includes 😀 Unicode\ncontinued text that wraps across the whole available width without losing syntax colours or source characters\n*/\nconst message = "A long string that wraps with é Unicode and keeps highlighted colours across its entire logical source line";',true],
]
try{
 for(const appearance of ['dark','light'])for(const [language,source,wrap=false] of fixtures){
  let baseline:Buffer|undefined
  for(let split=-1;split<=source.split('\n').length;split++){
   const f=await launchFixture(path.join(import.meta.dir,'syntax-lab.tsx'),{KYBERN_APPEARANCE:appearance,GPUIX_BACKGROUND:'1',SYNTAX_SOURCE:source,SYNTAX_LANGUAGE:language,SYNTAX_SPLIT:String(split),SYNTAX_WRAP:wrap?'1':'0'})
   try{
    await f.app.getByTestId('ready').waitFor()
    const file=path.join(out,`${appearance}-${language}-${split}.png`);await f.app.screenshot({path:file})
    const image=readFileSync(file)
    if(split===-1)baseline=image;else assert.ok(image.equals(baseline!),`${appearance} ${language} boundary ${split} differs from whole-document paint`)
    if(split>0)rmSync(file)
   }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
  }
  console.log(`ok ${appearance} ${language}${wrap?' wrapped':''}: every line boundary pixel-identical to whole-document rendering`)
 }
}finally{if(!process.env.KEEP_SYNTAX_SHOTS)rmSync(out,{recursive:true,force:true})}
