import { mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import path from 'node:path'
import { assertScratchEnv } from '../../src/requests/harness.ts'
assertScratchEnv({KYBERN_URL:''})
const root=JSON.parse(readFileSync(path.join(process.env.KYBERN_DATA_DIR!,'fixture.json'),'utf8')).root as string
const directory=path.join(root,'markdown-cases');mkdirSync(directory,{recursive:true})
const section=(n:number)=>`## Section ${n}\n\nA long document with **bold**, _emphasis_, [global link][ref] and inline \`code\`. 😀é\n\n- First item\n  continuation\n  - Nested item\n- [x] Completed task\n\n> A quote\n>\n> Nested **formatting**.\n\n| Name | Count |\n| --- | ---: |\n| Row ${n} | ${n} |\n\n\`\`\`typescript\n/* multiline\ncomment */\nexport const item${n} = { count: ${n} };\n\`\`\`\n\n`
let long='# Section 0 · two MiB document\n\n'
for(let n=0;Buffer.byteLength(long)<1950*1024;n++)long+=section(n)
long+='[ref]: https://example.com/global\n\nEND \`sentinel\` reachable.\n'
const sources:Record<string,string>={
 'two-mib.md':long,
 'giant-paragraph.md':'# Section 0 · giant paragraph\n\n'+('A **bold** paragraph with Unicode 😀é and links [reference][ref]. ').repeat(18000)+'\n\n[ref]: https://example.com/target\n\nEND sentinel reachable.',
 'giant-inline.md':'# Section 0 · giant inline paragraph\n\n'+('Paragraph with \`inline code\` Unicode 😀é and **bold** words. ').repeat(16000)+'\n\nEND sentinel reachable.',
 'giant-table.md':'# Section 0 · giant table\n\n| Name | Count | Code |\n|---|---:|---|\n'+Array.from({length:18000},(_,i)=>`| Row ${i} | ${i} | \`value${i}\` |`).join('\n')+'\n\nEND sentinel reachable.',
 'giant-code.md':'# Section 0 · giant code fence\n\n\`\`\`typescript\n/* multiline\n'+Array.from({length:20000},(_,i)=>` comment ${i}: ${"long highlighted lexical content ".repeat(2)}`).join('\n')+'\n*/\nexport const sentinel = "😀é";\n\`\`\`\n\nEND sentinel reachable.',
 'giant-list.md':'# Section 0 · giant list\n\n'+Array.from({length:16000},(_,i)=>`${i+1}. Item **${i}**\n    continuation\n    - nested`).join('\n')+'\n\nEND sentinel reachable.',
}
for(const [file,source]of Object.entries(sources)) {
 if(Buffer.byteLength(source)>2*1024*1024)throw Error(`${file} exceeds two MiB`)
 writeFileSync(path.join(directory,file),source)
 console.log(file,Buffer.byteLength(source),source.split('\n').length)
}
