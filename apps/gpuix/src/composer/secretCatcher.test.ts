import { describe, expect, test } from 'bun:test'
import { entropy, findSecret, insertedRange, looksRandom, scanInsert, toEnvName } from './secretCatcher.ts'

// Fake keys, built from characters so no scanner mistakes this file for a leak.
const rand = (length: number, seed = 7) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let x = seed, out = ''
  for (let i = 0; i < length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out += alphabet[(x >> 8) % alphabet.length] }
  return out
}
const anthropic = `sk-ant-api03-${rand(88)}`
const openai = `sk-proj-${rand(48, 3)}`
const github = `ghp_${rand(36, 5)}`

describe('prefix rules', () => {
  test.each([
    ['Anthropic', 'ANTHROPIC_API_KEY', anthropic],
    ['OpenAI', 'OPENAI_API_KEY', openai],
    ['GitHub', 'GITHUB_TOKEN', github],
    ['GitHub', 'GITHUB_TOKEN', `github_pat_${rand(22, 9)}_${rand(59, 11)}`],
    ['AWS', 'AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE'],
    ['Slack', 'SLACK_BOT_TOKEN', `xoxb-${rand(12, 2)}-${rand(24, 4)}`],
    ['GitLab', 'GITLAB_TOKEN', `glpat-${rand(20, 6)}`],
    ['Stripe', 'STRIPE_SECRET_KEY', `sk_live_${rand(30, 8)}`],
    ['Stripe', 'STRIPE_RESTRICTED_KEY', `rk_live_${rand(30, 8)}`],
    ['Google', 'GOOGLE_API_KEY', `AIza${rand(35, 12)}`],
  ])('%s key → %s', (provider, name, key) => {
    const text = `here it is: ${key} thanks`
    const match = findSecret(text)
    expect(match).toMatchObject({ provider, name, value: key })
    expect(text.slice(match!.start, match!.end)).toBe(key)
  })

  test('an Anthropic key is not read as an OpenAI key', () => {
    expect(findSecret(anthropic)?.provider).toBe('Anthropic')
  })

  test('a private key block is caught to its END line, or to the end of a short paste', () => {
    const block = `-----BEGIN OPENSSH PRIVATE KEY-----\n${rand(60)}\n${rand(60, 2)}\n-----END OPENSSH PRIVATE KEY-----`
    expect(findSecret(`use this\n${block}\nplease`)).toMatchObject({ name: 'PRIVATE_KEY', value: block })
    expect(findSecret(`-----BEGIN RSA PRIVATE KEY-----\n${rand(40)}`)?.name).toBe('PRIVATE_KEY')
  })

  test('a long JWT is caught, a short one is not', () => {
    const jwt = `eyJ${rand(40)}.eyJ${rand(60, 2)}.${rand(43, 3)}`
    expect(findSecret(jwt)?.name).toBe('JWT')
    expect(findSecret(`eyJ${rand(12)}.eyJ${rand(12, 2)}.${rand(12, 3)}`)).toBeNull()
  })

  test('a URL with a real password is caught, a documentation placeholder is not', () => {
    expect(findSecret(`postgres://app:${rand(20)}@db.internal:5432/main`)).toMatchObject({ name: 'DATABASE_URL' })
    expect(findSecret('postgres://user:password@localhost:5432/main')).toBeNull()
    expect(findSecret('https://example.com/docs?x=1')).toBeNull()
  })
})

describe('assignments take their own name and quotes', () => {
  test('KEY=value pastes are replaced whole and keep the left side', () => {
    const text = `MY_SERVICE_KEY=${anthropic}`
    expect(findSecret(text)).toMatchObject({ name: 'MY_SERVICE_KEY', start: 0, end: text.length, value: anthropic })
  })
  test('export and quotes', () => {
    const text = `x\nexport OPENAI_API_KEY="${openai}"\ny`
    const match = findSecret(text)!
    expect(text.slice(match.start, match.end)).toBe(`export OPENAI_API_KEY="${openai}"`)
    expect(match.name).toBe('OPENAI_API_KEY')
  })
  test('a generic left side keeps the prefix name', () => {
    expect(findSecret(`key: ${github}`)?.name).toBe('GITHUB_TOKEN')
    expect(findSecret(`token=${anthropic}`)?.name).toBe('ANTHROPIC_API_KEY')
  })
  test('entropy decides only right after a key-like name', () => {
    const value = rand(40, 21)
    expect(findSecret(`ACME_API_TOKEN=${value}`)).toMatchObject({ provider: 'a key', name: 'ACME_API_TOKEN', value })
    expect(findSecret(`some random text ${value}`)).toBeNull()
    expect(findSecret(`ACME_API_TOKEN=${'a'.repeat(40)}`)).toBeNull()
  })
})

