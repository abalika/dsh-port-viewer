#!/usr/bin/env node
/**
 * dsh-port-viewer —— 隔离实例 E2E 驱动
 *
 * 由 scripts/verify-isolated.ps1 调用：实例已经起好、token URL 已经抓到，
 * 本脚本负责「用 token URL 当浏览器」做完所有断言并截图。分三档：
 *
 *   --phase smoke  阶段 A：只证明 harness —— token 换 cookie、页面加载、
 *                  插件出现在 boot 图里、client 组合包可访问、插件自带 HTTP
 *                  路由可达（空壳插件返回 stub）。不要求真实快照/kill/截图。
 *   --phase api    阶段 B 无 UI 部分：快照结构、保护端口、牺牲监听器 + kill。
 *   --phase ui     只跑无头 Edge（CDP）：明暗两张面板截图 + 胶囊截图（调试用）。
 *   --phase full   阶段 B 全部：api 全部 + 无头 Edge（CDP）明暗两张面板截图
 *                  + 胶囊截图。
 *
 * 约定：本脚本只碰自己起的东西（牺牲监听器 45678、无头 Edge、临时
 * user-data-dir），绝不 kill 任何真实服务端口；唯一一次带 pid 的 kill 请求
 * 目标是本脚本自己 spawn 的 node 子进程。
 *
 * 退出码：0 全绿；1 有失败断言（报告仍会写出）。
 *
 * 用法（一般由 verify-isolated.ps1 调用）：
 *   node test/e2e/e2e.mjs --base-url "http://127.0.0.1:3099/?token=..." \
 *     --port 3099 --phase full --repo-root . --shots test/e2e/shots \
 *     --report test/e2e/report.json
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

//#region 参数
/** 牺牲监听器端口（固定，便于残留检查；不与任何真实服务冲突）。 */
const SACRIFICE_PORT = 45678;
/** 面板/胶囊截图的目标窗口尺寸。 */
const VIEWPORT = { width: 1440, height: 900 };
/** 等待文档/元素的默认上限。 */
const WAIT_MS = { boot: 45000, snapshot: 20000, dialog: 20000, port: 15000, settle: 1200 };

function parseArgs(argv) {
  const options = {
    phase: 'full',
    port: 3099,
    repoRoot: process.cwd(),
    shots: 'test/e2e/shots',
    report: 'test/e2e/report.json',
    edge: '',
    baseUrl: '',
    /** 阶段 A 的空壳插件没有鉴权注水逻辑，相关断言降级为 warning。 */
    shellPlugin: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`missing value for ${flag}`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--base-url': options.baseUrl = value(); break;
      case '--port': options.port = Number(value()); break;
      case '--phase': options.phase = value(); break;      case '--repo-root': options.repoRoot = value(); break;
      case '--shots': options.shots = value(); break;
      case '--report': options.report = value(); break;
      case '--edge': options.edge = value(); break;
      case '--shell-plugin': options.shellPlugin = true; break;
      case '-h': case '--help':
        console.log('usage: node e2e.mjs --base-url <token url> --port <n> --phase smoke|api|ui|full [--repo-root <dir>] [--shots <dir>] [--report <file>] [--edge <exe>] [--shell-plugin]');
        process.exit(0);
        break;
      default: throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!options.baseUrl) throw new Error('--base-url is required (the token URL printed by the isolated dsh web instance)');
  if (!['smoke', 'api', 'ui', 'full'].includes(options.phase)) throw new Error(`--phase must be smoke|api|ui|full, got ${options.phase}`);
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) throw new Error(`invalid --port ${options.port}`);
  options.repoRoot = resolve(options.repoRoot);
  options.shots = resolve(options.shots);
  options.report = resolve(options.report);
  return options;
}
//#endregion

//#region 断言语境
/** 一次运行的结果收集器：失败不抛，全部聚合后统一退出码/报告。 */
class Run {
  constructor(options) {
    this.options = options;
    this.checks = [];
    this.warnings = [];
    this.shots = [];
    this.info = {};
    this.errors = [];
    this.startedAt = Date.now();
  }

  /**
   * 记录一条断言。
   * @param name - 断言名（英文，报告用）。
   * @param ok - 是否通过。
   * @param detail - 通过/失败的可诊断细节。
   * @returns ok，便于调用方决定是否继续依赖该结果。
   */
  check(name, ok, detail) {
    const entry = { name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) };
    this.checks.push(entry);
    if (!ok) this.errors.push(`${name}: ${entry.detail}`);
    return entry.ok;
  }

  /** 非致命问题。 */
  warn(message) {
    this.warnings.push(String(message));
  }

  get failed() {
    return this.checks.filter((c) => !c.ok);
  }
}
//#endregion

//#region HTTP（cookie 会话）
/** 一小段可诊断的响应体摘要。 */
function snippet(text, max = 300) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/gu, ' ').slice(0, max);
}

/**
 * 用 token URL 换一个浏览器会话 cookie（dsh 的 index 认证：303 + Set-Cookie），
 * 之后所有带认证的请求都复用它。
 */
class BrowserSession {
  constructor(tokenUrl) {
    this.tokenUrl = tokenUrl;
    this.url = new URL(tokenUrl);
    this.origin = this.url.origin;
    this.cookie = '';
    this.minted = null;
  }

