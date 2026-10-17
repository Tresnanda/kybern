// GPUIX twin of `visual/kit/sections/feedback.tsx`: the same feedback primitives at the same absolute positions.
import type { ComponentType, ReactNode } from 'react'
import { N } from '../../nav/glyphs.ts'
import { Label, useTheme } from '../../ui.tsx'
import { Badge, type BadgeVariant } from '../Badge.tsx'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../Empty.tsx'
import { Skeleton } from '../Skeleton.tsx'
import { Spinner } from '../Spinner.tsx'

const At = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => <div style={{ position: 'absolute', left: x, top: y, display: 'flex' }}>{children}</div>
function Caption({ x, y, children }: { x: number; y: number; children: string }) {
  const t = useTheme()
  return <div style={{ position: 'absolute', left: x, top: y }}><Label color={t.v('--muted-foreground')} size={11} lineHeight={14}>{children}</Label></div>
}

const VARIANTS: BadgeVariant[] = ['default', 'secondary', 'outline', 'destructive', 'error', 'info', 'success', 'warning']
const SIZES = ['sm', 'default', 'lg'] as const
function Feedback({ still = false }: { still?: boolean }) {
  const t = useTheme()
  return (
    <div style={{ position: 'relative', width: 1280, height: 820 }}>
      <Caption x={40} y={16}>Skeleton</Caption>
      <At x={40} y={40}><Skeleton testId="skel-a" width={240} height={16} still={still} /></At>
      <At x={40} y={64}><Skeleton width={176} height={16} still={still} /></At>
      <At x={40} y={92}><Skeleton width={40} height={40} radius={20} still={still} /></At>
      <At x={92} y={92}><Skeleton width={192} height={40} radius={10} still={still} /></At>

      <Caption x={40} y={156}>Spinner</Caption>
      <At x={40} y={180}><Spinner testId="spin-a" spinning={!still} /></At>
      <At x={80} y={184}><Spinner size={16} spinning={!still} /></At>
      <At x={112} y={186}><Spinner size={12} spinning={!still} /></At>
      <At x={140} y={182}><Spinner size={20} color={t.v('--muted-foreground')} spinning={!still} /></At>

      <Caption x={40} y={232}>Badge</Caption>
      {SIZES.map((size, row) => VARIANTS.map((variant, col) => (
        <At key={`${size}-${variant}`} x={40 + col * 86} y={256 + row * 36}><Badge variant={variant} size={size}>{variant}</Badge></At>
      )))}
      <At x={40} y={372}><Badge variant="outline" icon={N.pin}>Pinned</Badge></At>
      <At x={126} y={372}><Badge>3</Badge></At>
      <At x={160} y={372}><Badge variant="info" size="lg">12</Badge></At>

      <Caption x={800} y={16}>Empty</Caption>
      <div testId="empty" style={{ position: 'absolute', left: 800, top: 40, width: 440, height: 340, display: 'flex', borderWidth: 1, borderColor: t.v('--border'), borderRadius: 10 }}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon" icon={N.note} />
            <EmptyTitle>No notes yet</EmptyTitle>
            <EmptyDescription>Notes you save from threads show up here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Label color={t.v('--muted-foreground')} size={14} lineHeight={20}>Press N to write one.</Label></EmptyContent>
        </Empty>
      </div>
    </div>
  )
}

export const sections: Record<string, ComponentType> = { feedback: () => <Feedback />, 'feedback-still': () => <Feedback still /> }
