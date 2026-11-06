import { describe, expect, test } from 'bun:test'
import { githubSegments } from './segments.ts'

const ATTACHMENT = 'https://github.com/user-attachments/assets/a519dc07-d427-4203-ab12-f5d66c026c71'

describe('githubSegments', () => {
  test('text without images is one segment, comments removed', () => {
    expect(githubSegments('Hello <!-- template -->\n\n**world**')).toEqual([{ kind: 'text', text: 'Hello \n\n**world**' }])
  })

  test("GitHub's own HTML image becomes an image with its size", () => {
    const body = `It breaks here:\n\n<img width="512" height="687" alt="Image" src="${ATTACHMENT}" />\n\nThanks`
    expect(githubSegments(body)).toEqual([
      { kind: 'text', text: 'It breaks here:\n' },
      { kind: 'image', source: ATTACHMENT, alt: 'Image', width: 512, height: 687 },
      { kind: 'text', text: '\nThanks' },
    ])
  })

  test('Markdown images on their own lines, linked or not', () => {
    expect(githubSegments('![Shot](https://example.com/a.png)\n[![Badge](https://img.shields.io/x.svg)](https://ci)')).toEqual([
      { kind: 'image', source: 'https://example.com/a.png', alt: 'Shot' },
      { kind: 'image', source: 'https://img.shields.io/x.svg', alt: 'Badge' },
    ])
  })

  test('a Markdown image inside a sentence stays in the text', () => {
    expect(githubSegments('Look ![x](https://e/a.png) here')).toEqual([{ kind: 'text', text: 'Look ![x](https://e/a.png) here' }])
  })

  test('the tags around an HTML image go with it; other HTML stays text', () => {
    const body = `<p align="center"><a href="${ATTACHMENT}"><img src='${ATTACHMENT}' alt="Logo" width=40%></a></p>\n<details><summary>Logs</summary>`
    expect(githubSegments(body)).toEqual([
      { kind: 'image', source: ATTACHMENT, alt: 'Logo' },
      { kind: 'text', text: '<details><summary>Logs</summary>' },
    ])
  })

  test('an HTML image inside a sentence is lifted out of it', () => {
    expect(githubSegments('Before <img src="https://e/a.png"> after')).toEqual([
      { kind: 'text', text: 'Before' },
      { kind: 'image', source: 'https://e/a.png', alt: '' },
      { kind: 'text', text: 'after' },
    ])
  })

  test('a picture keeps its fallback image; a tag over several lines reads as one', () => {
    const body = '<picture>\n<source media="(prefers-color-scheme: dark)" srcset="https://e/dark.png">\n<img\n  alt="Chart"\n  src="https://e/light.png?a=1&amp;b=2">\n</picture>'
    expect(githubSegments(body)).toEqual([{ kind: 'image', source: 'https://e/light.png?a=1&b=2', alt: 'Chart' }])
  })

  test('images in fenced code stay code', () => {
    const body = '```html\n<img src="https://e/a.png">\n![x](https://e/b.png)\n```'
    expect(githubSegments(body)).toEqual([{ kind: 'text', text: body }])
  })

  test('an image without a source is still an image, never shown as HTML', () => {
    expect(githubSegments('<img alt="Screenshot">')).toEqual([{ kind: 'image', source: '', alt: 'Screenshot' }])
  })
})
