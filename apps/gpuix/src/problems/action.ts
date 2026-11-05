// `reportError(title, error)` callers wrote a title ("Unable to open link", "Unable to ask Claude to sign in. Try again"); a problem wants the
// verb phrase that follows "Couldn't": "open link", "ask Claude to sign in". New code passes the phrase itself.

/** The phrase for "Couldn't …" in `title`: the first sentence, without "Unable to", "Couldn’t" or a trailing "Try again". */
export function actionPhrase(title: string): string {
  const first = title.trim().split(/(?<=[a-z0-9)])\.\s/i)[0]!
  const phrase = first.replace(/[.!]+$/, '').replace(/^(unable to|couldn['’]t|could not|failed to)\s+/i, '').replace(/\s*[.,]?\s*try again$/i, '').trim()
  return phrase || 'finish that'
}
