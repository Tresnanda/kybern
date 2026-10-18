import type {AccountSummary} from '../../../../packages/kybern-client/src/types.ts'

type Reader = {call(method:'providers.accounts.list',params:{refresh?:boolean}):Promise<{accounts:AccountSummary[]}>}
const inflight=new WeakMap<Reader,Map<boolean,Promise<{accounts:AccountSummary[]}>>>()

/** Rail/composer reads share probes while pending; explicit refresh stays distinct. */
export function readAccounts(client:Reader,refresh=false):Promise<{accounts:AccountSummary[]}>{
 const reads=inflight.get(client)??new Map<boolean,Promise<{accounts:AccountSummary[]}>>()
 inflight.set(client,reads)
 const pending=reads.get(refresh)
 if(pending)return pending
 const request=client.call('providers.accounts.list',refresh?{refresh:true}:{})
 const shared=request.finally(()=>{if(reads.get(refresh)===shared)reads.delete(refresh)})
 reads.set(refresh,shared)
 return shared
}
