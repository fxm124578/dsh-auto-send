// Headless smoke test for @local/dsh-auto-send/client.js: evaluate the module
// factory, run apply() against a fake slot registry, then render both slot
// components with fake props and walk the produced element tree.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');

let factory = null;
const lsData = new Map();
global.window = {
  __ModuleLoader__: {
    load: function (mod) { factory = mod.factory; },
  },
  localStorage: {
    getItem: function (key) { return lsData.has(key) ? lsData.get(key) : null; },
    setItem: function (key, value) { lsData.set(key, String(value)); },
    removeItem: function (key) { lsData.delete(key); },
  },
};

// ---- minimal React: enough for createElement + hooks + class components ----
function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2);
  const flat = [];
  (function push(list) {
    for (const child of list) {
      if (Array.isArray(child)) push(child);
      else if (child !== null && child !== undefined && child !== false) flat.push(child);
    }
  })(children);
  return { type: type, props: Object.assign({}, props || {}, { children: flat }) };
}

let stateSlots = new Map();
let stateCursor = 0;
let stateKey = '';
let findCounter = 0;

class Component {
  constructor(props) { this.props = props; this.state = {}; }
  setState(next) { this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next); }
  render() { return null; }
}

const React = {
  createElement: createElement,
  Component: Component,
  Fragment: 'Fragment',
  useState: function (init) {
    const key = stateKey + '#' + (stateCursor++);
    if (!stateSlots.has(key)) stateSlots.set(key, typeof init === 'function' ? init() : init);
    return [stateSlots.get(key), function (next) { stateSlots.set(key, next); }];
  },
  useEffect: function () { /* effects are browser-only */ },
  useMemo: function (fn) { return fn(); },
  useRef: function (value) { return { current: value }; },
};

function requireStub(id) {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
}

new Function('window', 'require', source)(global.window, requireStub);
if (!factory) throw new Error('module factory was not registered');

const mod = factory(requireStub);
if (typeof mod.apply !== 'function') throw new Error('module has no apply()');

const registered = [];
const ctx = {
  remote: { $on: function () { return function () {}; } },
  on: function () { return function () {}; },
  slots: {
    inject: function (name, register) { registered.push({ name: name, register: register }); },
    register: function (options, Component_) { return { options: options, Component: Component_ }; },
  },
};
// The Host service proxy throws `cannot get property "remote" without inject`,
// so both names must be declared or every ctx.remote access dies at runtime.
for (const name of ['remote', 'remote.schedule']) {
  if ((mod.inject || []).indexOf(name) < 0) throw new Error('module must inject "' + name + '"');
}

mod.apply(ctx);

const bySlot = {};
for (const item of registered) {
  const cell = item.register();
  bySlot[item.name] = cell;
  if (!cell || typeof cell.Component !== 'function') throw new Error('slot ' + item.name + ' did not get a component');
}

// ---- render walk ----------------------------------------------------------
const problems = [];
// An empty draft must only surface the red error after a click; the gray
// always-on duplicate line was removed on purpose.
if (source.indexOf('先在下面写下要发送的内容') >= 0) problems.push('the gray empty-input hint is back');
// Editing the draft after arming must keep the pending task's prompt current.
if (source.indexOf('syncPrompt(sessionId, liveText)') < 0) problems.push('the draft-to-task text sync is gone');
// The wide dock card was replaced by a small popover above the clock button.
if (source.indexOf('conversation.input.dock') >= 0) problems.push('the wide dock slot is still registered');
// Hover-open must keep the button-to-card travel path; the bridge covers it.
if (source.indexOf('popBridge') < 0) problems.push('the hover bridge under the popover is gone');
if (source.indexOf('onMouseLeave') < 0) problems.push('the hover close handler is gone');
// Clicking the clock must pin the card; a second click puts it away.
if (source.indexOf('function pinPanel') < 0) problems.push('the click-to-pin mode is gone');
let nodes = 0;
const texts = [];

