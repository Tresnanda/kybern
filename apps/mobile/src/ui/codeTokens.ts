export type CodeToken = {
  text: string;
  kind: "plain" | "string" | "comment" | "keyword" | "number";
};
const keywords = new Set(
  "as async await break case catch class const continue def default delete do else enum export extends false final fn for from function if impl import in interface let match mod move mut new nil None null private pub public raise return self static struct super switch this throw trait true try type typeof undefined use var void while with yield".split(
    " ",
  ),
);
// A bounded lexical highlighter for the source viewer. Every byte remains selectable.
export function codeTokens(text: string, language: string): CodeToken[] {
  const hashComments = /^(py|python|rb|ruby|sh|bash|zsh|yaml|yml|toml)$/.test(
    language,
  );
  const expression = hashComments
    ? /(#.*$|"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/gm
    : /(\/\/.*$|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/gm;
  const result: CodeToken[] = [];
  let end = 0;
  for (const match of text.matchAll(expression)) {
    if (match.index > end)
      result.push({ text: text.slice(end, match.index), kind: "plain" });
    const value = match[0];
    const kind =
      value.startsWith("//") ||
      value.startsWith("/*") ||
      (hashComments && value.startsWith("#"))
        ? "comment"
        : /^["'`]/.test(value)
          ? "string"
          : /^\d/.test(value)
            ? "number"
            : keywords.has(value)
              ? "keyword"
              : "plain";
    const previous = result.at(-1);
    if (previous?.kind === kind) previous.text += value;
    else result.push({ text: value, kind });
    end = match.index + value.length;
  }
  if (end < text.length) result.push({ text: text.slice(end), kind: "plain" });
  return result;
}
