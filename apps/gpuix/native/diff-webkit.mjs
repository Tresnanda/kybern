const {webkit}=await import('/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const browser=await webkit.launch()
try { for(const theme of ['dark','light']) {
 const page=await browser.newPage({viewport:{width:728,height:800},deviceScaleFactor:2,colorScheme:theme});page.on('pageerror',e=>console.error(e));
 await page.goto(`http://127.0.0.1:14372/diff-webkit.html?theme=${theme}`);await page.waitForSelector('table');await page.waitForTimeout(500);
 await page.screenshot({path:`/Users/mymac/projects/ade/previews/gpuix/p1f/diff-${theme}-tauri.png`});
 console.log(theme,await page.locator('tr').evaluateAll(es=>es.map(e=>({text:e.textContent?.slice(0,55),y:e.getBoundingClientRect().y,height:e.getBoundingClientRect().height}))));await page.close()
}}finally{await browser.close()}
