import { parseTokens, type Token, type TokenKind } from "@/lib/tokens";
import { TOKENS_DIR } from "@/lib/ds";

function Sample({ token }: { token: Token }) {
  const v = `var(${token.name})`;
  switch (token.kind) {
    case "color":
      return <span className="tok-chip" style={{ background: v }} aria-hidden />;
    case "gradient":
      return <span className="tok-chip tok-chip-wide" style={{ background: v }} aria-hidden />;
    case "shadow":
      return <span className="tok-box" style={{ boxShadow: v }} aria-hidden />;
    case "radius":
      return <span className="tok-box" style={{ borderRadius: v }} aria-hidden />;
    case "spacing":
      return token.value.endsWith("px") ? <span className="tok-bar" style={{ width: `min(${v}, 120px)` }} aria-hidden /> : null;
    case "font":
      if (token.name.startsWith("--font-")) return <span className="tok-font" style={{ fontFamily: v }}>Ag</span>;
      return null;
    default:
      return null;
  }
}

export async function Tokens({ kind }: { kind?: TokenKind }) {
  const groups = await parseTokens(TOKENS_DIR);
  const shown = kind
    ? groups.map((g) => ({ ...g, tokens: g.tokens.filter((t) => t.kind === kind) })).filter((g) => g.tokens.length)
    : groups;

  return (
    <div className="tokens">
      {shown.map((g) => (
        <section key={g.file} className="tok-group">
          <h3 className="tok-group-h">{g.file}</h3>
          <div className="table-scroll">
            <table className="tok-table">
              <tbody>
                {g.tokens.map((t) => (
                  <tr key={t.name}>
                    <td className="tok-sample"><Sample token={t} /></td>
                    <td className="tok-name"><code>{t.name}</code></td>
                    <td className="tok-value"><code>{t.value}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