describe('things that are not secrets', () => {
  test.each([
    ['a git SHA', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'],
    ['a SHA-256', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['a SHA after a key-like name', 'COMMIT_SHA_KEY=4b825dc642cb6eb9a060e54bf8d69288fbee4904'],
    ['a UUID after a key-like name', 'REQUEST_KEY=123e4567-e89b-12d3-a456-426614174000'],
    ['a path', '/Users/mymac/projects/ade/apps/gpuix/src/composer/Composer.tsx'],
    ['a path after a key-like name', 'KEY_FILE=/Users/mymac/projects/ade/apps/gpuix/src/composer/key.pem'],
    ['a URL', 'https://github.com/Tresnanda/ade/pull/123/files?diff=split&w=1'],
    ['a Stripe test key', `sk_test_${rand(30)}`],
    ['a Stripe publishable key', `pk_live_${rand(30)}`],
    ['a sentence', 'please use the existing helper in the composer folder for this'],
    ['a long identifier', 'someVeryLongCamelCaseFunctionNameThatIsNotAKeyAtAll_andMore'],
    ['a short sk- word', 'sk-learn is a library'],
  ])('%s', (_label, text) => {
    expect(findSecret(text)).toBeNull()
  })

  test('a key inside a longer word is not matched', () => {
    expect(findSecret(`x${github}`)).toBeNull()
  })
})

describe('only what was inserted is scanned', () => {
  test('a paste into existing text', () => {
    const before = 'please use this: '
    expect(scanInsert(before, before + anthropic)).toMatchObject({ name: 'ANTHROPIC_API_KEY' })
  })
  test('typing and short edits are never scanned', () => {
    expect(scanInsert('', 'sk-')).toBeNull()
    expect(scanInsert(anthropic.slice(0, -1), anthropic)).toBeNull()
  })
  test('deleting around a key that was already there does not re-flag it', () => {
    expect(scanInsert(`${anthropic} extra`, anthropic)).toBeNull()
  })
  test('an insert elsewhere in text that already holds a key does not flag the old key', () => {
    const text = `${anthropic} and `
    expect(scanInsert(text, `${text}some new words typed here`)).toBeNull()
  })
  test('pasting over a longer selection still counts as an insert', () => {
    const before = 'The fix is in 4b825dc642cb6eb9a060e54bf8d69288fbee4904 and in /Users/mymac/projects/ade/apps/gpuix/src/composer/Composer.tsx'
    expect(scanInsert(before, `Use this: ${anthropic}`)).toMatchObject({ name: 'ANTHROPIC_API_KEY' })
  })
  test('insertedRange keeps common prefix and suffix', () => {
    expect(insertedRange('ab cd', 'ab XYZ cd')).toEqual({ start: 3, end: 7 })
    expect(insertedRange('abc', 'ab')).toBeNull()
  })
})

describe('helpers', () => {
  test('names', () => {
    expect(toEnvName('apiKey')).toBe('API_KEY')
    expect(toEnvName('my-service.token')).toBe('MY_SERVICE_TOKEN')
    expect(toEnvName('9lives')).toBe('_9LIVES')
    expect(toEnvName('---')).toBeNull()
  })
  test('entropy', () => {
    expect(entropy('aaaa')).toBe(0)
    expect(entropy('abcd')).toBe(2)
    expect(looksRandom(rand(40))).toBe(true)
    expect(looksRandom('a'.repeat(40))).toBe(false)
  })
})
