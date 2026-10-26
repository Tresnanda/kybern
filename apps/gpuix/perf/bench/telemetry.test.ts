import {expect,test} from 'bun:test'
import {bridgeDelta,type BridgeStats} from './telemetry.ts'
const stats=(over:Partial<BridgeStats>):BridgeStats=>({bridged:true,sent:0,waited:0,waitMs:0,servedFrames:0,frameWakes:0,platform:'X11',...over})
test('bridge traffic per served frame over a window',()=>{
 const delta=bridgeDelta(stats({sent:10,waited:4,waitMs:1,servedFrames:100,drawnFrames:70,callbackFrames:30,frameWakes:0}),stats({sent:130,waited:10,waitMs:4,servedFrames:160,drawnFrames:110,callbackFrames:50,frameWakes:0}))
 expect(delta).toEqual({platform:'X11',bridged:true,servedFrames:60,drawnFrames:40,callbackFrames:20,frameWakes:0,sent:120,waited:6,waitMs:3,sentPerFrame:2,waitedPerFrame:0.1,waitMsPerFrame:0.05})
})
test('macOS reports wakes without per-frame bridge values',()=>{
 const delta=bridgeDelta(stats({bridged:false,servedFrames:null,platform:'macos'}),stats({bridged:false,servedFrames:null,frameWakes:120,platform:'macos'}))
 expect(delta?.frameWakes).toBe(120)
 expect(delta?.sentPerFrame).toBeNull()
})
test('an addon without counters gives no bridge evidence',()=>{
 expect(bridgeDelta(null,stats({}))).toBeNull()
})