  /** 触发 303 + Set-Cookie；返回 {status, cookieCount, cookies}。 */
  async mint() {
    const response = await fetch(this.tokenUrl, { redirect: 'manual', cache: 'no-store' });
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    this.cookie = setCookies.map((raw) => raw.split(';')[0].trim()).filter((pair) => pair.includes('=')).join('; ');
    let body = '';
    try { body = await response.text(); } catch { /* body is only for diagnostics */ }
    this.minted = { status: response.status, cookieCount: setCookies.length, body: snippet(body) };
    return this.minted;
  }

  /**
   * 带会话 cookie 的 fetch（插件路由复用 dsh 自己的会话鉴权）。
   * @param path - 以 / 开头的路径或完整 URL。
   * @param init - 额外 fetch 选项。
   */
  async request(path, init = {}) {
    const target = path.startsWith('http') ? path : `${this.origin}${path}`;
    const headers = { ...(init.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    return fetch(target, { ...init, headers, cache: 'no-store' });
  }

  /** GET 并解析 JSON（非 JSON 时返回 {__parseError}）。 */
  async getJson(path) {
    const response = await this.request(path);
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, text, json, headers: response.headers };
  }
}
//#endregion

//#region 端口工具
/** TCP 连接探测：端口在监听返回 true。 */
function probePort(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((done) => {
    const socket = connect({ port, host });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 取一个空闲端口（让 OS 分配后立刻释放），用于 Edge 调试端口。 */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** 轮询直到 predicate 为真或超时；返回最后一次结果。 */
async function waitFor(predicate, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}
//#endregion

//#region 快照结构校验
const PORT_KINDS = new Set(['dev-server', 'python', 'java', 'dotnet', 'database', 'docker', 'app', 'system', 'unknown']);
const PROJECT_SOURCES = new Set(['cwd', 'commandLine', 'parent', 'workspace', 'none', 'commandline', 'workspace-table']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 校验一份快照视图（CONTRACT §5.4）。返回结构错误数组：空数组 = 合法。
 * 只校验「结构/类型/契约硬规则」，不校验推断质量（那是真实样本断言的事）。
 */
function validateSnapshot(view) {
  const problems = [];
  const bad = (path, expected, actual) => problems.push(`${path}: expected ${expected}, got ${actual === undefined ? 'undefined' : JSON.stringify(actual)}`);

  if (!isObject(view)) return ['snapshot: expected a JSON object'];
  if (view.ok !== true) bad('ok', 'true', view.ok);
  if (view.schemaVersion !== 1) bad('schemaVersion', '1', view.schemaVersion);
  if (typeof view.generatedAt !== 'string' || Number.isNaN(Date.parse(view.generatedAt))) bad('generatedAt', 'ISO date string', view.generatedAt);
  if (typeof view.durationMs !== 'number' || view.durationMs < 0) bad('durationMs', 'non-negative number', view.durationMs);
  if (!Array.isArray(view.warnings)) bad('warnings', 'array', view.warnings);
  if (!Array.isArray(view.ports)) { bad('ports', 'array', view.ports); return problems; }
  if (!Array.isArray(view.projects)) bad('projects', 'array', view.projects);
  if (!isObject(view.stats)) bad('stats', 'object', view.stats);

  for (let index = 0; index < view.ports.length; index += 1) {
    const port = view.ports[index];
    const at = `ports[${index}]`;
    if (!isObject(port)) { bad(at, 'object', port); continue; }
    if (!isInt(port.port) || port.port < 1 || port.port > 65535) bad(`${at}.port`, 'integer 1..65535', port.port);
    if (typeof port.protocol !== 'string' || port.protocol.length === 0) bad(`${at}.protocol`, 'non-empty string', port.protocol);
    if (!Array.isArray(port.bindings)) bad(`${at}.bindings`, 'array', port.bindings);
    if (!isInt(port.pid) || port.pid <= 0) bad(`${at}.pid`, 'positive integer', port.pid);
    if (typeof port.processName !== 'string') bad(`${at}.processName`, 'string', port.processName);
    if (typeof port.commandLine !== 'string' && port.commandLine !== null) bad(`${at}.commandLine`, 'string|null', port.commandLine);
    if (typeof port.cwd !== 'string' && port.cwd !== null) bad(`${at}.cwd`, 'string|null', port.cwd);
    if (typeof port.startedAt !== 'string' && port.startedAt !== null) bad(`${at}.startedAt`, 'string|null', port.startedAt);
    if (typeof port.uptimeMs !== 'number' && port.uptimeMs !== null) bad(`${at}.uptimeMs`, 'number|null', port.uptimeMs);
    if (typeof port.url !== 'string' && port.url !== null) bad(`${at}.url`, 'string|null', port.url);
    if (typeof port.kind !== 'string' || !PORT_KINDS.has(port.kind)) bad(`${at}.kind`, `one of ${[...PORT_KINDS].join('|')}`, port.kind);
    if (typeof port.killable !== 'boolean') bad(`${at}.killable`, 'boolean', port.killable);
    if (typeof port.protectedReason !== 'string' && port.protectedReason !== null) bad(`${at}.protectedReason`, 'string|null', port.protectedReason);
    if (!isObject(port.flags)) { bad(`${at}.flags`, 'object', port.flags); continue; }
    for (const key of ['orphan', 'system', 'protected', 'wildcard', 'loopbackOnly']) {
      if (typeof port.flags[key] !== 'boolean') bad(`${at}.flags.${key}`, 'boolean', port.flags[key]);
    }
    if (port.flags.protected === true && port.killable !== false) bad(`${at}.killable`, 'false for a protected port', port.killable);
    if (!isObject(port.project)) { bad(`${at}.project`, 'object', port.project); continue; }
    if (typeof port.project.key !== 'string' || port.project.key.length === 0) bad(`${at}.project.key`, 'non-empty string', port.project.key);
    if (typeof port.project.name !== 'string') bad(`${at}.project.name`, 'string', port.project.name);
    if (typeof port.project.root !== 'string' && port.project.root !== null) bad(`${at}.project.root`, 'string|null', port.project.root);
    if (typeof port.project.source !== 'string') bad(`${at}.project.source`, 'string', port.project.source);
  }

  if (Array.isArray(view.projects)) {
    for (let index = 0; index < view.projects.length; index += 1) {
      const group = view.projects[index];
      const at = `projects[${index}]`;
      if (!isObject(group)) { bad(at, 'object', group); continue; }
      if (typeof group.key !== 'string' || group.key.length === 0) bad(`${at}.key`, 'non-empty string', group.key);
      if (typeof group.name !== 'string') bad(`${at}.name`, 'string', group.name);
      if (typeof group.root !== 'string' && group.root !== null) bad(`${at}.root`, 'string|null', group.root);
      if (typeof group.source !== 'string') bad(`${at}.source`, 'string', group.source);
      if (!isInt(group.portCount)) bad(`${at}.portCount`, 'integer', group.portCount);
      if (!Array.isArray(group.ports)) bad(`${at}.ports`, 'array', group.ports);
      if (!isInt(group.killableCount)) bad(`${at}.killableCount`, 'integer', group.killableCount);
    }
  }

  if (isObject(view.stats)) {
    for (const key of ['portCount', 'projectCount', 'orphanCount', 'protectedCount']) {
      if (!isInt(view.stats[key])) bad(`stats.${key}`, 'integer', view.stats[key]);
    }
  }
  return problems;
}
//#endregion

//#region CDP（无头 Edge 驱动）
/** 最小 CDP 客户端：Node 自带 WebSocket，不引入任何依赖。 */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: done, reject: fail } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) fail(new Error(`CDP ${message.error.code}: ${message.error.message}`));
        else done(message.result);
        return;
      }
      if (typeof message.method === 'string') {
        for (const handler of this.listeners.get(message.method) ?? []) {
          try { handler(message.params); } catch { /* listener errors must not break the driver */ }
        }
      }
    };
    socket.onclose = () => {
      this.closed = true;
      for (const { reject: fail } of this.pending.values()) fail(new Error('CDP socket closed'));
      this.pending.clear();
    };
  }

  /** 连接一个 webSocketDebuggerUrl。 */
  static connect(url) {
    return new Promise((done, fail) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => fail(new Error(`CDP websocket connect timed out: ${url}`)), 15000);
      socket.onopen = () => {
        clearTimeout(timer);
        done(new Cdp(socket));
      };
      socket.onerror = () => {
        clearTimeout(timer);
        fail(new Error(`CDP websocket error: ${url}`));
      };
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP closed before ${method}`));
    const id = (this.nextId += 1);
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  /** Runtime.evaluate 的薄封装：返回值本身，异常即抛。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed';
      throw new Error(`evaluate failed: ${snippet(detail)}`);
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

/** 在常见安装位置找无头 Edge/Chrome。 */
function findBrowser(preferred) {
  const candidates = [
    preferred,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return '';
}

/**
 * 打开无头浏览器、截图明暗两张面板 + 一张胶囊。
 * @returns {{ shots: string[], warnings: string[], failures: string[] }}
 */
async function captureShots(run, session) {
  const result = { shots: [], warnings: [], failures: [] };
  const browser = findBrowser(run.options.edge);
  if (!browser) {
    result.failures.push('no Edge/Chrome executable found for screenshots; pass --edge <exe>');
    return result;
  }
  const shotsDir = run.options.shots;
  mkdirSync(shotsDir, { recursive: true });
  const debugPort = await freePort();
  const userDataDir = join(tmpdir(), `dsh-port-viewer-e2e-${Date.now()}-${process.pid}`);
  const browserLog = join(tmpdir(), `dsh-port-viewer-e2e-browser-${process.pid}.log`);
  const browserProc = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  browserProc.stderr.setEncoding('utf8');
  browserProc.stderr.on('data', () => { /* drained below only for diagnostics on failure */ });

  let cdp;
  const consoleErrors = [];
  try {
    const version = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { cache: 'no-store' });
        if (!response.ok) return false;
        return await response.json();
      } catch { return false; }
    }, 20000, 400);
    if (!version) throw new Error(`headless browser DevTools endpoint never came up on 127.0.0.1:${debugPort} (${browser})`);

    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { cache: 'no-store' })).json();
    const page = targets.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string');
    if (!page) throw new Error(`no page target exposed by headless browser; targets: ${JSON.stringify(targets.map((t) => t.type))}`);
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);

    cdp.on('Runtime.exceptionThrown', (params) => {
      const detail = params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? 'unknown exception';
      consoleErrors.push(snippet(detail, 400));
    });
    cdp.on('Log.entryAdded', (params) => {
      if (params?.entry?.level === 'error') consoleErrors.push(snippet(`${params.entry.source}: ${params.entry.text}`, 400));
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    /** 导航到页面并等到插件根节点出现。 */
    const navigateAndWaitForRoot = async (label) => {
      await cdp.send('Page.navigate', { url: session.tokenUrl });
      const appeared = await waitFor(async () => {
        try { return await cdp.evaluate('!!document.getElementById("dsh-port-viewer-root")'); } catch { return false; }
      }, WAIT_MS.boot, 400);
      if (!appeared) {
        let text = '';
        try { text = await cdp.evaluate('(document.body && document.body.innerText || "").slice(0, 600)'); } catch { /* ignore */ }
        throw new Error(`${label}: #dsh-port-viewer-root never appeared in the page (body text: ${snippet(text, 400)})`);
      }
      try {
        await cdp.evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');
      } catch { /* fonts are cosmetic */ }
      await new Promise((done) => setTimeout(done, 800));
    };

    /** 找到胶囊元素并返回其几何信息（胶囊 = 小面积的 fixed 元素，避免误点整块抽屉）。 */
    const findCapsule = async () => {
      const rect = await cdp.evaluate(`(() => {
        const root = document.getElementById('dsh-port-viewer-root');
        if (!root) return null;
        const nodes = Array.from(root.querySelectorAll('*'));
        const fixed = nodes.filter((el) => getComputedStyle(el).position === 'fixed');
        const viewportArea = window.innerWidth * window.innerHeight;
        const small = fixed.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.width * r.height < viewportArea * 0.12;
        });
        const pill = small.find((el) => /端口|port/i.test(el.textContent || '')) || small[0] || fixed[0] || root;
        const r = pill.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, text: (pill.textContent || '').slice(0, 80) };
      })()`);
      return rect;
    };

    /** 抽屉是否真的可见（同名的 hidden 容器不算）。 */
    const drawerVisible = async () => {
      try {
        return await cdp.evaluate(`(() => {
          const root = document.getElementById('dsh-port-viewer-root');
          const dialog = root && root.querySelector('[role="dialog"]');
          if (!dialog) return false;
          const rect = dialog.getBoundingClientRect();
          return !dialog.hidden && rect.width > 0 && rect.height > 0 && getComputedStyle(dialog).display !== 'none';
        })()`);
      } catch {
        return false;
      }
    };

    /** 命中测试：插件根（position:fixed;inset:0）绝不能吞掉 dsh 界面的点击。 */
    const probeLayering = async () => cdp.evaluate(`(() => {
      const root = document.getElementById('dsh-port-viewer-root');
      if (!root) return null;
      const outside = document.elementFromPoint(300, 400);
      const inside = document.elementFromPoint(Math.max(0, window.innerWidth - 120), 400);
      const dialog = root.querySelector('[role="dialog"]');
      return {
        pointerEvents: getComputedStyle(root).pointerEvents,
        outsideIsPlugin: Boolean(outside && root.contains(outside)),
        outsideTag: outside ? outside.tagName : null,
        insideIsPlugin: Boolean(inside && root.contains(inside)),
        insideTag: inside ? inside.tagName : null,
        drawerVisible: Boolean(dialog && !dialog.hidden && dialog.getBoundingClientRect().width > 0),
      };
    })()`);

    /** 点击胶囊打开抽屉，等到 dialog 真正可见。 */
    const openDrawer = async (label) => {
      const clicked = await cdp.evaluate(`(() => {
        const root = document.getElementById('dsh-port-viewer-root');
        if (!root) return false;
        const nodes = Array.from(root.querySelectorAll('*'));
        const fixed = nodes.filter((el) => getComputedStyle(el).position === 'fixed');
        const viewportArea = window.innerWidth * window.innerHeight;
        const small = fixed.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.width * r.height < viewportArea * 0.12;
        });
        const pill = small.find((el) => /端口|port/i.test(el.textContent || '')) || small[0] || fixed[0] || root;
        pill.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`${label}: could not find the capsule to click`);
      const appeared = await waitFor(async () => {
        if (!(await drawerVisible())) return false;
        try {
          const text = await cdp.evaluate(`(() => {
            const root = document.getElementById('dsh-port-viewer-root');
            const dialog = root && root.querySelector('[role="dialog"]');
            return dialog ? (dialog.innerText || '').slice(0, 400) : '';
          })()`);
          return text && text.length > 0 ? text : false;
        } catch { return false; }
      }, WAIT_MS.dialog, 400);
      if (!appeared) {
        const rootText = await cdp.evaluate('(document.getElementById("dsh-port-viewer-root") || {}).innerText || ""').catch(() => '');
        throw new Error(`${label}: drawer dialog never rendered visibly (root text: ${snippet(rootText, 400)})`);
      }
      // 面板首次展开才拉数据：等行/状态条出现（最多额外 8 秒，失败不致命）。
      await waitFor(async () => {
        try {
          const text = await cdp.evaluate(`(() => {
            const root = document.getElementById('dsh-port-viewer-root');
            const dialog = root && root.querySelector('[role="dialog"]');
            return dialog ? (dialog.innerText || '') : '';
          })()`);
          return /共\\s*\\d+\\s*个端口|端口占用|\\.{2,}|加载/.test(text) ? text : false;
        } catch { return false; }
      }, 8000, 500);
      await new Promise((done) => setTimeout(done, WAIT_MS.settle));
      return appeared;
    };

    const writeShot = async (name, clip) => {
      const params = { format: 'png', captureBeyondViewport: false };
      if (clip) params.clip = { ...clip, scale: 2 };
      const { data } = await cdp.send('Page.captureScreenshot', params);
      const file = join(shotsDir, name);
      writeFileSync(file, Buffer.from(data, 'base64'));
      const size = statSync(file).size;
      result.shots.push(file);
      run.shots.push(file);
      // A cropped capsule is small by nature; a full panel shot must be a real render.
      const minBytes = clip ? 1200 : 10000;
      run.check(`screenshot ${name} exists`, size > minBytes, `${size} bytes (min ${minBytes}) -> ${file}`);
      return file;
    };

    // --- 1) 明色：页面加载 -> 命中测试 -> 胶囊截图 -> 展开抽屉截图
    await navigateAndWaitForRoot('light');
    const layerClosed = await probeLayering();
    run.info.layeringClosed = layerClosed;
    run.check('plugin root does not capture pointer events (pointer-events:none)',
      layerClosed?.pointerEvents === 'none', `pointer-events=${String(layerClosed?.pointerEvents)}`);
    run.check('dsh UI at (300,400) is clickable while the drawer is closed',
      layerClosed?.outsideIsPlugin === false, `elementFromPoint(300,400)=${String(layerClosed?.outsideTag)} insidePlugin=${String(layerClosed?.outsideIsPlugin)}`);

    const capsule = await findCapsule();
    run.info.capsule = capsule ?? null;
    run.check('capsule element present with a bounding box', Boolean(capsule && capsule.width > 0 && capsule.height > 0),
      capsule ? JSON.stringify(capsule) : 'capsule rect not found');
    if (capsule && capsule.width > 0 && capsule.height > 0) {
      await writeShot('capsule.png', {
        x: Math.max(0, capsule.x - 10),
        y: Math.max(0, capsule.y - 10),
        width: Math.min(VIEWPORT.width, capsule.width + 20),
        height: Math.min(VIEWPORT.height, capsule.height + 20),
      });
    }
    await openDrawer('light');
    const layerOpen = await probeLayering();
    run.info.layeringOpen = layerOpen;
    run.check('drawer is visibly open before the screenshot', layerOpen?.drawerVisible === true, JSON.stringify(layerOpen));
    run.check('dsh UI at (300,400) is still clickable while the drawer is open',
      layerOpen?.outsideIsPlugin === false, `elementFromPoint(300,400)=${String(layerOpen?.outsideTag)} insidePlugin=${String(layerOpen?.outsideIsPlugin)}`);
    run.check('the drawer itself receives pointer events (panel is interactive)',
      layerOpen?.insideIsPlugin === true, `elementFromPoint(right-120,400)=${String(layerOpen?.insideTag)}`);
    await writeShot('panel-light.png');

    // --- 2) 暗色：emulated prefers-color-scheme（ui-theme 默认 preference=system）
    await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await navigateAndWaitForRoot('dark');
    const isDark = await cdp.evaluate('document.body.hasAttribute("data-ds-dark-theme")');
    run.check('dark theme actually engaged under prefers-color-scheme:dark', Boolean(isDark), `data-ds-dark-theme=${String(isDark)}`);
    await openDrawer('dark');
    const layerDark = await probeLayering();
    run.info.layeringDark = layerDark;
    run.check('dark mode: root keeps pointer-events:none and the drawer stays visible',
      layerDark?.pointerEvents === 'none' && layerDark?.drawerVisible === true && layerDark?.outsideIsPlugin === false,
      JSON.stringify(layerDark));
    await writeShot('panel-dark.png');

    run.info.consoleErrors = consoleErrors;
    if (consoleErrors.length > 0) run.warn(`browser console errors during screenshots: ${snippet(consoleErrors.join(' | '), 600)}`);
  } catch (error) {
    result.failures.push(`screenshots: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (cdp) cdp.close();
    try { browserProc.kill(); } catch { /* already gone */ }
    await waitFor(async () => !(await probePort(debugPort)), 8000, 300);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(userDataDir, { recursive: true, force: true }); break; } catch { await new Promise((done) => setTimeout(done, 300)); }
    }
    try { rmSync(browserLog, { force: true }); } catch { /* best effort */ }
  }
  return result;
}
//#endregion

