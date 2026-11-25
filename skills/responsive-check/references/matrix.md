# The matrix

A cell is one route at one viewport in one colour scheme. The default matrix is 7 viewports × 2 schemes for each route.

## Default viewports

| Name | Short | CSS size | Engine | Why it is in the matrix |
|---|---|---|---|---|
| iPhone SE | SE | 320 × 568 | WebKit | The narrowest phone in use. WCAG 1.4.10 reflow is measured at 320 CSS px. |
| iPhone 15 Pro | 15 Pro | 393 × 852 | WebKit | A typical current iPhone, with a notch and a home indicator. |
| Pixel 7 | Pixel | 412 × 915 | Chromium | A typical Android phone. |
| iPad Mini | iPad Mini | 768 × 1024 | WebKit | The narrowest tablet, portrait. Many layouts break at the first tablet breakpoint. |
| iPad Pro 11 landscape | iPad Pro | 1194 × 834 | WebKit | A wide tablet: desktop width, touch input, a short screen. |
| Laptop | Laptop | 1280 × 800 | Chromium | A small laptop. |
| Desktop | Desktop | 1920 × 1080 | Chromium | A wide desktop: check the maximum line length and empty space. |

Apple rows run in WebKit because only WebKit shows Safari's layout, font and `100vh` behaviour. If WebKit is not installed, run `--engine chromium` and say in the result that Safari was not checked.

## Colour schemes

Each viewport runs in `light` and `dark`. The context sets `prefers-color-scheme` and `prefers-reduced-motion: reduce`, so animations are at their end state in the screenshots.

The page has a dark design when it has a `prefers-color-scheme: dark` rule, a `color-scheme` meta that names dark, or a root `color-scheme` that names dark. When it has none, the report has a note. A site with a theme toggle that is stored in JavaScript only does not follow the scheme: check its toggle by hand, and record that in the result.

## Add widths

- `--widths 360,600,1024` adds Chromium rows at these widths (height 900), named `360px`, `600px` and `1024px`. `--only` removes them unless it names them.
- Add a row 1 px each side of each breakpoint in the project CSS (for example 767 and 768). Most breakpoint defects are at the edge.
- Add 600 for a large phone in landscape or a small foldable.
- For a quick run, use `--only "iPhone SE,iPad Mini,Laptop"`: the narrowest phone, the first tablet and one desktop.

## Routes

Choose routes that cover each layout, not each page: the home page, one page of each template, a long form, a table, the navigation open and closed, and an error page. A signed-in page needs a session; the script does not sign in.
