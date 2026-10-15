import "../native/local-build.ts"
import { render } from "@gpuix/react"
import { useState } from "react"
import type { TurnGroup } from "../../../../packages/kybern-client/src/transcript.ts"
import { MessageRail } from "./rail.tsx"
import { ThemeProvider, useTheme } from "../ui.tsx"
const turns = Array.from({ length: 40 }, (_, i) => ({ turnId: `turn-${i}`, user: { id: `user-${i}`, message: { parts: [{ type: "text", text: `Message ${i + 1}: review the implementation` }] } } })) as TurnGroup[]
function Fixture() {
  const t = useTheme(), [active, setActive] = useState("turn-0")
  return <div testId="navigation-ready" style={{ position: "relative", width: "100%", height: "100%", backgroundColor: t.surface }}>
    <text testId="active-message" style={{ color: t.text }}>{active}</text>
    <MessageRail turns={turns} active={active} onJump={setActive} />
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: "Message navigation", width: 900, height: 820, focus: false })
process.stdin.on("end", () => process.exit(0))
