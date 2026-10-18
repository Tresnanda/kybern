if((process.env.EXPLORER_LIFECYCLE==='1' || process.env.MARKDOWN_DOCUMENT_STATS==='1')) {
 await import('../../src/native/local-build.ts')
 const {GpuixRenderer}=await import('@gpuix/native')
 const prototype=GpuixRenderer.prototype as unknown as Record<string,(...args:any[])=>any>
 for(const method of ['createMarkdownDocument','updateMarkdownDocument','releaseMarkdownDocument']) {
  const original=prototype[method]!
  prototype[method]=function(...args){
   const result=original.apply(this,args)
   void Promise.resolve(result).then(()=>{try{console.error('[markdown-documents]',method,JSON.stringify(this.getMarkdownDocumentStats!()))}catch{}})
   return result
  }
 }
}
await import('../explorer/app.ts')

export {}
