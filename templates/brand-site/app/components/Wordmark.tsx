// The {{name}} wordmark. /brand create replaces this text wordmark with the project's own
// logo SVG when the project has one, and records where it came from on the Governance page.
export function Wordmark() {
  return (
    <svg className="brand-wordmark" viewBox="0 0 {{wordmarkWidth}} 80" role="img" aria-label="{{name}}">
      <text className="brand-ink" x="0" y="62" fontFamily="var(--font-sans)" fontWeight="600" fontSize="64">{{name}}</text>
    </svg>
  );
}

/** The full lock-up: the mark beside the wordmark. */
export function BrandLockup() {
  return (
    <span className="brand">
      <span className="brand-symbol">
        <img src="/ds/assets/mark.svg" alt="" />
      </span>
      <Wordmark />
    </span>
  );
}