function walk(node, path) {
  if (node === null || node === undefined || node === false) return;
  nodes++;
  if (typeof node === 'string') {
    texts.push(path + ' :: ' + node);
    if (node === '' || node === 'undefined' || node === 'NaN') problems.push('bad text at ' + path + ': "' + node + '"');
    return;
  }
  if (typeof node === 'number') {
    if (!isFinite(node)) problems.push('bad number at ' + path + ': ' + node);
    return;
  }
  if (Array.isArray(node)) { node.forEach(function (child, i) { walk(child, path + '[' + i + ']'); }); return; }
  if (typeof node !== 'object') return;
  if (typeof node.type === 'function') {
    stateCursor = 0;
    stateKey = path;
    if (node.type.prototype instanceof Component) {
      const instance = new node.type(node.props || {});
      const out = instance.render();
      walk(out, path + '<' + (node.type.name || 'anon') + '>');
      return;
    }
    const out = node.type(Object.assign({}, node.props || {}, { children: undefined }));
    walk(out, path + '<' + (node.type.name || 'anon') + '>');
    return;
  }
  const props = node.props || {};
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'style') continue;
    const value = props[key];
    if (typeof value === 'function' || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') continue;
    if (value === undefined) problems.push('undefined prop ' + key + ' at ' + path);
  }
  const style = props.style;
  if (style) {
    if (typeof style !== 'object') problems.push('non-object style at ' + path);
    for (const key of Object.keys(style || {})) {
      const value = style[key];
      if (value === undefined || value === null || value === '' || (typeof value === 'number' && !isFinite(value))) {
        problems.push('bad style ' + key + '=' + value + ' at ' + path);
      }
      if (typeof value === 'string' && /undefined|NaN/.test(value)) problems.push('dirty style ' + key + '=' + value + ' at ' + path);
    }
  }
  if (process.env.DUMP === '1' && node.type === 'input') {
    console.log('INPUT ' + path + ' type=' + props.type + ' value=' + JSON.stringify(props.value) + ' aria=' + props['aria-label']);
  }
  for (const child of props.children || []) walk(child, path + '>');
}

const session = { id: 's1' };
const input = { draft: '帮我把这周的日报整理成三段', phase: 'plain' };
const baseProps = {
  session: session,
  sessionId: 's1',
  input: input,
  useInput: function (select) { return select(input); },
  inputActions: { setDraft: function () {}, submit: function () {} },
};

// 1. the compact button, with a draft present
const closedTree = bySlot['conversation.input.right'].Component(baseProps);
walk(closedTree, 'button');
if (findFirst(closedTree, function (node) { return node.props && node.props.role === 'dialog'; })) {
  problems.push('the popover renders before any press');
}
// 2. the wide dock card is gone: the popover now lives inside the clock slot
if (bySlot['conversation.input.dock']) problems.push('the dock card slot is back');

// click the clock: find it by calling the component's props.onClick through the tree
function clickFirst(node, predicate) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(function (child) { return clickFirst(child, predicate); });
  if (typeof node.type === 'function') {
    stateCursor = 0;
    if (node.type.prototype instanceof Component) {
      return clickFirst(new node.type(node.props || {}).render(), predicate);
    }
    return clickFirst(node.type(Object.assign({}, node.props || {}, { children: undefined })), predicate);
  }
  if (predicate(node)) { if (node.props && typeof node.props.onClick === 'function') { node.props.onClick({ stopPropagation: function () {}, currentTarget: { style: {} }, target: { style: {} } }); return true; } }
  for (const child of (node.props && node.props.children) || []) if (clickFirst(child, predicate)) return true;
  return false;
}

const buttonTree = bySlot['conversation.input.right'].Component(baseProps);
const clicked = clickFirst(buttonTree, function (node) { return node.type === 'button' && node.props && node.props['aria-label'] === '定时发送'; });

// 4. the popover, now open, still renders inside the clock slot
walk(bySlot['conversation.input.right'].Component(baseProps), 'pop-open');

// 4b. the five numbers: keyboard step, open drum, close drum
function findFirst(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findFirst(child, predicate); if (hit) return hit; }
    return null;
  }
  if (typeof node.type === 'function') {
    stateCursor = 0;
    stateKey = 'find#' + (findCounter++);
    if (node.type.prototype instanceof Component) return findFirst(new node.type(node.props || {}).render(), predicate);
    return findFirst(node.type(Object.assign({}, node.props || {}, { children: undefined })), predicate);
  }
  if (predicate(node)) return node;
  for (const child of (node.props && node.props.children) || []) {
    const hit = findFirst(child, predicate);
    if (hit) return hit;
  }
  return null;
}

