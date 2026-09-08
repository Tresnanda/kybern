// Desktop and mobile fold the same wire events into the same transcript.
export * from "../../../../packages/kybern-client/src/transcript.ts"
import { reloadOnHotUpdate } from "@/lib/hot"
reloadOnHotUpdate(import.meta.hot)
