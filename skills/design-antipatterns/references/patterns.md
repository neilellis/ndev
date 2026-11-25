# Pattern catalogue

These are contextual warning signs drawn from Slopstrap's component demos and ZIP. The repairs are this skill's interpretation. They are not rules from the source.

## Visual treatment and hierarchy

| Signal | Why it can fail | Repair and useful exception |
| --- | --- | --- |
| Dark slate canvas, purple/cyan gradients, blurred orbs, and a grid backdrop appear together by default. | The same shell makes unrelated products look alike; decoration can obscure content. | Choose surfaces and accents from the brand and viewing context. Keep a dark theme or gradient when it serves the brief; remove layers that compete with reading. |
| Gradient type, an arbitrary italic serif word, marker underlines, and faint gray labels compete. | Emphasis follows a formula while supporting facts become hard to read. | Emphasize key facts through a consistent hierarchy. Check contrast over effects. Keep mixed fonts or drawn marks when they express the intended voice and remain readable. |
| Every heading has an emoji; tinted icon boxes and eyebrow pills repeat AI, release, or verification claims. | Repeated cues add noise and imply distinctions or authority they do not explain. | Keep icons that aid recognition and badges whose facts change a decision. Support claims; hide decorative icons from assistive technology. |
| Every section becomes a frosted card, with cards nested inside cards. | Repeated boxes flatten hierarchy and consume space. | Use whitespace, headings, dividers, or a list for related content. Keep cards for distinct objects or actions and nesting for a real parent/child relationship. |
| Three equal feature cards or an asymmetric bento grid replace a simple list or paragraph. | The geometry dictates content length and importance; reading order can become unclear. | Group by the user's task and information priority. Keep equal tiles for comparable items and bento layouts when size and order convey real hierarchy. |
| Thick left stripes cycle through unrelated colors on cards and alerts. | Color suggests categories or urgency that do not exist. | Use one quiet accent or a consistent meaning for each color. Preserve recognizable warning and error treatments with explicit labels. |
| Every button has a gradient, shimmer, glow, arrow, and sparkle. | All actions compete for attention; labels can become vague. | Give the primary action clear emphasis and a specific verb. Keep decorative button styling when it fits the brand and does not hide focus or state. |

## Truth, copy, and interaction

| Signal | Why it can fail | Repair and useful exception |
| --- | --- | --- |
| Blinking status dots and scroll counters report uptime, user totals, or growth without a source. | Animation and precision lend authority to unsupported claims. | Connect status to real state, including unavailable state. Give metrics a scope, period, and source, or omit them. Label static examples; do not make readers wait for final values. |
| An endless logo marquee implies customers or partners without evidence. | Familiar brands can imply a false relationship. | Show only supported relationships with accurate labels. A static group can be easier to scan; retain motion only when it helps and users can control it. |
| Glowing five-star quotes, generic executive names, and avatar initials act as ready-made proof. | Fabricated endorsements undermine trust. | Use approved quotes with accurate attribution, show real examples, or omit the section. Mark sample testimonials as fictional in demos. |
| Copy repeats broad future-of-work claims, stock triads, “not just” reveals, or industry buzzwords. | The reader cannot learn what happens, for whom, or under what constraints. | State a concrete capability, outcome, and relevant limit. Keep a rhetorical device when it says something specific; punctuation alone is not a defect. |
| Border beams, pointer spotlights, floating orbs, shimmer, sparkle trails, and animated underlines run together. | Motion competes with content and can distract or discomfort users. | Reserve motion for useful feedback or a deliberate brand moment. Remove idle effects that add no information and provide reduced motion behavior. |
| A terminal has decorative window controls; a prompt box streams canned output; a progress bar mimics real work. | Visual affordances suggest functionality or progress that does not exist. | Label simulations, show real output, and make actual controls work. Terminal styling is useful for readable code examples; decorative window dots need not act as controls. |
| A pricing layout promotes the middle tier by default, with a popularity badge and billing toggle. | A familiar sales pattern can hide the real comparison or imply unsupported popularity. | Make price, billing period, limits, and total cost clear. Keep tiers and toggles when they match real offers; justify the recommendation. |

## Check for automatic redesign damage

Slopstrap's `slopify()` applies the same treatment to headings, paragraphs, lists, sections, and buttons. It also appends status and social proof. The site's plumbing demo shows why this matters: a local service page can acquire a SaaS costume unrelated to booking a repair.

When repairing a page, verify that its specific offer, hours, location, contact options, and primary task remain prominent. Do not assume every site needs a hero pill, three features, statistics, logos, testimonials, and pricing. Add each section only when its content helps the intended reader.