// ---- helpers ---------------------------------------------------------------
// The popover is rendered by the clock button itself, so every helper below
// looks inside that slot's tree (the external dock slot no longer exists).
function renderDock() {
  return bySlot['conversation.input.right'].Component(baseProps);
}

function findInDock(predicate) {
  return findFirst(renderDock(), predicate);
}

function readFields() {
  const tree = renderDock();
  const day = findFirst(tree, function (node) {
    return node.type === 'select' && node.props && node.props['aria-label'] === '日期';
  });
  const time = findFirst(tree, function (node) {
    return node.type === 'input' && node.props && node.props['aria-label'] === '时间';
  });
  return { day: day ? day.props.value : null, time: time ? time.props.value : null };
}

function buttons() {
  const out = [];
  (function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node.type === 'function') {
      stateCursor = 0;
      stateKey = 'scan#' + (findCounter++);
      const rendered = node.type.prototype instanceof Component
        ? new node.type(node.props || {}).render()
        : node.type(Object.assign({}, node.props || {}, { children: undefined }));
      return collect(rendered);
    }
    if (node.type === 'button') out.push(node);
    (node.props && node.props.children || []).forEach(collect);
  })(renderDock());
  return out;
}

function textOf(node) {
  return String((node.props.children || []).map(function (child) {
    if (typeof child === 'string') return child;
    if (child && child.props) return String((child.props.children || []).join(''));
    return '';
  }).join('')).trim();
}

function quickButtons() {
  return buttons().filter(function (node) {
    const label = node.props['aria-label'];
    return typeof label === 'string' && label.indexOf('立刻排到 ') === 0;
  });
}

function linkButton() {
  return findInDock(function (node) {
    return node.type === 'button' && (textOf(node) === '自己定时' || textOf(node) === '收起');
  });
}

function primaryButton() {
  return findInDock(function (node) {
    return node.type === 'button' && textOf(node) === '定时发送';
  });
}

function timeInput() {
  return findInDock(function (node) {
    return node.type === 'input' && node.props && node.props['aria-label'] === '时间';
  });
}

function click(node) {
  node.props.onClick({ stopPropagation: function () {} });
}

function setTime(value) {
  const input = timeInput();
  if (!input) throw new Error('time input is not rendered');
  input.props.onChange({ target: { value: value } });
}

function setDay(value) {
  findInDock(function (node) {
    return node.type === 'select' && node.props && node.props['aria-label'] === '日期';
  }).props.onChange({ target: { value: value } });
}

