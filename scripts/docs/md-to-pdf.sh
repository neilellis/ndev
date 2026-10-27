#!/usr/bin/env bash
# md-to-pdf.sh — render a markdown document (a plan, a review) to an A4 PDF.
#
#   md-to-pdf.sh <file.md> [out.pdf]
#   CHROME=/path/to/chrome md-to-pdf.sh <file.md>     # use a given Chrome or Chromium
#
# pandoc turns the markdown into HTML. The HTML is wrapped in a plain, neutral print
# style that uses system fonts (no network), and headless Chrome prints it. Refuses
# when pandoc or Chrome is missing. The first H1 becomes the masthead title.
#
# Exit: 0 = PDF written (path on stdout); 1 = Chrome ran but wrote no PDF; 2 = could not run.
set -euo pipefail

src="${1:?usage: md-to-pdf.sh <file.md> [out.pdf]}"
out="${2:-${src%.md}.pdf}"
chrome="${CHROME:-}"
if [[ -z "$chrome" ]]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           "$(command -v google-chrome 2>/dev/null)" "$(command -v chromium 2>/dev/null)" \
           "$(command -v chromium-browser 2>/dev/null)"; do
    [[ -n "$c" && -x "$c" ]] && { chrome="$c"; break; }
  done
fi
[[ -f "$src" ]] || { echo "md-to-pdf: no such file: $src" >&2; exit 2; }
command -v pandoc >/dev/null || { echo "md-to-pdf: pandoc is not installed. Fix: brew install pandoc" >&2; exit 2; }
[[ -n "$chrome" && -x "$chrome" ]] || { echo "md-to-pdf: no Chrome or Chromium found${chrome:+ at $chrome}. Fix: install Chrome, or set CHROME=/path/to/chrome" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pandoc "$src" -f gfm -t html5 --wrap=none -o "$work/body.html"
title="$(grep -m1 '^# ' "$src" | sed 's/^# //')"
python3 - "$work/body.html" "$work/page.html" "$title" <<'PY'
import re, sys, html
body = open(sys.argv[1]).read()
body = re.sub(r'<h1[^>]*>.*?</h1>\s*', '', body, count=1, flags=re.S)
body = body.replace('<table>', '<div class="tablewrap"><table>').replace('</table>', '</table></div>')
title = html.escape(sys.argv[3])
css = """
@page{size:A4;margin:18mm 16mm 20mm 16mm}
:root{--canvas:#fff;--sunken:#F2F2F0;--line:#E4E4E0;--line-strong:#CFCFCA;--heading:#161616;--strong:#262626;
--body:#3F3F3F;--muted:#666;--accent:#1F4F8F;
--serif:Georgia,"Times New Roman",serif;--sans:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;--mono:ui-monospace,Menlo,Consolas,monospace}
body{background:var(--canvas);color:var(--body);font-family:var(--sans);font-size:10.5pt;line-height:1.55;margin:0}
h1{font-family:var(--serif);font-weight:500;font-size:24pt;line-height:1.1;color:var(--heading);margin:0 0 .5rem}
h2{font-family:var(--serif);font-weight:500;font-size:15pt;color:var(--heading);margin:1.6rem 0 .6rem;break-after:avoid}
h3{font-family:var(--serif);font-weight:500;font-size:12pt;color:var(--heading);margin:1.3rem 0 .4rem;break-after:avoid}
p,ul,ol{max-width:46rem;margin:0 0 .8rem} li{margin-bottom:.3rem}
code{font-family:var(--mono);font-size:.84em;color:var(--strong);background:var(--sunken);padding:.05em .35em;border-radius:3px}
pre{background:var(--sunken);border:1px solid var(--line);padding:.8rem 1rem;font-family:var(--mono);font-size:8.2pt;line-height:1.45;white-space:pre-wrap;break-inside:avoid}
pre code{background:none;padding:0;font-size:inherit}
.tablewrap{border:1px solid var(--line-strong);margin:.8rem 0 1.2rem}
table{border-collapse:collapse;width:100%;font-size:8.6pt}
th{text-align:left;font-weight:600;font-size:7.5pt;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:var(--sunken);padding:.5rem .7rem;border-bottom:1px solid var(--line-strong)}
td{padding:.5rem .7rem;border-bottom:1px solid var(--line);vertical-align:top} tr:last-child td{border-bottom:0}
thead{display:table-header-group} tr{break-inside:avoid}
blockquote{margin:.8rem 0;padding:.2rem 0 .2rem 1rem;border-left:2px solid var(--line-strong);color:var(--strong);font-family:var(--serif)}
hr{border:0;border-top:1px solid var(--line-strong);margin:2rem 0}
a{color:var(--accent);text-decoration:none} strong{color:var(--strong);font-weight:600}
.masthead{border-bottom:1px solid var(--line-strong);padding-bottom:1rem;margin-bottom:1.5rem}
"""
doc = f"""<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>{title}</title>
<style>{css}</style></head><body><header class="masthead"><h1>{title}</h1></header>{body}</body></html>"""
open(sys.argv[2], 'w').write(doc)
PY
"$chrome" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=8000 \
  --print-to-pdf="$out" "file://$work/page.html" 2>/dev/null
[[ -s "$out" ]] || { echo "md-to-pdf: Chrome produced no PDF" >&2; exit 1; }
echo "$out"
