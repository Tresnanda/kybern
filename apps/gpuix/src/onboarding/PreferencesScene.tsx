// The last scene (SPEC §5): "Make it yours." Appearance and window material on the left, the default permission mode on the right,
// Back and Start building under them. Every control writes live (theme, window material, permission mode), so Start building only
// ends the flow. Two columns from 880 px of window width, one under it, and then the scene scrolls when the window is short.
import { useWindowSize } from '@gpuix/react'
import { Button } from '../kit/Button.tsx'
import { TITLEBAR } from '../nav/TitleBar.tsx'
import { DESKTOP_MATERIAL } from '../platform/desktopMaterial.ts'
import { Label, useTheme } from '../ui.tsx'
import { AppearancePicker } from './AppearancePicker.tsx'
import { Cta } from './Cta.tsx'
import { getImportSummary } from './projectsStore.ts'
import { finishFlow, goFrom } from './flow.ts'
import { windowMaterialAvailable } from './model.ts'
import { In, Words } from './motion.tsx'
import { PermissionList } from './PermissionList.tsx'
import { Later, SceneHeading, useScenePrimary } from './sceneKit.tsx'
import { COLUMN_GAP, SIDE_PAD, prefsLayout } from './prefsLayout.ts'
import { WindowMaterialPicker } from './WindowMaterialPicker.tsx'

const CAL = 'Cal Sans'
const HEADING = ['Make', 'it', 'yours.']

/** A section label above a control group (12/600, inset 4 like the prototype's `glabel`). */
function Section({ children }: { children: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', paddingLeft: 4, paddingBottom: 10 }}><Label color={t.textSecondary} size={12} lineHeight={16} weight={600}>{children}</Label></div>
}

export function PreferencesScene() {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 300 })
  const width = size?.width ?? 1440
  const height = size?.height ?? 900
  const L = prefsLayout(width)
  const heading = width < 560 ? 36 : 44
  const done = () => {
    finishFlow('built', getImportSummary().recentProjectId)
  }
  useScenePrimary('prefs', done)
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
      <div testId="onboarding-prefs" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', overflowY: 'scroll' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0, minHeight: height, paddingTop: TITLEBAR + 8, paddingBottom: 32, paddingLeft: SIDE_PAD, paddingRight: SIDE_PAD }}>
          <SceneHeading id="prefs" label="Make it yours."><Words lines={[HEADING]} size={heading} lineHeight={Math.round(heading * 1.1)} color={t.text} font={CAL} base={0.1} /></SceneHeading>
          <div style={{ height: 10 }} />
          <In delay={0.42} y={10} style={{ alignItems: 'center' }}>
            <Label color={t.textSecondary} size={16} lineHeight={24} style={{ textAlign: 'center' }}>You can change these anytime in Settings.</Label>
          </In>
          <div style={{ height: 28 }} />
          <div style={{ display: 'flex', flexDirection: L.two ? 'row' : 'column', alignItems: 'flex-start', columnGap: COLUMN_GAP, rowGap: 28, width: L.width }}>
            <In delay={0.5} style={{ width: L.left, gap: 22 }}>
              <div style={{ display: 'flex', flexDirection: 'column', width: L.left }}>
                <Section>Appearance</Section>
                <Later frames={1}><AppearancePicker card={L.card} previewWidth={L.preview.width} previewHeight={L.preview.height} /></Later>
              </div>
              {/* Linux and Windows 10 draw Kybern's window opaque, so there is nothing to choose: the section is not offered. */}
              {windowMaterialAvailable(DESKTOP_MATERIAL) && (
                <div style={{ display: 'flex', flexDirection: 'column', width: L.left }}>
                  <Section>Window</Section>
                  <Later frames={2}><WindowMaterialPicker column={L.left} card={L.card} previewWidth={L.preview.width} previewHeight={L.preview.height} /></Later>
                </div>
              )}
            </In>
            <In delay={0.58} style={{ width: L.right }}>
              <Section>When an agent wants to change something</Section>
              <Later frames={3}><PermissionList column={L.right} /></Later>
            </In>
          </div>
          <div style={{ height: 28 }} />
          <In delay={0.66} y={10} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: L.width }}>
            <Button testId="onboarding-prefs-back" variant="ghost" size="lg" icon="arrowLeft" onClick={() => goFrom('prefs', 'projects')}>Back</Button>
            <Cta testId="onboarding-done" onClick={done}>Start building</Cta>
          </In>
        </div>
      </div>
    </div>
  )
}
