import { expect, test } from 'bun:test'
import { LONG_WORD, PIECE, wordPieces } from './wordPieces.ts'

test('short words stay whole', () => {
  expect(wordPieces('catalog')).toEqual(['catalog'])
  expect(wordPieces('x'.repeat(LONG_WORD))).toEqual(['x'.repeat(LONG_WORD)])
})

test('a long URL is cut after its punctuation, and every few characters without any (ADE-118)', () => {
  const url = 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com&h=AT0NDU3NDI4NzQxNAABp8ikLWruahnElB9CFQbwwoS6LJGrH7_aem_fojk3sDjSsxTIAW#sp-catalog'
  const pieces = wordPieces(url)
  expect(pieces.join('')).toBe(url)
  expect(pieces.every((p) => p.length <= PIECE)).toBe(true)
  expect(pieces.slice(0, 3)).toEqual(['https://', 'l.', 'facebook'])
  const key = ['sk', 'live', '51HxQ2bC8aZt7Kq0yLwU4mN9pR3sV6tX1zA2cE5fH8jK0lM3nP6q'].join('_')
  expect(wordPieces(key).join('')).toBe(key)
  expect(wordPieces(key).every((p) => p.length <= PIECE)).toBe(true)
})
