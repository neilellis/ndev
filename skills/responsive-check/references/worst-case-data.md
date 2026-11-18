# Worst-case data

Demo data makes a design look good: names on one line, small counts, every optional field filled. Real data does not. Render each component that shows user data with a worst-case fixture too, and run the matrix on it.

## Rules

- Use plausible values or the real limit: a value that a real user can make, or the longest value that the schema, the database column or the API accepts. Random strings (`aaaa…`) prove nothing. No limit at all is a finding.
- Find the limits in the validation schema (Zod, Valibot), the migrations, the API types and the form `maxLength`. Test with the column limit, not the form limit, because an import or the API can send a longer value.
- Change the data, not the component. Put the fixture where the demo data comes from: the fixture file, the mock, the props or the API stub. Never edit markup or CSS to make a defect.
- Put the failures in the first rows, which are on screen: row 1 has the long name, row 2 the long email, row 3 the one-letter name.
- Test the states that one dataset cannot show: **empty** (0 items), **one** (1 item, each count at 1) and **huge** (the real upper bound, 1,000 rows or more when the list has no pages).
- Select the fixture with a switch that works only in development (for example `?data=worst`, read where the fixture is chosen). It never ships.
- Use `example.com` or `.test` domains in emails and URLs.
- Keep the fixture after the fix as the regression test for the component, and check the demo data again.

## Values to try

| Field | Values |
|---|---|
| Names | `Aleksandra Wiśniewska-Kowalczyk`, `Christopher Alexander Montgomery III`, `J`, `Đặng Thị Ngọc Hân`, `王秀英`, `نور الهدى عبد الرحمن`, `👩🏽‍💻 Priya`, `  Sam   Lee `, no name |
| Unbreakable strings | `bartholomew.fitzgerald@northwind-industries-holdings.example.com`, a long URL with a query string, a UUID, `Q3 Board Deck — FINAL (revised) v12.pdf` |
| Labels from data | a long status badge, `Benachrichtigungseinstellungen`, a label 30 % longer in translation, 12 tags, a blank title, a newline in a one-line field, a 2,000-character paste, `<script>`, `&amp;` |
| Numbers | `0`, `1`, `1000000`, `12345678.9` as money, `-42.5`, `0.1 + 0.2`, `null`, `NaN`, a live value from `99` to `100`, the `de-DE` locale |
| Collections | 0, 1, exactly one page, one page plus 1, 1,000 or more, items with the same name |
| Time | now, 12 days ago, 3 years ago, a future date, `2025-12-31T23:30:00-08:00` (a different day in UTC) |
| Media | an avatar URL that returns 404, no avatar, a 4000 × 200 and a 200 × 4000 image, a dark logo in dark mode |
| States | loading, an API error, some optional fields empty, each enum value, no permission |

Then change the environment: the component's real container (a sidebar is not a full page), 320 px, text at 200 %, dark mode, and `dir="rtl"` when the product supports it.

## Failure signatures

| You see | Fix |
|---|---|
| An avatar, icon or trailing action squashed or pushed off the row | `flex-shrink: 0` on fixed-size items, `min-width: 0` on the text column ([checks.md](checks.md), Overflow) |
| An email or URL past the edge | `overflow-wrap: anywhere`, not `word-break: break-all`, which also breaks words that fit |
| A badge on two lines | `white-space: nowrap; flex-shrink: 0` on the badge; choose which item yields |
| An avatar adrift beside a name on three lines | `align-items: flex-start` where text can wrap |
| Wrong initials, or `�` for an emoji | Initials from grapheme clusters (`Intl.Segmenter`), first and last word without suffixes (Jr, III), an icon when there is no name |
| "1 members", `1284`, `0.30000000000000004`, `NaN` | `Intl.PluralRules`, `Intl.NumberFormat` in the user's locale, a null guard |
| Numbers change width as they update | `tabular-nums` |
| Punctuation on the wrong side of a right-to-left name | `dir="auto"` on user text |
| Diacritics clipped | No `overflow: hidden` on text with a tight `line-height` |
| 1,000 rows scroll slowly | Virtualise or add pages, and say which |

## Truncate, wrap or clamp

Choose for each field, not for the page:

- **Wrap** text that identifies the item (names, titles). Two lines is normal; four lines means the column is too narrow.
- **Truncate at the end** secondary text whose start carries the meaning (a role, a preview).
- **Keep the end visible** when items differ at the end (file names, paths, hashes).
- **Clamp** card previews to 2 or 3 lines, so the cards have the same height.
- **Never truncate** numbers, amounts, dates or values that the user compares.

For the CSS and for how to show the full text, read the `modern-web-guidance` guides `single-line-overflow` and `css-layout`. A truncate-or-wrap choice for a key field is a design decision: record it with the component.
