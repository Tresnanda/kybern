import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/synara/button"
import { Input } from "@/components/synara/input"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "@/components/synara/dialog"
import { FolderIcon } from "@/lib/synara/icons"
import { Spinner } from "@/components/kybern/bits"
import { activeEnvironment } from "@/state/environments"
import { addProject, errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import type { ProjectsBrowseResult } from "@/protocol"
import {
  ENVIRONMENT_DIALOG,
  ENVIRONMENT_HINT,
  ENVIRONMENT_ERROR,
} from "./environmentStyles"

export function ProjectPicker({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className={ENVIRONMENT_DIALOG}>
        <PickerContents onDone={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  )
}

function PickerContents({ onDone }: { onDone: () => void }) {
  const [path, setPath] = useState("")
  const [listing, setListing] = useState<ProjectsBrowseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const sequence = useRef(0)
  const [client] = useState(() => rpc())
  const [store] = useState(() => useStore)
  const name = activeEnvironment()?.name ?? "this environment"
  async function browse(path?: string) {
    const attempt = ++sequence.current
    setBusy(true)
    setError(null)
    try {
      const result = await client.call("projects.browse", path ? { path } : {})
      if (attempt !== sequence.current) return
      setPath(result.path)
      setListing(result)
    } catch (e) {
      if (attempt === sequence.current) setError(errorText(e))
    } finally {
      if (attempt === sequence.current) setBusy(false)
    }
  }
  useEffect(() => {
    let active = true
    void client
      .call("projects.browse", {})
      .then((result) => {
        if (active) {
          setPath(result.path)
          setListing(result)
        }
      })
      .catch((error) => {
        if (active) setError(errorText(error))
      })
      .finally(() => {
        if (active) setBusy(false)
      })
    return () => {
      active = false
    }
  }, [client])
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add project</DialogTitle>
        <DialogDescription>Choose a folder on {name}.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-3 pt-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void browse(path)
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={dialogFieldLabelClassName}>Folder path</span>
            <Input
              aria-label="Project folder path"
              dir="ltr"
              autoFocus
              value={path}
              onChange={(e) => setPath(e.target.value)}
              spellCheck={false}
            />
          </label>
          <Button type="submit" variant="secondary" disabled={busy || !path}>
            Open folder
          </Button>
        </form>
        <div
          aria-busy={busy}
          aria-label="Folders"
          className="h-64 max-h-[40dvh] overflow-y-auto overscroll-contain rounded-lg border border-border p-1"
        >
          {listing?.parent && (
            <button
              type="button"
              onClick={() => void browse(listing.parent!)}
              className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[length:var(--app-font-size-ui,14px)] outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring active:bg-muted"
              disabled={busy}
            >
              <FolderIcon className="size-3.5" /> Parent folder
            </button>
          )}
          {listing?.directories.map((directory) => (
            <button
              key={directory.path}
              type="button"
              disabled={busy}
              onClick={() => void browse(directory.path)}
              className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[length:var(--app-font-size-ui,14px)] outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring active:bg-muted"
            >
              <FolderIcon className="size-3.5 shrink-0" />
              <bdi className="min-w-0 leading-relaxed break-words">
                {directory.name}
              </bdi>
            </button>
          ))}
          {busy && (
            <div
              role="status"
              className={`flex items-center justify-center gap-2 p-3 ${ENVIRONMENT_HINT}`}
            >
              <Spinner size={15} /> Loading folders…
            </div>
          )}
          {!busy && listing?.directories.length === 0 && (
            <p className={`px-2 py-3 ${ENVIRONMENT_HINT}`}>
              No subfolders. Add this folder as a project, or enter another
              path.
            </p>
          )}
          {listing?.has_more && (
            <p className={`px-2 py-3 ${ENVIRONMENT_HINT}`}>
              Showing the first 1,000 folders. Enter a path to open another
              folder.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className={ENVIRONMENT_ERROR}>
            {error}
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button
          disabled={busy || !path.trim()}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              if (store !== useStore || client !== rpc()) return
              const project = await addProject(path)
              store.getState().selectDraft(project.id)
              onDone()
            } catch (e) {
              setError(errorText(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          Add this folder
        </Button>
      </DialogFooter>
    </>
  )
}
