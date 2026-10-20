import base from '/Users/mymac/projects/ade/apps/desktop/vite.config.ts'
import {createRequire} from 'node:module'
const require=createRequire('/Users/mymac/projects/ade/apps/desktop/package.json')
export default {...base,root:import.meta.dirname,resolve:{...base.resolve,alias:{...base.resolve.alias,'react':require.resolve('react/package.json').replace('/package.json',''),'react-dom':require.resolve('react-dom/package.json').replace('/package.json',''),'react/jsx-runtime':require.resolve('react/jsx-runtime')}},optimizeDeps:{entries:['surface-webkit.html']},server:{host:'127.0.0.1',port:14373,strictPort:true,fs:{allow:['/Users/mymac/projects/ade','/Users/mymac/projects/ade-gpuix-native']}}}
