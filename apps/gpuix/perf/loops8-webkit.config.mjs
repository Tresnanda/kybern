import base from '../../desktop/vite.config.ts'
import {createRequire} from 'node:module'
import path from 'node:path'
const require=createRequire(new URL('../../desktop/package.json',import.meta.url)),root=path.resolve(import.meta.dirname,'../../..')
export default {...base,root:import.meta.dirname,resolve:{...base.resolve,alias:{...base.resolve.alias,react:require.resolve('react/package.json').replace('/package.json',''),'react-dom':require.resolve('react-dom/package.json').replace('/package.json',''),'react/jsx-runtime':require.resolve('react/jsx-runtime')}},optimizeDeps:{entries:['loops8-webkit.html']},server:{host:'127.0.0.1',port:14379,strictPort:true,fs:{allow:[root]}}}
