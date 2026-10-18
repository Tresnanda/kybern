/** Inclusive stack counts are diagnostic and overlap; never sum categories. */
import {readFileSync} from 'node:fs'
const categories:Record<string,RegExp>={taffy:/taffy::|flexbox::|compute_flexbox|compute_cached_layout/i,react:/commitRoot|commitMutation|react.reconciler/i,textShaping:/CoreText|CTLine|shape_line|shape_text|text_system|text_layout/i,markdownParse:/pulldown_cmark|markdown.*parse|parse_markdown|syntect.*parse/i,paint:/::paint[<(]|paint_line|prepaint/i,sceneBuild:/Scene::|scene::Scene|build_element|build_node/i,gpuSubmit:/MetalRenderer|MTLCommand|AGXMetal|CAMetalLayer/i}
for(const file of process.argv.slice(2)){
 const raw=readFileSync(file,'utf8'),result:Record<string,unknown>={file,note:'Largest inclusive stack count per category; overlapping, not percentages of wall time.'}
 for(const [category,pattern]of Object.entries(categories)){const lines=raw.split('\n').flatMap(line=>{const m=line.match(/^\s*(?:[+|!: ]*)?(\d+)\s+(.+)$/);return m&&pattern.test(m[2]!)?[{count:Number(m[1]),symbol:m[2]!.trim()}]:[]}).sort((a,b)=>b.count-a.count);result[category]=lines[0]??null}
 console.log(JSON.stringify(result,null,2))
}