function tick(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function clockButton() {
  return function (node) {
    return node.type === 'button' && node.props && node.props['aria-label'] === '定时发送';
  };
}

// ---- fake host remote so the panel can really schedule ---------------------
const created = [];
ctx.remote.schedule = {
  list: function () { return Promise.resolve({ ok: true, value: { items: created.slice() } }); },
  create: function (request) {
    const item = {
      id: 'task-1',
      title: request.title,
      prompt: request.prompt,
      timing: request.timing,
      scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      status: 'active',
      target: request.target,
      updatedAt: new Date().toISOString(),
    };
    created.push(item);
    return Promise.resolve({ ok: true, value: item });
  },
  edit: function (request) {
    if (request.action === 'delete') { created.length = 0; return Promise.resolve({ ok: true, value: { id: request.id, deleted: true } }); }
    created[0] = Object.assign({}, created[0], request.patch);
    return Promise.resolve({ ok: true, value: created[0] });
  },
};

(async function main() {
  // the card the click above opened: both cheap windows, the link, no form yet
  const openState = {
    buttons: buttons().map(textOf),
    quick: quickButtons().map(function (node) {
      return { label: node.props['aria-label'], text: textOf(node) };
    }),
    link: linkButton() ? textOf(linkButton()) : null,
    hasForm: !!timeInput(),
    hasDialog: !!findInDock(function (node) { return node.props && node.props.role === 'dialog'; }),
  };

  // the click near the top of this file already opened the popover, so these
  // numbers describe the open card; the closed state is checked by the walk.
  const opened = {
    quick: quickButtons().map(function (node) {
      return { label: node.props['aria-label'], text: textOf(node) };
    }),
    link: textOf(linkButton()),
    hasForm: !!timeInput(),
  };

  // a click pins the card; clicking the clock again puts it away
  clickFirst(bySlot['conversation.input.right'].Component(baseProps), clockButton());
  await tick(30);
  const cardClosedBySecondClick = !findInDock(function (node) { return node.props && node.props.role === 'dialog'; });
  // reopen it for the rest of the run
  clickFirst(bySlot['conversation.input.right'].Component(baseProps), clockButton());
  await tick(30);

  // pressing a cheap window schedules right away, no second step
  click(quickButtons()[0]);
  await tick(30);
  const afterQuick = created.map(function (item) { return { title: item.title, kind: item.timing && item.timing.kind }; });

  // the pill replaces the icon; pressing it reopens the popover
  clickFirst(bySlot['conversation.input.right'].Component(baseProps), clockButton());
  await tick(30);
  const reopened = { hasForm: !!timeInput(), link: textOf(linkButton()) };

  // theme dots: default follows the DSH theme, the third pins DeepSeek blue
  function cardStyle() {
    const card = findInDock(function (node) { return node.props && node.props.role === 'dialog'; });
    return card ? card.props.style : {};
  }
  const dotButtons = buttons().filter(function (node) {
    const label = node.props['aria-label'];
    return typeof label === 'string' && ['跟随主题', '暖橙', 'DeepSeek 蓝'].indexOf(label) >= 0;
  });
  const themeInfo = {
    dots: dotButtons.map(function (node) { return node.props['aria-label']; }),
    autoAccent: cardStyle()['--as-accent'] || null,
    width: cardStyle().width || null,
    position: cardStyle().position || null,
    stored: (function () { try { return window.localStorage.getItem('dsh-auto-send.theme.v1'); } catch (_) { return 'no-storage'; } })(),
  };
  click(dotButtons[2]);
  themeInfo.blueAccent = cardStyle()['--as-accent'] || null;
  themeInfo.blueInk = cardStyle()['--as-accent-ink'] || null;
  themeInfo.blueStored = (function () { try { return window.localStorage.getItem('dsh-auto-send.theme.v1'); } catch (_) { return 'no-storage'; } })();

  click(linkButton());
  const expanded = { hasForm: !!timeInput(), fields: readFields(), link: textOf(linkButton()) };

  // a nonsense clock disables the confirm button instead of scheduling
  setTime('99:99');
  const badDisabled = primaryButton().props.disabled;
  const badText = readFields().time;

  // a shorthand clock is accepted, and the day dropdown is independent
  setDay('2');
  setTime('930');
  const goodDisabled = primaryButton().props.disabled;
  click(primaryButton());
  await tick(30);
  const afterCustom = created.map(function (item) { return item.title; });

  // the Host's local-at selector only accepts HH:mm:ss, never a bare HH:mm
  created.forEach(function (item) {
    const timing = item.timing || {};
    const at = timing.at || {};
    if (timing.kind !== 'at' || !/^\d{2}:\d{2}:\d{2}$/.test(String(at.time))) {
      problems.push('timing.at.time must be HH:mm:ss, got ' + JSON.stringify(at.time));
    }
  });

  const summary = {
    file: path.basename(file),
    registered: registered.map(function (item) { return item.name; }),
    nodes: nodes,
    clickedClock: clicked,
    openState: openState,
    opened: opened,
    cardClosedBySecondClick: cardClosedBySecondClick,
    afterQuick: afterQuick,
    reopened: reopened,
    theme: themeInfo,
    expanded: expanded,
    badText: badText,
    badDisabled: badDisabled,
    goodDisabled: goodDisabled,
    afterCustom: afterCustom,
    problems: problems,
    state: Array.from(new Set(problems)).slice(0, 20),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.DUMP) console.log(texts.join('\n'));
  if (problems.length > 0) process.exitCode = 2;
  if (created.length === 0) { console.error('submit did not reach schedule.create'); process.exitCode = 3; }
})();