//#region 牺牲监听器
/** 起一个只听 127.0.0.1:45678 的 node 子进程（cwd = fixture 项目，用于项目归属断言）。 */
function spawnSacrifice(fixtureDir) {
  const program = [
    "const net = require('node:net');",
    "const server = net.createServer((socket) => socket.destroy());",
    "server.on('error', (error) => { console.error(error.message); process.exit(1); });",
    `server.listen(${SACRIFICE_PORT}, '127.0.0.1', () => { console.log('sacrifice listening'); });`,
  ].join('\n');
  const child = spawn(process.execPath, ['-e', program], { cwd: fixtureDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  return { child, exited, stderrOf: () => stderr.trim() };
}
//#endregion

//#region 主流程
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const run = new Run(options);
  const session = new BrowserSession(options.baseUrl);
  const fixtureDir = join(options.repoRoot, 'test', 'e2e', 'fixtures', 'fixture-project');
  let sacrifice = null;
  let exitCode = 0;

  try {
    run.info.phase = options.phase;
    run.info.origin = session.origin;
    run.info.instancePort = options.port;
    run.check('token URL carries ?token=', session.url.searchParams.has('token'), options.baseUrl.replace(/token=[^&]+/u, 'token=<redacted>'));

    // --- 1) token -> cookie
    const minted = await session.mint();
    run.info.mint = minted;
    run.check('token URL mints a browser cookie (303 + Set-Cookie)', minted.status === 303 && minted.cookieCount > 0,
      `status=${minted.status} set-cookie=${minted.cookieCount} body=${minted.body}`);

    // --- 2) 页面加载
    const index = await session.request('/');
    const html = await index.text();
    run.check('Web GUI index loads with the session cookie', index.status === 200 && index.headers.get('content-type')?.includes('text/html') === true,
      `status=${index.status} content-type=${index.headers.get('content-type')} bytes=${html.length}`);
    run.check('index serves a real document', html.includes('__DSH_BOOT__') && html.length > 5000, `bytes=${html.length}`);
    const hasPluginInBootGraph = html.includes('dsh-port-viewer');
    run.check('plugin id appears in the served boot graph', hasPluginInBootGraph,
      hasPluginInBootGraph ? 'found "dsh-port-viewer" in index.html' : 'dsh-port-viewer missing from index.html (check dsh.client.platform=web and the bundle row)');

    // --- 3) 未认证必须被拒
    const unauthorized = await fetch(`${session.origin}/`, { redirect: 'manual', cache: 'no-store' });
    run.check('unauthenticated index request is rejected (401)', unauthorized.status === 401, `status=${unauthorized.status}`);

    // --- 3b) 插件复用 dsh 自己的会话 cookie 鉴权（ctx.connection.authorizeIndex）
    // 带 cookie 的请求在第 5 步会验证 200；这里验证「没有凭证就进不来」。
    // 之所以不用插件自发的令牌：桌面壳对 dsh-app://app/ 的主文档是从磁盘直接提供的，
    // index 注入在桌面端永远不会执行，令牌到不了页面（详见 lib/index.js 的 assertSession）。
    const anonymousSnapshot = await fetch(`${session.origin}/api/port-viewer/snapshot`, { cache: 'no-store' });
    run.check('snapshot route rejects an anonymous (no-cookie) request', anonymousSnapshot.status === 401,
      `status=${anonymousSnapshot.status}`);
    const forgedCookie = await fetch(`${session.origin}/api/port-viewer/snapshot`, {
      headers: { cookie: 'dsh_session=forged-value' },
      cache: 'no-store',
    });
    run.check('snapshot route rejects a forged session cookie', forgedCookie.status === 401,
      `status=${forgedCookie.status}`);

    // --- 4) client 组合包可访问
    const combos = [...new Set((html.match(/plugins\/\?\?[^"'\s>]+/gu) ?? []).map((value) => value.replace(/&amp;/gu, '&')))];
    const pluginCombos = combos.filter((combo) => combo.includes('dsh-port-viewer/client.js'));
    run.info.comboCount = combos.length;
    run.info.pluginCombos = pluginCombos;
    if (pluginCombos.length === 0) {
      run.check('client bundle combo URL advertised for the plugin', false,
        `no /plugins/??...dsh-port-viewer/client.js reference among ${combos.length} combo URLs; first few: ${snippet(combos.slice(0, 3).join(' , '), 300)}`);
    } else {
      const combo = pluginCombos[0];
      const response = await session.request(`/${combo}`);
      const body = await response.text();
      const okBundle = response.status === 200 && body.length > 50 && body.includes('__ModuleLoader__') && body.includes('dsh-port-viewer');
      run.check('client bundle is served to the browser', okBundle,
        `status=${response.status} bytes=${body.length} content-type=${response.headers.get('content-type')} hasModuleLoader=${body.includes('__ModuleLoader__')}`);
      if (!okBundle) run.warn(`client bundle body head: ${snippet(body, 400)}`);
    }

    // --- 5) 插件路由（shell 用例也会走这里）
    const stub = await session.getJson('/api/port-viewer/snapshot');
    run.check('plugin HTTP route answers with the session cookie', stub.status === 200 && isObject(stub.json) && stub.json.ok === true,
      `status=${stub.status} body=${snippet(stub.text, 300)}`);

    if (options.phase === 'api' || options.phase === 'full') {
      // --- 6) 快照结构
      const problems = validateSnapshot(stub.json);
      run.check('GET /api/port-viewer/snapshot matches CONTRACT §5.4', problems.length === 0,
        problems.length === 0 ? 'structure is valid' : `${problems.length} problem(s): ${problems.slice(0, 8).join('; ')}`);
      const view = stub.json;
      if (isObject(view)) {
        const ports = Array.isArray(view.ports) ? view.ports : [];
        run.check('snapshot lists at least one listening port', ports.length > 0, `ports=${ports.length}`);
        run.info.snapshot = {
          portCount: ports.length,
          projectCount: Array.isArray(view.projects) ? view.projects.length : -1,
          stats: view.stats,
          generatedAt: view.generatedAt,
          durationMs: view.durationMs,
          warnings: Array.isArray(view.warnings) ? view.warnings.length : -1,
        };
        const attributed = ports.filter((port) => isObject(port.project) && port.project.source !== 'none' && typeof port.project.root === 'string');
        run.check('at least one port is attributed to a real project', attributed.length > 0,
          attributed.length > 0
            ? `${attributed.length} attributed (e.g. :${attributed[0].port} -> ${attributed[0].project.root} via ${attributed[0].project.source})`
            : `0 of ${ports.length} ports carry project.root`);
        if (attributed.length > 0) run.info.attributionSample = attributed.slice(0, 5).map((port) => ({ port: port.port, pid: port.pid, project: port.project }));

        // 一致性：stats 与列表长度（契约规则，不一致就报错而不是静默）
        if (isObject(view.stats)) {
          run.check('stats.portCount equals ports.length', view.stats.portCount === ports.length, `stats=${view.stats.portCount} ports=${ports.length}`);
          if (Array.isArray(view.projects)) {
            run.check('stats.projectCount equals projects.length', view.stats.projectCount === view.projects.length,
              `stats=${view.stats.projectCount} projects=${view.projects.length}`);
          }
          const protectedPorts = ports.filter((port) => isObject(port.flags) && port.flags.protected === true);
          const killableCount = ports.filter((port) => port.killable === true).length;
          run.info.protectedCount = protectedPorts.length;
          run.info.killableCount = killableCount;
          if (view.stats.protectedCount !== protectedPorts.length) {
            run.warn(`stats.protectedCount=${view.stats.protectedCount} but flags.protected ports=${protectedPorts.length}`);
          }
        }

        // --- 7) dsh 自身端口必须受保护，且 kill 请求必须被拒绝
        const selfPort = ports.find((port) => port.port === options.port);
        run.check('the isolated instance port appears in the snapshot', Boolean(selfPort), `port ${options.port}`);
        if (selfPort) {
          run.check('the dsh web port is flagged protected + not killable',
            selfPort.flags?.protected === true && selfPort.killable === false,
            `protected=${String(selfPort.flags?.protected)} killable=${String(selfPort.killable)} reason=${String(selfPort.protectedReason)}`);
          run.check('the dsh web port carries the dsh-ui-port protection reason',
            selfPort.protectedReason === 'dsh-ui-port', `protectedReason=${String(selfPort.protectedReason)}`);
          const guard = await session.request('/api/port-viewer/kill', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: session.origin },
            body: JSON.stringify({ targets: [{ port: selfPort.port, pid: selfPort.pid }] }),
          });
          const guardBody = await guard.text();
          let guardJson;
          try { guardJson = JSON.parse(guardBody); } catch { guardJson = undefined; }
          const refused = isObject(guardJson) && Array.isArray(guardJson.failed) && guardJson.failed.length === 1
            && Array.isArray(guardJson.results) && guardJson.results.length === 0;
          run.check('killing the dsh web port is refused by the safety gate', refused,
            `status=${guard.status} body=${snippet(guardBody, 400)}`);
          run.check('the refusal is reported as error=protected', isObject(guardJson) && guardJson.failed?.[0]?.error === 'protected',
            `failed[0]=${JSON.stringify(guardJson?.failed?.[0] ?? null)}`);
          // 界面必须还在：拒绝 kill 之后同一条路由照常服务。
          const stillServing = await session.getJson('/api/port-viewer/snapshot');
          run.check('the isolated UI is still serving after the refused kill', stillServing.status === 200 && isObject(stillServing.json) && stillServing.json.ok === true,
            `status=${stillServing.status}`);
          if (!refused) run.warn('safety gate did not refuse the dsh web port; the instance may have been killed by this test');
        }

        // --- 8) 犧牲监听器：出现 -> 归属 -> kill -> 端口消失
        run.check('sacrifice fixture project exists', existsSync(join(fixtureDir, 'package.json')), fixtureDir);
        sacrifice = spawnSacrifice(fixtureDir);
        run.info.sacrifice = { port: SACRIFICE_PORT, pid: sacrifice.child.pid, cwd: fixtureDir };
        const listening = await waitFor(() => probePort(SACRIFICE_PORT), WAIT_MS.port, 250);
        run.check(`sacrificial listener is up on :${SACRIFICE_PORT}`, Boolean(listening), `pid=${sacrifice.child.pid} stderr=${snippet(sacrifice.stderrOf(), 300)}`);

        let sacrificeEntry = null;
        const seen = await waitFor(async () => {
          const fresh = await session.getJson('/api/port-viewer/snapshot');
          const list = isObject(fresh.json) && Array.isArray(fresh.json.ports) ? fresh.json.ports : [];
          sacrificeEntry = list.find((port) => port.port === SACRIFICE_PORT && port.pid === sacrifice.child.pid) ?? null;
          return sacrificeEntry;
        }, WAIT_MS.snapshot, 500);
        run.check(`snapshot contains the sacrificial listener :${SACRIFICE_PORT}`, Boolean(seen),
          sacrificeEntry ? `pid=${sacrificeEntry.pid} killable=${String(sacrificeEntry.killable)}` : `entry not found after ${WAIT_MS.snapshot}ms`);
        if (sacrificeEntry) {
          run.info.sacrificeEntry = sacrificeEntry;
          const project = isObject(sacrificeEntry.project) ? sacrificeEntry.project : null;
          const attributedToFixture = Boolean(project && project.source !== 'none'
            && typeof project.root === 'string' && resolve(project.root).toLowerCase() === resolve(fixtureDir).toLowerCase());
          run.check('sacrificial listener is attributed to the fixture project (cwd inference)',
            attributedToFixture, `project=${JSON.stringify(project)} expected root=${fixtureDir}`);
          run.check('sacrificial listener is killable', sacrificeEntry.killable === true, `killable=${String(sacrificeEntry.killable)} protected=${String(sacrificeEntry.flags?.protected)}`);

          const killResponse = await session.request('/api/port-viewer/kill', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: session.origin },
            body: JSON.stringify({ targets: [{ port: SACRIFICE_PORT, pid: sacrifice.child.pid }] }),
          });
          const killBody = await killResponse.text();
          let killJson;
          try { killJson = JSON.parse(killBody); } catch { killJson = undefined; }
          const killOk = isObject(killJson) && killJson.ok === true && Array.isArray(killJson.results)
            && killJson.results.some((row) => row.port === SACRIFICE_PORT && row.pid === sacrifice.child.pid && row.ok === true);
          run.check('POST /api/port-viewer/kill reports the sacrifice as killed', killOk,
            `status=${killResponse.status} body=${snippet(killBody, 400)}`);

          const exited = await Promise.race([sacrifice.exited, new Promise((done) => setTimeout(() => done(null), 10000))]);
          run.check('sacrificial listener process actually exited', exited !== null,
            exited === null ? `pid ${sacrifice.child.pid} still alive after 10s` : `exit=${JSON.stringify(exited)}`);

          const portGone = await waitFor(async () => !(await probePort(SACRIFICE_PORT)), WAIT_MS.port, 250);
          run.check(`port ${SACRIFICE_PORT} is released after the kill`, Boolean(portGone), `127.0.0.1:${SACRIFICE_PORT} still accepting connections`);

          const goneFromSnapshot = await waitFor(async () => {
            const fresh = await session.getJson('/api/port-viewer/snapshot');
            const list = isObject(fresh.json) && Array.isArray(fresh.json.ports) ? fresh.json.ports : [];
            return !list.some((port) => port.port === SACRIFICE_PORT && port.pid === sacrifice.child.pid);
          }, WAIT_MS.port, 400);
          run.check(`port ${SACRIFICE_PORT} disappears from a refreshed snapshot`, Boolean(goneFromSnapshot), 'still present in snapshot');
        }
      }
    } else if (isObject(stub.json) && stub.json.stub === true) {
      run.info.shellStub = true;
      run.warn('snapshot route answered with the E2E shell stub: expected in phase A, the real lib/ was not linked yet');
    }

    if (options.phase === 'ui' || options.phase === 'full') {
      const shots = await captureShots(run, session);
      for (const failure of shots.failures) run.check(`screenshot step: ${snippet(failure, 200)}`, false, failure);
      if (shots.shots.length < 2) run.warn(`only ${shots.shots.length} screenshot(s) were written`);
    }
  } catch (error) {
    run.check('e2e driver completed without an unexpected error', false, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  } finally {
    if (sacrifice) {
      try { sacrifice.child.kill(); } catch { /* already dead */ }
      await waitFor(async () => !(await probePort(SACRIFICE_PORT)), 8000, 250);
      if (await probePort(SACRIFICE_PORT)) run.warn(`sacrificial listener still listening on :${SACRIFICE_PORT} after cleanup`);
    }
    run.info.durationMs = Date.now() - run.startedAt;
    const report = {
      ok: run.failed.length === 0,
      generatedAt: new Date().toISOString(),
      phase: options.phase,
      origin: session.origin,
      instancePort: options.port,
      safeUrl: options.baseUrl.replace(/token=[^&]+/u, 'token=<redacted>'),
      durationMs: run.info.durationMs,
      checks: run.checks,
      failedCount: run.failed.length,
      warnings: run.warnings,
      shots: run.shots,
      info: run.info,
      repoRoot: options.repoRoot,
      tokenFingerprint: createHash('sha256').update(session.tokenUrl).digest('hex').slice(0, 12),
    };
    try {
      mkdirSync(dirname(options.report), { recursive: true });
      writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      console.error(`e2e: could not write report to ${options.report}: ${String(error)}`);
    }

    console.log('');
    console.log(`e2e summary (phase=${options.phase}, ${report.durationMs}ms)`);
    for (const check of run.checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.ok ? '' : ` -> ${check.detail}`}`);
    for (const warning of run.warnings) console.log(`  WARN  ${warning}`);
    if (run.shots.length > 0) console.log(`  shots: ${run.shots.join(', ')}`);
    console.log(`  report: ${options.report}`);

    exitCode = run.failed.length === 0 ? 0 : 1;
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`e2e: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
//#endregion
