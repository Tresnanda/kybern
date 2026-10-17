// One native SVG mask. Its parent supplies the white quiet-zone background;
// GPUIX tints SVGs as monochrome masks, so a white SVG rect would hide the QR.
import { qrcodegen } from '../vendor/qrcodegen.ts'

export function pairingQrMatrix(invitation: string): boolean[][] {
  const qr = qrcodegen.QrCode.encodeText(invitation, qrcodegen.QrCode.Ecc.MEDIUM)
  return Array.from({ length: qr.size }, (_, y) => Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y)))
}
export function pairingQrSvg(invitation: string): string {
  const matrix = pairingQrMatrix(invitation)
  let path = ''
  for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) {
    if (matrix[y]![x]) path += `M${x + 4} ${y + 4}h1v1h-1z`
  }
  const size = matrix.length + 8
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><path d="${path}" fill="#000"/></svg>`
}
