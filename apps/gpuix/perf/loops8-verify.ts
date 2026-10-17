for(const args of [['perf/loops8-native-check.ts','region'],['perf/loops8-native-check.ts','frame'],['perf/loops8-native-check.ts','text'],['perf/loops8-spinner-check.ts'],['perf/loops8-native-check.ts','desktop-loops']]){
 const child=Bun.spawn(['bun',...args],{env:process.env,stdout:'inherit',stderr:'inherit'})
 const code=await child.exited;if(code)throw Error(`${args.join(' ')} failed ${code}`)
}

export {}
