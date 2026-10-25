/**
 * lib/client.js 的作用域回归测试。
 *
 * 这个文件是 classic script：**顶层任何 var/function 都会落到 window 上**，而同一个页面里
 * 还有别的插件的 classic script（`dsh-go-svc-widget` 就在顶层定义了 `el(tag, style, text)`）。
 * 两个同名工具函数互相覆盖，实测后果是对方插件的胶囊丢掉全部内联样式、从右下角消失。
 *
 * 所以这里用 node:vm 把 client.js 跑在一个空沙箱里，断言它**一个全局都不留**。
 * 只要有人把 IIFE 拆了、或者顺手在顶层加个 `var ICON_SIZE = 14`，这条测试就会红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');

const noop = () => {};

/** 假 window：classic script 里对 window.* 的调用都能接住。 */
function makeWindow(captured) {
  const win = {
    __ModuleLoader__: {
      load(module) {
        captured.push(module);
      },
    },
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout: () => 1,
    clearTimeout: noop,
    setInterval: () => 1,
    clearInterval: noop,
    requestAnimationFrame: () => 1,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    localStorage: { getItem: () => null, setItem: noop },
    location: { reload: noop },
  };
  win.window = win;
  return win;
}

/**
 * 在沙箱里执行 client.js。
 *
 * @param {object} [options]
 * @param {boolean} [options.withDom] 是否注入假 document（只有需要真的 apply 时才要）。
 * @returns {{ captured: object[], leaked: string[], factory: Function, sandbox: object }}
 */
function runInSandbox({ withDom = false, document: injectedDocument } = {}) {
  const captured = [];
  const win = makeWindow(captured);
  const sandbox = { window: win, console, setTimeout: win.setTimeout, clearTimeout: noop };
  const doc = withDom ? (injectedDocument ?? makeFakeDocument()) : undefined;
  if (doc !== undefined) sandbox.document = doc;
  vm.createContext(sandbox);
  const before = new Set(Object.keys(sandbox));
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });
  const leaked = Object.keys(sandbox).filter((key) => !before.has(key));
  const factory = captured.length > 0 ? captured[0].factory : undefined;
  return { captured, leaked, factory, sandbox, document: doc };
}

test('client.js 不在全局留下任何符号（IIFE 不能被拆）', () => {
  const { captured, leaked } = runInSandbox();
  assert.deepEqual(
    leaked,
    [],
    `client.js 把 ${leaked.join(', ')} 泄漏到了全局；这会和别的 classic script 插件（例如 `
    + 'dsh-go-svc-widget 的全局 el()）互相覆盖，导致对方 UI 消失。所有声明必须留在文件内的 IIFE 里。',
  );
  assert.equal(captured.length, 1, 'client.js 应当只注册一个模块');
});

test('注册的模块契约正确（id / factory / name / apply）', () => {
  const { captured } = runInSandbox();
  const module = captured[0];
  assert.equal(module.id, 'dsh-port-viewer', '模块 id 必须等于包名，插件加载器按它拼 /plugins/<pkg>/client.js');
  assert.equal(typeof module.factory, 'function');

  const exported = module.factory();
  assert.equal(exported.name, 'port-viewer', '客户端插件名与 cordis 行 id 对齐');
  assert.equal(typeof exported.apply, 'function');
});

test('apply 把副作用登记到 ctx.effect，并且渲染出来的是带 class 的胶囊', () => {
  const doc = makeFakeDocument();
  const { factory } = runInSandbox({ withDom: true, document: doc });
  const exported = factory();
  const effects = [];
  let disposer;
  const ctx = {
    effect(fn, label) {
      effects.push(label);
      // cordis 会拿走 effect 回调的返回值当 disposer；apply 本身不返回任何东西。
      disposer = fn();
      return disposer;
    },
  };

  exported.apply(ctx);
  assert.equal(effects.length, 1, 'apply 必须且只能登记一个 effect');
  assert.match(String(effects[0]), /dsh-port-viewer/, 'effect 要带可辨识的 label');

  // 真正的回归点：元素必须靠 class 拿样式。
  // 全局 el() 被别的插件覆盖时，这里会变成 <button style="pv-pill"> —— 胶囊失去全部定位。
  const root = doc.getElementById('dsh-port-viewer-root');
  assert.ok(root, '胶囊根节点应当挂到 document 上');
  const pill = root.children.find((child) => child.tagName === 'BUTTON');
  assert.ok(pill, '根节点里应当有胶囊按钮');
  assert.equal(pill.className, 'pv-pill', '胶囊必须带 pv-pill class（而不是把类名写进 style）');
  assert.equal(pill.style.pvPill, undefined);

  assert.equal(typeof disposer, 'function', 'effect 回调必须返回 disposer（HMR 卸载靠它清 DOM）');
  disposer();
  assert.equal(doc.getElementById('dsh-port-viewer-root'), null, 'dispose 之后根节点必须从文档里消失');
});

/** 极简假 document：够 client.js 挂载一次（创建元素、挂 head/body、按 id 查询）。 */
function makeFakeDocument() {
  const nodes = new Map();
  const makeNode = (tagName) => {
    const node = {
      tagName: String(tagName).toUpperCase(),
      className: '',
      id: '',
      hidden: false,
      style: { setProperty: noop },
      children: [],
      parentNode: null,
      textContent: '',
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        if (child.id) nodes.set(child.id, child);
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((entry) => entry !== child);
        child.parentNode = null;
        // 按 id 建的索引也要跟着失效，否则「dispose 后还能 getElementById 到」会骗过测试。
        if (child.id && nodes.get(child.id) === child) nodes.delete(child.id);
        return child;
      },
      setAttribute: noop,
      removeAttribute: noop,
      addEventListener: noop,
      removeEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
      focus: noop,
      contains: () => false,
      insertBefore: (child) => node.appendChild(child),
      replaceChildren: noop,
      closest: () => null,
    };
    return node;
  };
  const head = makeNode('head');
  const body = makeNode('body');
  return {
    head,
    body,
    documentElement: makeNode('html'),
    createElement: (tagName) => makeNode(tagName),
    createElementNS: (_ns, tagName) => makeNode(tagName),
    getElementById: (id) => nodes.get(id) ?? null,
    addEventListener: noop,
    removeEventListener: noop,
    execCommand: () => false,
  };
}
