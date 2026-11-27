const TOKEN = /\/\/[^\n]*|#![^\n]*|\/\*[\s\S]*?\*\/|\/\*|"[^"]*"|"|[A-Za-z_]\w*|\S/g;

export function importSources(text) {
  if (/\r(?!\n)/.test(text)) return { problem: "it has a carriage return with no line feed after it" };
  const sources = [];
  let previous;
  for (const [token] of text.matchAll(TOKEN)) {
    if (token === "/*") return { problem: "a comment does not end" };
    if (token === "\"") return { problem: "a string does not end" };
    if (token.startsWith("//") || token.startsWith("/*") || token.startsWith("#!")) continue;
    if (previous === "from" && token.startsWith("\"")) sources.push(token.slice(1, -1));
    previous = token;
  }
  return { sources };
}
