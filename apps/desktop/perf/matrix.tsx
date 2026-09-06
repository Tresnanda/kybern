import { createRoot } from "react-dom/client"
import { MatrixLoader } from "../src/components/kybern/motion"
export function Scene() {
  return (
    <div id="scene">
      <aside>
        <div className="row">Projects</div>
        <div className="row">ade</div>
        {Array.from({ length: 8 }, (_, i) => (
          <div className="row" key={i}>
            {i < 2 ? (
              <MatrixLoader variant="orbit" cycle={1600} dot={2} gap={2} />
            ) : (
              <span style={{ width: 14 }} />
            )}
            <span>
              {
                [
                  "Investigate energy usage",
                  "Develop the mobile client",
                  "Completed conversation",
                ][Math.min(i, 2)]
              }
            </span>
          </div>
        ))}
      </aside>
      <main>
        <h2>Investigate energy usage</h2>
        <p>Keep the same aesthetics while reducing idle animation work.</p>
        <div className="row">
          <MatrixLoader variant="orbit" />
          <span>Working for 1m 20s</span>
        </div>
        <p>
          The agent is thinking. This fixture produces no streaming or timer
          updates.
        </p>
      </main>
    </div>
  )
}
const root = createRoot(document.getElementById("root")!)
root.render(<Scene />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
const link = document.getElementById("motion-css") as HTMLLinkElement
for (const mode of ["baseline", "candidate"])
  document.getElementById(mode)!.onclick = async () => {
    await stylesheet(mode)
    restartAnimations()
    const active = document
      .getAnimations()
      .filter((a) => a.playState === "running").length
    status.textContent =
      mode +
      " — " +
      active +
      " animated dots. No JavaScript animation loop. Properties: " +
      Object.keys(
        (document.getAnimations()[0].effect as KeyframeEffect).getKeyframes()[0]
      ).join(", ")
  }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const status = document.getElementById("status")!
function restartAnimations() {
  // Frozen-phase checks use WAAPI, whose explicit play/pause overrides CSS
  // play-state. Recreate the CSS animations before testing CSS visibility.
  const dots = document.querySelectorAll<HTMLElement>(".t-matrix i")
  for (const dot of dots) dot.style.animation = "none"
  document.getAnimations()
  for (const dot of dots) dot.style.removeProperty("animation")
}
async function stylesheet(mode: string) {
  await new Promise<void>((resolve, reject) => {
    link.onload = () => resolve()
    link.onerror = () => reject(Error("Stylesheet failed to load"))
    link.href =
      (mode === "baseline"
        ? "/perf/matrix-baseline.css"
        : "/src/styles/motion.css") +
      "?direct&t=" +
      Date.now()
  })
  await wait(100)
}
function sample(time: number) {
  const animations = document.getAnimations()
  if (animations.length !== 36)
    throw Error("Expected 36 animated dots; got " + animations.length)
  for (const animation of animations) {
    animation.pause()
    animation.currentTime = time
  }
  return [
    ...document.querySelectorAll<HTMLElement>(".t-matrix i:not(.is-gap)"),
  ].map((dot) => {
    const style = getComputedStyle(dot)
    const canvas = document.createElement("canvas")
    canvas.width = 2
    canvas.height = 1
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = "#242321"
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = "#eeeae5"
    ctx.fillRect(1, 0, 1, 1)
    ctx.globalAlpha = Number(style.opacity)
    ctx.fillStyle = style.backgroundColor
    ctx.fillRect(0, 0, 2, 1)
    return {
      pixel: [...ctx.getImageData(0, 0, 2, 1).data],
      rect: [dot.offsetWidth, dot.offsetHeight],
    }
  })
}
document.getElementById("compare")!.onclick = async () => {
  try {
    status.textContent = "Checking frozen phases…"
    const times = Array.from({ length: 65 }, (_, i) => i * 50)
    await stylesheet("baseline")
    const baseline = times.map(sample)
    await stylesheet("candidate")
    const candidate = times.map(sample)
    let maxDelta = 0
    for (let t = 0; t < times.length; t++)
      for (let d = 0; d < baseline[t].length; d++) {
        const a = baseline[t][d],
          b = candidate[t][d]
        if (JSON.stringify(a.rect) !== JSON.stringify(b.rect))
          throw Error("Dot geometry changed")
        for (let c = 0; c < 8; c++)
          maxDelta = Math.max(maxDelta, Math.abs(a.pixel[c] - b.pixel[c]))
      }
    if (maxDelta > 2)
      throw Error(
        "Composited pixel channel delta " +
          maxDelta +
          " exceeds tolerance 2/255"
      )
    restartAnimations()
    await wait(100)
    status.textContent =
      "PASS: " +
      times.length +
      " frozen phases, " +
      baseline[0].length +
      " dots. Maximum painted channel delta " +
      maxDelta +
      "/255; dot geometry identical on dark and light backgrounds."
    const scene = document.getElementById("scene")!
    scene.style.transform = "translateX(-200vw)"
    await wait(300)
    const dots = [
      ...scene.querySelectorAll<HTMLElement>(".t-matrix i:not(.is-gap)"),
    ]
    if (
      dots.some((dot) => getComputedStyle(dot).animationPlayState !== "paused")
    )
      throw Error("Offscreen animation did not pause")
    const animation = dots[0].getAnimations()[0]
    const pausedTime = Number(animation.currentTime)
    await wait(150)
    if (Number(animation.currentTime) !== pausedTime)
      throw Error("Offscreen animation time continued advancing")
    scene.style.transform = ""
    await wait(300)
    if (
      dots.some((dot) => getComputedStyle(dot).animationPlayState !== "running")
    )
      throw Error("Visible animation did not resume")
    if (Number(animation.currentTime) <= pausedTime)
      throw Error("Visible animation did not resume from its paused phase")
    scene.classList.add("t-pane")
    scene.dataset.active = "false"
    if (
      dots.some((dot) => getComputedStyle(dot).animationPlayState !== "paused")
    )
      throw Error("Inactive mounted pane did not pause its loaders")
    status.textContent +=
      "\nPASS: offscreen time freezes, returning onscreen resumes the same phase, and inactive mounted panes pause their loaders."
  } catch (error) {
    status.textContent = "FAIL: " + error
  } finally {
    const scene = document.getElementById("scene")!
    scene.style.transform = ""
    scene.classList.remove("t-pane")
    delete scene.dataset.active
    restartAnimations()
  }
}
