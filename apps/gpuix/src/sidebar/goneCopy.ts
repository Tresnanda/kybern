// The words of a project row's line for a machine whose copy of the project lost its folder (`GoneCopyRow`).

export interface GoneCopyCopy {
  title: string
  body: string
  addAgain: string
  remove: string
}

export function goneCopyCopy({ machineName, isLocal }: { machineName: string; isLocal: boolean }): GoneCopyCopy {
  const where = isLocal ? 'this computer' : machineName
  return {
    title: `Folder is gone on ${where}`,
    body: `Kybern still lists the project there, but its repositories were deleted.`,
    addAgain: 'Add again',
    remove: 'Remove',
  }
}
