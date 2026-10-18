import base from '../../native/surface-webkit.config.mjs'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../../../../',import.meta.url))
export default {...base,cacheDir:fileURLToPath(new URL('../../native/build/backdrop-vite',import.meta.url)),server:{...base.server,port:14379,fs:{allow:[...base.server.fs.allow,root]}}}
