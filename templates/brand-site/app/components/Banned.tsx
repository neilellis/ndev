import rules from "@/public/ds/copy/banned.json";

type Word = (typeof rules.words)[number];

const LEVEL = { ban: "Banned", flag: "Check" } as const;

/** Every banned or flagged word, grouped, from public/ds/copy/banned.json. */
export function BannedWords() {
  return (
    <>
      {rules.groups.map((group) => {
        const words = rules.words.filter((w: Word) => w.group === group.id);
        return (
          <section key={group.id} className="banned-group">
            <h3 id={`group-${group.id}`}>{group.label}</h3>
            <p>{group.why}</p>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Word or phrase</th><th>Level</th><th>Instead</th><th>Source</th></tr></thead>
                <tbody>
                  {words.map((w: Word) => (
                    <tr key={w.term}>
                      <td>{w.term}</td>
                      <td className={`banned-level banned-${w.level}`}>{LEVEL[w.level as keyof typeof LEVEL]}</td>
                      <td>{w.instead}{"allow" in w ? <span className="banned-auto"> Allowed in technical documentation.</span> : null}</td>
                      <td className="banned-source">{w.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

/** Sentence patterns to avoid, with an example and a fix. */
export function BannedConstructions() {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Pattern</th><th>Example</th><th>Write instead</th></tr></thead>
        <tbody>
          {rules.constructions.map((c) => (
            <tr key={c.id}>
              <td>{c.name}{"pattern" in c ? <span className="banned-auto"> Checked automatically.</span> : null}</td>
              <td>{c.example}</td>
              <td>{c.fix}{"note" in c && c.note ? <><br /><em className="banned-note">{c.note}</em></> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The sources the list draws on. */
export function BannedSources() {
  return (
    <dl className="banned-sources">
      {Object.entries(rules.sources).map(([id, text]) => (
        <div key={id}><dt>{id}</dt><dd>{text}</dd></div>
      ))}
    </dl>
  );
}

export const bannedCounts = {
  ban: rules.words.filter((w: Word) => w.level === "ban").length,
  flag: rules.words.filter((w: Word) => w.level === "flag").length,
  constructions: rules.constructions.length,
};
