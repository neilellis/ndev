# Context Menus

> Source: [skills/chrome-extensions/references/extensions/context-menus.md](https://github.com/GoogleChrome/modern-web-guidance/blob/4dd968349e54ca45a05dd5c818fb035c9054b022/skills/chrome-extensions/references/extensions/context-menus.md), Apache-2.0. Changed for ndev: cross-references point to the local copies.

## Setup

```json
{ "permissions": ["contextMenus"] }
```

## Creating Menus

Create in the service worker, typically in `onInstalled` (menus persist, but re-creating is idempotent):

```js
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-link',
    title: 'Save to Reading List',
    contexts: ['link']        // Only show on right-click of links
  });

  chrome.contextMenus.create({
    id: 'translate-selection',
    title: 'Translate "%s"',   // %s = selected text
    contexts: ['selection']
  });

  // M150+: Context menu for the tab strip (right-clicking a tab)
  chrome.contextMenus.create({
    id: 'duplicate-tab',
    title: 'Custom Duplicate Tab',
    contexts: ['tab']
  });
});
```

## Handling Clicks

```js
chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case 'save-link':
      saveLink(info.linkUrl, info.selectionText || info.linkUrl);
      break;
    case 'translate-selection':
      translateText(info.selectionText, tab.id);
      break;
    case 'duplicate-tab':
      chrome.tabs.duplicate(tab.id); // 'tab' parameter is the clicked tab
      break;
  }
});
```

## Context Types

`all`, `page`, `frame`, `selection`, `link`, `editable`, `image`, `video`, `audio`, `launcher`, `browser_action`, `action`, `tab` (M150+)

## Submenus

```js
chrome.contextMenus.create({ id: 'parent', title: 'My Extension', contexts: ['page'] });
chrome.contextMenus.create({ id: 'child1', parentId: 'parent', title: 'Option 1', contexts: ['page'] });
chrome.contextMenus.create({ id: 'child2', parentId: 'parent', title: 'Option 2', contexts: ['page'] });
```

## Dynamic Updates

```js
chrome.contextMenus.update('save-link', { title: 'New Title' });
chrome.contextMenus.remove('save-link');
chrome.contextMenus.removeAll();
```
