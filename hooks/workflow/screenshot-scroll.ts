export const INNER_SCROLL_PROBE = String.raw`(() => {
  let largest = null;
  let area = 0;
  for (const element of document.querySelectorAll('*')) {
    if (element === document.scrollingElement || element === document.documentElement) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || !['auto', 'scroll', 'overlay'].includes(style.overflowY) || element.clientHeight <= 0 || element.scrollHeight <= element.clientHeight + 1) continue;
    const box = element.getBoundingClientRect();
    let left = Math.max(box.left, 0);
    let right = Math.min(box.right, innerWidth);
    let top = Math.max(box.top, 0);
    let bottom = Math.min(box.bottom, innerHeight);
    let visible = true;
    for (let parent = element; parent; parent = parent.parentElement) {
      const ancestor = getComputedStyle(parent);
      if (ancestor.display === 'none' || Number(ancestor.opacity) === 0 || ancestor.contentVisibility === 'hidden') { visible = false; break; }
      if (parent === element) continue;
      const clip = parent.getBoundingClientRect();
      if (ancestor.overflowX !== 'visible') { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      if (ancestor.overflowY !== 'visible') { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
    }
    if (!visible) continue;
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    if (width * height <= area) continue;
    area = width * height;
    largest = { element: (element.tagName.toLowerCase() + (element.id ? '#' + element.id : '')).replace(/\s+/g, ' ').slice(0, 120), height: element.clientHeight, total: element.scrollHeight };
  }
  return JSON.stringify(largest);
})()`
