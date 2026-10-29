#!/usr/bin/env bash
# Turn a Playwright browser video into a docs GIF.
# A reader's thinking time between actions records as minutes of still screen, so every
# still stretch is capped at --hold seconds (default 2.5, so the reader's deliberate pauses stay); motion plays at its own speed.
# usage: video-to-gif.sh <in.webm> <out.gif> [--hold 2.5] [--fps 12] [--width 1028]
set -euo pipefail

usage() { echo "usage: video-to-gif.sh <in.webm> <out.gif> [--hold seconds, default 2.5] [--fps n] [--width px]" >&2; exit 2; }
[ $# -ge 2 ] || usage
in=$1 out=$2; shift 2
hold=2.5 fps=12 width=
while [ $# -gt 0 ]; do
  case $1 in
    --hold) hold=$2; shift 2 ;;
    --fps) fps=$2; shift 2 ;;
    --width) width=$2; shift 2 ;;
    *) usage ;;
  esac
done
command -v ffmpeg >/dev/null || { echo "video-to-gif: ffmpeg is not installed; install it with: brew install ffmpeg" >&2; exit 1; }
[ -s "$in" ] || { echo "video-to-gif: no video at $in" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
scale=${width:+,scale=$width:-1:flags=lanczos}

# Find the frames that change, on a quarter-size copy so a blinking text caret does not count
# as a change; then take those frames at full size, with their original times.
if ! ffmpeg -v info -nostdin -i "$in" -vf "fps=$fps,scale=iw/4:-1,mpdecimate,showinfo" -f null - \
    2>"$work/detect.log"; then
  echo "video-to-gif: ffmpeg could not read frames from $in:" >&2
  tail -5 "$work/detect.log" >&2
  exit 1
fi
grep -o 'pts_time:[0-9.]*' "$work/detect.log" | cut -d: -f2 >"$work/times"
[ -s "$work/times" ] || { echo "video-to-gif: no frames came out of $in; see $work/detect.log" >&2; exit 1; }
# ffmpeg cannot parse a select expression of more than about 100 terms, so the frames are
# taken in chunks of 50, each chunk numbered on from the last.
split -l 50 "$work/times" "$work/chunk."
start=1
for chunk in "$work"/chunk.*; do
  awk -v fps="$fps" 'BEGIN { printf "fps=%s,select=\x27", fps }
    { printf "%seq(n\\,%d)", (NR > 1 ? "+" : ""), int($1 * fps + 0.5) }
    END { printf "\x27%s\n", "'"$scale"'" }' "$chunk" >"$work/select.txt"
  if ! ffmpeg -v error -nostdin -i "$in" -/vf "$work/select.txt" -fps_mode vfr \
      -start_number "$start" "$work/%06d.png" 2>"$work/frames.log"; then
    echo "video-to-gif: ffmpeg could not extract the changed frames ($(basename "$chunk")) from $in:" >&2
    tail -5 "$work/frames.log" >&2
    exit 1
  fi
  start=$((start + $(wc -l <"$chunk")))
done
shopt -s nullglob
frames=("$work"/*.png)
kept=${#frames[@]}
[ "$kept" -eq "$(wc -l <"$work/times")" ] || {
  echo "video-to-gif: extracted $kept frames but detected $(wc -l <"$work/times") changes in $in" >&2; exit 1; }

# Each frame shows until the next one, never longer than the hold; the last holds twice as long.
printf '%s\n' "${frames[@]##*/}" | paste - "$work/times" | awk -v hold="$hold" -v dir="$work" '
  { f[NR] = $1; t[NR] = $2 }
  END {
    print "ffconcat version 1.0"
    for (i = 1; i <= NR; i++) {
      d = (i < NR) ? t[i + 1] - t[i] : 2 * hold
      if (d > hold) d = hold
      printf "file %s/%s\nduration %.3f\n", dir, f[i], d
    }
    printf "file %s/%s\n", dir, f[NR]
  }' >"$work/list.txt"

if ! ffmpeg -v error -nostdin -y -f concat -safe 0 -i "$work/list.txt" \
    -vf "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -fps_mode vfr -loop 0 "$out" 2>"$work/gif.log"; then
  echo "video-to-gif: ffmpeg could not write $out:" >&2
  tail -5 "$work/gif.log" >&2
  exit 1
fi
seconds=$(awk '/^duration/ { s += $2 } END { printf "%.1f", s }' "$work/list.txt")
echo "video-to-gif: $out, $kept frames, ${seconds}s (still stretches capped at ${hold}s)"
