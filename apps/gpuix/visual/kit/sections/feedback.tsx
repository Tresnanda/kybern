// Desktop reference for the `feedback` group: Skeleton, Spinner, Empty, Badge, at fixed absolute positions so the
// GPUIX twin (`src/kit/gallery/feedback.tsx`) lines up pixel for pixel.
import type { ComponentType, ReactNode } from 'react'
import { Skeleton } from '@/components/kit/skeleton'
import { Spinner } from '@/components/kit/spinner'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/kit/empty'
import { Badge } from '@/components/kit/badge'
import { NoteIcon, PinIcon } from '@/lib/kit/icons'

const At = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => <div style={{ position: 'absolute', left: x, top: y, display: 'flex' }}>{children}</div>
const Caption = ({ x, y, children }: { x: number; y: number; children: string }) => <div style={{ position: 'absolute', left: x, top: y, fontSize: 11, lineHeight: '14px' }} className="text-muted-foreground">{children}</div>

const VARIANTS = ['default', 'secondary', 'outline', 'destructive', 'error', 'info', 'success', 'warning'] as const
const SIZES = ['sm', 'default', 'lg'] as const

function Feedback() {
  return (
    <div style={{ position: 'relative', width: 1280, height: 820 }}>
      <Caption x={40} y={16}>Skeleton</Caption>
      <At x={40} y={40}><Skeleton data-testid="skel-a" className="h-4 w-60" /></At>
      <At x={40} y={64}><Skeleton className="h-4 w-44" /></At>
      <At x={40} y={92}><Skeleton className="size-10 rounded-full" /></At>
      <At x={92} y={92}><Skeleton className="h-10 w-48 rounded-lg" /></At>

      <Caption x={40} y={156}>Spinner</Caption>
      <At x={40} y={180}><Spinner data-testid="spin-a" /></At>
      <At x={80} y={184}><Spinner className="size-4" /></At>
      <At x={112} y={186}><Spinner className="size-3" /></At>
      <At x={140} y={182}><Spinner className="size-5 text-muted-foreground" /></At>

      <Caption x={40} y={232}>Badge</Caption>
      {SIZES.map((size, row) => VARIANTS.map((variant, col) => (
        <At key={`${size}-${variant}`} x={40 + col * 86} y={256 + row * 36}><Badge variant={variant} size={size}>{variant}</Badge></At>
      )))}
      <At x={40} y={372}><Badge variant="outline"><PinIcon />Pinned</Badge></At>
      <At x={126} y={372}><Badge>3</Badge></At>
      <At x={160} y={372}><Badge variant="info" size="lg">12</Badge></At>

      <Caption x={800} y={16}>Empty</Caption>
      <div data-testid="empty" style={{ position: 'absolute', left: 800, top: 40, width: 440, height: 340, display: 'flex' }} className="rounded-lg border">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><NoteIcon /></EmptyMedia>
            <EmptyTitle>No notes yet</EmptyTitle>
            <EmptyDescription>Notes you save from threads show up here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><span className="text-muted-foreground">Press N to write one.</span></EmptyContent>
        </Empty>
      </div>
    </div>
  )
}

export const sections: Record<string, ComponentType> = { feedback: Feedback, 'feedback-still': Feedback }
