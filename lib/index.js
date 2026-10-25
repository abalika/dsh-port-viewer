/**
 * dsh-port-viewer — 宿主半边
 *
 * 只做两件事：把「本机端口 → 所属项目」的快照暴露成一条同源只读路由，以及把
 * 「关掉这些端口」暴露成一条同源破坏性路由。真正的采集在 `lib/collect.js`，
 * 归属推断在 `lib/projects.js`；本文件负责**安全闸门**与 HTTP 语义。
 *
 * ## 为什么安全规则集中在这里
 *
 * 采集层只是"标注"（这个进程看起来像系统进程、看起来像 dsh 自己），但"能不能杀"
 * 是执法问题，必须在真正执行 kill 的同一个进程里、用执行前一刻的数据判定。否则
 * 一个陈旧的快照就能把 svchost 或者 dsh 自己送走。所以：
 *
 *   - 前端拿到的 `killable` 只是**界面提示**；
 *   - 真正的门在 `resolveTargets()`：它拿**绕过缓存的新快照**重新核对
 *     「这个端口此刻是否仍属于这个 PID」，再套保护名单，最后才 spawn taskkill。
 *
 * ## 保护名单（三条独立理由，任一命中即拒绝）
 *
 * 1. 系统进程：pid<=4、已知系统进程名、exe 位于 %SystemRoot%。
 * 2. dsh 自身：宿主 pid、与 `process.execPath` 同 exe 的整个 Electron 进程树
 *    （主进程 / renderer / GPU / subprocess runner 全在内）。注意 node 作为宿主时
 *    `process.execPath` 也是 node.exe，此时**不能**按 exe 相等判定，否则会把用户
 *    自己的 dev server 全部锁死 —— 因此这条规则只对 Electron 宿主名生效。
 * 3. 正在承载本界面的端口：杀掉它等于把用户眼前的 GUI 拔线。
 *
 * ## 为什么请求要过同源 / content-type 检查
 *
 * 快照里含有命令行（可能带 token），kill 是破坏性动作。跨源浏览器请求一定带
 * `Origin`（简单请求也带），`Sec-Fetch-Site` 是第二道保险；Electron IPC 桥的请求
 * 没有 Origin，所以"缺省放行"不会破坏桌面端。
 *
 * @module dsh-port-viewer
 */
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** 本插件在宿主侧的名字（与 package.json / cordis patch 的 id 对齐）。 */
export const name = 'port-viewer';

/**
 * Windows 系统目录下的绝对路径。
 *
 * 一律用绝对路径而不是裸命令名：PATH 里任何可写目录（`%APPDATA%\npm` 之类）都能被
 * 同名程序劫持，而这几条命令是以 dsh 用户的身份执行的。
 *
 * @param executable - 可执行文件名（`taskkill.exe` / `powershell.exe`）。
 * @returns 绝对路径。
 */
function system32(executable) {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', executable);
}

/**
 * 宿主与浏览器半边约定的鉴权头 —— **已废弃**。
 *
 * 保留这个常量只是为了让老的客户端/文档不炸；真正的鉴权走 {@link assertSession}
 * （复用 dsh 自己的会话 cookie）。原因见 assertSession 的注释。
 *
 * @deprecated 用 assertSession。
 */
export const AUTH_HEADER = 'x-port-viewer-token';

/**
 * 用 dsh 自己的会话 cookie 校验请求（`ctx.connection.authorizeIndex`）。
 *
 * ## 为什么不用「插件自己发令牌」
 *
 * 最初的做法是：插件生成随机令牌，通过 `webServer.tapIndex` 注水进 index.html 的
 * `<meta>`，前端读出来放进请求头。这个方案在浏览器版 dsh 里能跑通，但在**桌面端结构上
 * 不可能成立**：桌面壳（`app.asar/lib/main.js`）对 `dsh-app://app/` 的主文档是
 * `serveWebDocument(request, join(app.getAppPath(), "renderer"))` —— 直接从磁盘提供，
 * 只有 `/api/*`、`/plugins/*` 这类路径才 `forwardWebRequest` 给 dsh 宿主。
 * 也就是说 `renderIndex`/`tapIndex` 永远不会为那个文档执行，meta 永远到不了页面。
 * 结果是强制令牌 = 面板 100% 401（实测踩过）。
 *
 * ## 现在的做法
 *
 * 直接复用宿主的会话校验：`ctx.connection.authorizeIndex(req, res)` 就是
 * `dsh-host-frontend-static` 用来放行 index、也是 `/api` 桥用来放行 API 的同一个函数。
 * 桌面壳在转发 `/api/*` 时会带上 `cookie: hostCookie`，所以浏览器侧天然带着凭证，
 * 而本机的其它进程（别的登录用户、脚本）没有。
 *
 * 兼容性：`connection` 服务或该方法不存在（旧宿主）时**直接放行**，退回同源 + CSRF 的
 * 老行为 —— 宁可少一层防护，也不要把面板锁死。
 *
 * @param req - node:http IncomingMessage。
 * @param res - node:http ServerResponse（失败时宿主自己写完 401）。
 * @param ctx - 运行中的 context（需要 connection 服务）。
 * @param required - 是否启用（config.requireSession，默认 true）。
 * @returns 是否继续处理；false 表示响应已经写好了。
 */
export function assertSession(req, res, ctx, required = true) {
  if (required !== true) return true;
  let connection;
  try {
    // 用 ctx.get('connection') 而不是属性访问：本插件的 effect 只 inject 了 webServer，
    // 没 inject 的服务在 cordis 里拿不到属性；get() 不要求预先注入。拿不到就退回放行。
    connection = typeof ctx?.get === 'function' ? ctx.get('connection') : ctx?.connection;
  }
  catch {
    connection = undefined;
  }
  if (connection === undefined || connection === null || typeof connection.authorizeIndex !== 'function') {
    return true;
  }
  try {
    return connection.authorizeIndex(req, res) === true;
  }
  catch {
    // 宿主内部报错时不要连累用户：放行，交给下面的同源/内容校验。
    return true;
  }
}

/** 只读快照路由。 */
export const SNAPSHOT_ROUTE = '/api/port-viewer/snapshot';

/** 关闭端口路由（POST，JSON）。 */
export const KILL_ROUTE = '/api/port-viewer/kill';

/** 请求体上限：kill 请求只带端口/PID 对，64 KiB 足够宽松。 */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** 单次 kill 请求允许的最大目标数，防止一次误操作送走一堆进程。 */
const DEFAULT_MAX_TARGETS = 128;

/** 快照缓存有效期：面板展开/刷新时连点不会反复拉起 PowerShell。 */
const DEFAULT_TTL_MS = 1200;

/** 采集超时：全表 CIM + PEB 读取在慢机器上也要留足余量。 */
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15000;

/**
 * 绝不允许关闭的 Windows 核心进程（小写、带 .exe）。
 *
 * 只列入"杀掉会让系统立刻出事"的那些；普通后台服务（如各种 updater）不在名单里，
 * 它们通常也不监听 TCP，真出现了用户自己判断。
 */
const SYSTEM_PROCESS_NAMES = new Set([
  'system',
  'idle',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'lsaiso.exe',
  'svchost.exe',
  'fontdrvhost.exe',
  'dwm.exe',
  'explorer.exe',
  'sihost.exe',
  'taskhostw.exe',
  'runtimebroker.exe',
  'searchindexer.exe',
  'securityhealthservice.exe',
  'msmpeng.exe',
  'nissrv.exe',
  'wmiprvse.exe',
  'spoolsv.exe',
  'audiodg.exe',
  'sppsvc.exe',
  'winlogon.exe',
]);

/** dsh 桌面端的主程序名（Electron 宿主的 exe 文件名）。 */
const ELECTRON_HOST_NAMES = new Set(['deepseek harness.exe', 'electron.exe', 'dsh.exe']);

/**
 * 命令行里要抹掉的敏感片段，避免把别人的 token 渲染到界面上。
 *
 * 每条是「正则 + 替换串」而不是裸正则：替换回调的参数个数随捕获组数量变化，
 * 统一用替换串才不会把 `match, p1, offset, string` 的位置参数当成密文。
 */
const SECRET_PATTERNS = [
  // 常见厂商密钥前缀：sk-…、sk_live_…、ghp_…、xox?-…、AKIA…、JWT
  { pattern: /\b(?:sk|rk)[-_](?:live|test)?[_-]?[A-Za-z0-9_-]{12,}/g, replacement: '«redacted»' },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, replacement: '«redacted»' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: '«redacted»' },
  // 环境变量风格：ABC_PASSWORD=x、MY_SECRET_KEY=x、OPENAI_API_KEY=x、*_TOKEN=…
  { pattern: /(^|[\s;"'])([A-Za-z0-9_]*(?:PASS(?:WORD|WD)?|PWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*=)("?[^\s"';]{3,}"?)/gi, replacement: '$1$2«redacted»' },
  // key=value / key: value 形态（顺序在 env 形态之后，避免重复匹配已抹掉的部分）。
  { pattern: /\b((?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|passwd)\s*[=:]\s*)("?[^\s"']{4,}"?)/gi, replacement: '$1«redacted»' },
  // --token value 形态。注意不能写成 `\b--token`：`-` 是非单词字符，
  // 前面又是空格，两者之间没有单词边界，那样会漏掉最常见的一种写法。
  { pattern: /(^|[\s"'=])(--(?:api-key|token|secret|password|passwd|pass|pwd)\s+)(\S{4,})/gi, replacement: '$1$2«redacted»' },
  // -p s3cr3t 这类短参数（只认 `-p`，别误伤 -print 之类）。
  { pattern: /(^|[\s"'=])(-p\s+)(\S{4,})/g, replacement: '$1$2«redacted»' },
  // URL 里内嵌的凭据：https://user:pass@host、postgres://admin:pw@db。
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, replacement: '$1«redacted»@' },
  // Authorization: Bearer xxx（命令行里偶尔整条带进来）。
  { pattern: /\b(Bearer\s+)([A-Za-z0-9._-]{12,})/gi, replacement: '$1«redacted»' },
];

/**
 * 带 HTTP 语义的失败。
 *
 * handler 内部所有可预期失败都抛它；最外层负责转成 `{ ok:false, error, code }`，
 * 绝不让异常穿透成宿主 500 页面。
 */
class HttpError extends Error {
  /**
   * @param status - HTTP 状态码。
   * @param code - 稳定错误码（forbidden / method-not-allowed / invalid-body / io / timeout）。
   * @param message - 人类可读说明。
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 把配置读成朴素对象（不引入 schemastery；Config 是可选的）。
 *
 * @param config - 插件配置，可能为 undefined。
 * @returns 归一化后的选项。
 */
export function normalizeOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback);
  return {
    protectSystem: bool(source.protectSystem, true),
    // 用 dsh 自己的会话 cookie 校验请求（见 assertSession：插件无法自己发令牌，
    // 桌面壳直接提供主文档，index 注水在桌面端结构上不可行）。
    // 宿主没有 connection 服务时自动放行，退回同源 + CSRF 的老行为。
    requireSession: bool(source.requireSession, true),
    ttlMs: positive(source.ttlMs, DEFAULT_TTL_MS),
    maxTargets: positive(source.maxTargets, DEFAULT_MAX_TARGETS),
    maxBodyBytes: positive(source.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    snapshotTimeoutMs: positive(source.snapshotTimeoutMs, DEFAULT_SNAPSHOT_TIMEOUT_MS),
  };
}

/** 写一个 JSON 响应；序列化失败时退回最小错误体，绝不二次抛错。 */
function sendJson(res, status, body) {
  let payload;
  try {
    payload = JSON.stringify(body);
  }
  catch {
    payload = JSON.stringify({ ok: false, error: 'response serialization failed', code: 'io' });
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(payload);
  }
  catch {
    // 连接已断开 / 头已发出：没有更多能做的事，绝不把异常抛回宿主。
  }
}

/**
 * 读请求体（有界）。
 *
 * @param req - node:http IncomingMessage（测试里是带属性的 Readable）。
 * @param limit - 最大字节数。
 * @returns UTF-8 文本。
 * @throws {HttpError} 403 超限。
 */
async function readBody(req, limit) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(403, 'forbidden', `request body exceeds ${String(limit)} bytes`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new HttpError(403, 'forbidden', `request body exceeds ${String(limit)} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 本机回环主机名的等价写法（浏览器地址栏可能用 localhost 或 127.0.0.1）。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 判断请求的 Origin 是否就是本服务的源。
 *
 * @param origin - 请求头 Origin。
 * @param expected - 本机 origin（webServer.getOrigin()）。
 * @returns 是否同源。
 */
function isSameOrigin(origin, expected) {
  if (origin === expected) return true;
  let left;
  let right;
  try {
    left = new URL(origin);
    right = new URL(expected);
  }
  catch {
    return false;
  }
  if (left.protocol !== right.protocol || left.port !== right.port) return false;
  if (LOOPBACK_HOSTS.has(left.hostname) && LOOPBACK_HOSTS.has(right.hostname)) return true;
  return left.hostname === right.hostname;
}

/**
 * 同源校验。
 *
 * 跨源浏览器请求一定带 `Origin`；`Sec-Fetch-Site` 是第二道保险。Electron IPC 桥
 * 的请求没有 Origin，因此"缺省放行"不会破坏桌面端。
 *
 * @param req - IncomingMessage。
 * @param ctx - 运行中的 context；用其 `webServer.getOrigin()` 求本机 origin。
 * @throws {HttpError} 403 forbidden。
 */
function assertSameOrigin(req, ctx) {
  const headers = req.headers ?? {};
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'forbidden', `cross-site request refused (sec-fetch-site: ${String(fetchSite)})`);
  }
  const origin = headers.origin;
  if (origin === undefined || origin === '') return;
  let expected;
  try {
    expected = ctx?.webServer?.getOrigin?.();
  }
  catch {
    expected = undefined;
  }
  if (typeof expected !== 'string' || expected.length === 0) {
    // 退路：用 Host + 监听协议拼出本机 origin。
    const host = headers.host;
    let protocol = 'http:';
    try {
      if (typeof ctx?.webServer?.protocol === 'string') protocol = ctx.webServer.protocol;
    }
    catch {
      // 保持默认。
    }
    expected = host === undefined ? undefined : `${protocol}//${String(host)}`;
  }
  if (typeof expected !== 'string' || !isSameOrigin(origin, expected)) {
    throw new HttpError(403, 'forbidden', `cross-origin request refused (origin: ${String(origin)})`);
  }
}

/**
 * 破坏性请求额外要求的 JSON content-type。
 *
 * 表单发不出 `application/json`，任意网页也就无法用简单请求触发 kill。
 *
 * @param req - IncomingMessage。
 * @throws {HttpError} 403 forbidden。
 */
function assertJsonContentType(req) {
  const contentType = String(req.headers?.['content-type'] ?? '');
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new HttpError(403, 'forbidden', 'content-type must be application/json');
  }
}

/** 抹掉命令行里的敏感片段，避免把 token 渲染到界面上。 */
export function maskSecrets(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.length === 0) return commandLine;
  let masked = commandLine;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

/** 归一化 exe 路径用于比较：小写、统一分隔符、去掉尾部斜杠。 */
function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let path = value.trim().replaceAll('/', '\\').toLowerCase();
  while (path.length > 3 && path.endsWith('\\')) path = path.slice(0, -1);
  return path;
}

/**
 * 本插件的"自己人"判定上下文。
 *
 * 在 `apply()` 里算一次，交给每请求复用：宿主 pid、宿主 exe（仅当它看起来是
 * Electron 宿主时才按 exe 相等保护整个进程树）。
 *
 * @param ctx - 运行中的 context（可能还没有 webServer）。
 * @returns 保护上下文。
 */
export function selfContext(ctx) {
  const selfPid = typeof process.pid === 'number' ? process.pid : -1;
  const execPath = typeof process.execPath === 'string' ? process.execPath : '';
  const execName = basename(execPath).toLowerCase();
  // 只有 Electron 宿主才按 exe 相等保护：node 作为宿主时，用户自己的 dev server
  // 也是 node.exe，按 exe 相等会把它一起锁死。
  const hostIsElectron = ELECTRON_HOST_NAMES.has(execName);
  let guiPort;
  try {
    const origin = ctx?.webServer?.getOrigin?.();
    if (typeof origin === 'string') {
      const parsed = new URL(origin);
      const port = Number(parsed.port);
      if (Number.isFinite(port) && port > 0) guiPort = port;
    }
  }
  catch {
    guiPort = undefined;
  }
  let systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (typeof systemRoot !== 'string' || systemRoot.length === 0) systemRoot = 'C:\\Windows';
  return {
    selfPid,
    selfExe: hostIsElectron ? normalizePath(execPath) : undefined,
    hostDir: hostIsElectron ? normalizePath(dirname(execPath)) : undefined,
    systemRoot: normalizePath(resolve(systemRoot)),
    guiPort,
  };
}

/**
 * 判定一个端口条目是否受保护。
 *
 * @param entry - 快照里的端口条目。
 * @param context - selfContext() 的结果。
 * @param protectSystem - 是否启用系统进程保护。
 * @returns `{ protected, reason }`；reason 是稳定错误码，供 UI 与日志使用。
 */
export function protectionOf(entry, context, protectSystem = true) {
  const pid = Number(entry?.pid);
  const exePath = normalizePath(entry?.exePath);
  const processName = String(entry?.processName ?? '').toLowerCase();

  if (context.guiPort !== undefined && Number(entry?.port) === context.guiPort) {
    return { protected: true, reason: 'dsh-ui-port' };
  }
  if (Number.isFinite(pid) && pid === context.selfPid) {
    return { protected: true, reason: 'dsh-self' };
  }
  if (context.selfExe !== undefined && exePath === context.selfExe) {
    return { protected: true, reason: 'dsh-self' };
  }
  if (context.hostDir !== undefined && exePath !== undefined
      && (exePath === context.hostDir || exePath.startsWith(`${context.hostDir}${sep}`))
      && ELECTRON_HOST_NAMES.has(basename(exePath))) {
    return { protected: true, reason: 'dsh-self' };
  }
  // 采集层读不到 exe 与命令行（典型：SYSTEM 账户拉起的服务，如 Clash 内核 verge-mihomo）。
  // 身份不可知时一律不放行：taskkill 对它本来就是 AccessDenied，给用户一个必然失败的
  // 关闭按钮比不给更糟。这条不受 protectSystem 影响 —— 「关不掉」和「允许关」是两回事。
  if (entry?.flags?.opaque === true) {
    return { protected: true, reason: 'opaque-process' };
  }
  if (!protectSystem) return { protected: false, reason: null };
  if (Number.isFinite(pid) && pid <= 4) {
    return { protected: true, reason: 'system-pid' };
  }
  if (SYSTEM_PROCESS_NAMES.has(processName)) {
    return { protected: true, reason: 'system-process' };
  }
  if (exePath !== undefined && exePath.startsWith(`${context.systemRoot}${sep}`)) {
    return { protected: true, reason: 'system-directory' };
  }
  return { protected: false, reason: null };
}

/**
 * 给视图补上权威的 kill 安全标注。
 *
 * 采集层给的 `flags.protected` 只是启发式提示，这里用宿主自己的上下文覆盖它，
 * 并重新统计分组的可关闭数量与整体统计。
 *
 * @param view - collectSnapshot() 返回的视图（会被原地修改）。
 * @param context - selfContext() 的结果。
 * @param protectSystem - 是否启用系统进程保护。
 * @returns 同一个 view，便于链式调用。
 */
export function applySafety(view, context, protectSystem = true) {
  if (view === null || typeof view !== 'object') return view;
  const ports = Array.isArray(view.ports) ? view.ports : [];
  let protectedCount = 0;
  for (const entry of ports) {
    if (entry === null || typeof entry !== 'object') continue;
    const verdict = protectionOf(entry, context, protectSystem);
    const flags = entry.flags !== null && typeof entry.flags === 'object' ? entry.flags : {};
    flags.protected = verdict.protected;
    entry.flags = flags;
    entry.protectedReason = verdict.reason;
    // 采集不上来的 PID（0 / 负数）也视为不可关闭：没有有效 pid 就无从下手。
    const pid = Number(entry.pid);
    entry.killable = verdict.protected === false && Number.isFinite(pid) && pid > 4;
    entry.commandLine = maskSecrets(entry.commandLine);
    if (verdict.protected) protectedCount += 1;
  }
  if (Array.isArray(view.projects)) {
    for (const project of view.projects) {
      if (project === null || typeof project !== 'object') continue;
      const owned = ports.filter((entry) => entry?.project?.key === project.key);
      project.killableCount = owned.filter((entry) => entry?.killable === true).length;
    }
  }
  if (view.stats !== null && typeof view.stats === 'object') {
    view.stats.protectedCount = protectedCount;
    view.stats.killableCount = ports.filter((entry) => entry?.killable === true).length;
  }
  return view;
}

/**
 * 采集层的默认实现：**惰性** import `lib/collect.js`。
 *
 * 用动态 import 而不是顶层 import，是为了让「采集层坏了」只表现为快照路由 503，
 * 而不是整个插件在 profile 组装阶段加载失败（那样连胶囊都不会出现，用户连报错
 * 都看不到）。ESM 会缓存模块求值，代价只有第一次的一点点。
 *
 * @param options - 采集选项。
 * @returns collectSnapshot 的结果。
 */
async function defaultCollector(options) {
  const module = await import('./collect.js');
  return module.collectSnapshot(options);
}

/**
 * 建一个带 TTL 缓存 + 单飞（single-flight）的快照提供者。
 *
 * 面板展开时可能连点刷新，或者多个窗口同时打开；缓存让这些请求合并成一次采集。
 * `mode: 'fresh'` 绕过缓存 —— kill 之前的核对必须用最新数据。
 *
 * @param options - normalizeOptions() 的结果。
 * @param collector - 采集函数（默认惰性加载 lib/collect.js，测试可替换）。
 * @returns `{ get(mode) }`。
 */
export function createSnapshotProvider(options, collector = defaultCollector) {
  /** @type {{ at: number, view: object } | null} */
  let cache = null;
  /** @type {Promise<object> | null} */
  let inFlight = null;
  const runCollect = async () => {
    const result = await collector({
      timeoutMs: options.snapshotTimeoutMs,
      includeCwd: true,
    });
    if (result === null || typeof result !== 'object') {
      const error = new HttpError(503, 'io', 'the port collector returned no result');
      throw error;
    }
    if (result.ok !== true) {
      const error = new HttpError(503, result.code ?? 'io', result.error ?? 'port collection failed');
      throw error;
    }
    const view = result.snapshot ?? result.view;
    if (view === null || typeof view !== 'object') {
      throw new HttpError(503, 'io', 'the port collector returned an empty snapshot');
    }
    return view;
  };
  return {
    /**
     * @param mode - `'cache'`（默认）或 `'fresh'`（绕过缓存，kill 前核对用）。
     * @returns 采集结果视图。
     */
    async get(mode = 'cache') {
      const freshEnough = () => cache !== null && Date.now() - cache.at < options.ttlMs;
      if (mode !== 'fresh' && freshEnough()) return cache.view;
      // 已有一轮采集在飞：它一定是本请求之后才开始跑的，等它落地即可，
      // 不要为此再拉起第二个 PowerShell（慢机器上会排队几十秒）。
      if (inFlight !== null) {
        const shared = await inFlight.catch(() => null);
        if (shared !== null) return shared;
        // 在飞的那轮失败了：`cache` 可能还留着更早的结果，但 **`fresh` 绝不回退到缓存** ——
        // kill 之前的核对宁可失败，也不能拿一份几小时前的快照去授权杀进程。
        if (mode === 'fresh') throw new HttpError(503, 'io', 'port collection failed; refusing to reuse a stale snapshot');
        if (cache !== null) return cache.view;
      }
      inFlight = (async () => {
        const view = await runCollect();
        cache = { at: Date.now(), view };
        return view;
      })();
      try {
        return await inFlight;
      }
      finally {
        inFlight = null;
      }
    },
    /** 让下一次读取必然重采（kill 之后用）。 */
    invalidate() {
      cache = null;
    },
  };
}

/** taskkill 自身的超时：它卡住时不能让整条 kill 请求陪着一起僵死。 */
const TASKKILL_TIMEOUT_MS = 5000;

/**
 * 进程是否还活着。
 *
 * 用 `process.kill(pid, 0)` 做探针（signal 0 不投递信号，只做存在性检查）：
 * 这是唯一可靠的「taskkill 之后到底死了没有」判据 —— taskkill 的退出码不可信，
 * 128 既可能是「没有这个进程」，也可能是「Access denied / 关键系统进程」。
 *
 * @param pid - 目标 PID。
 * @returns 活着返回 true；EPERM 表示「存在但无权操作」，也算活着。
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch (error) {
    // ESRCH = 不存在；EPERM = 存在但无权 → 对"有没有退出"来说仍是活着。
    return error?.code === 'EPERM';
  }
}

/**
 * 用 taskkill 结束一个进程树。
 *
 * `/T` 连带子进程：dev server 常常是 `npm` → `node`，只收父进程会留下孤儿继续占端口。
 *
 * @param pid - 目标 PID。
 * @param spawnImpl - 可注入的 spawn（测试用）。
 * @returns `{ ok, code, message }`。
 */
/**
 * 把 Windows 控制台程序的原始输出解成字符串。
 *
 * taskkill 在中文系统上输出的是 GBK/ANSI 字节；直接按 UTF-8 解会变成乱码，
 * 而这些文本会作为失败原因显示在界面标题里。优先用 GBK 解，环境不支持时退回 UTF-8。
 */
const CONSOLE_DECODER = (() => {
  try {
    return new TextDecoder('gbk', { fatal: false });
  }
  catch {
    return undefined;
  }
})();

function decodeConsoleChunk(chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (CONSOLE_DECODER !== undefined) {
    try {
      return CONSOLE_DECODER.decode(buffer, { stream: true });
    }
    catch {
      // 落到 UTF-8 兜底。
    }
  }
  return buffer.toString('utf8');
}

export function killProcessTree(pid, spawnImpl = spawn) {
  return new Promise((resolvePromise) => {
    const settle = (result) => {
      clearTimeout(timer);
      resolvePromise(result);
    };
    let child;
    try {
      child = spawnImpl(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    catch (error) {
      settle({ ok: false, code: 'spawn-failed', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    // taskkill 卡住时也要有结论：超时后按"没死"处理并让调用方看到原因。
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      settle({ ok: false, code: 'taskkill-timeout', message: `taskkill 超过 ${String(TASKKILL_TIMEOUT_MS)}ms 未返回` });
    }, TASKKILL_TIMEOUT_MS);

    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += decodeConsoleChunk(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += decodeConsoleChunk(chunk);
    });
    child.once('error', (error) => {
      settle({ ok: false, code: 'spawn-failed', message: error instanceof Error ? error.message : String(error) });
    });
    child.once('close', (code) => {
      const detail = stderr.trim() || stdout.trim() || `taskkill exited with ${String(code)}`;
      // 退出码只当线索，真正的判据是「进程还在不在」。
      const alive = isProcessAlive(pid);
      if (!alive) {
        settle({ ok: true, code: code === 0 ? 'killed' : 'already-exited', message: detail });
        return;
      }
      settle({ ok: false, code: code === 0 ? 'still-alive' : 'taskkill-failed', message: detail });
    });
  });
}

/**
 * 校验并归一化 kill 请求的目标列表。
 *
 * @param body - 请求体（已 JSON.parse）。
 * @param maxTargets - 上限。
 * @returns `{ port, pid }[]`。
 * @throws {HttpError} 400 invalid-body。
 */
export function validateTargets(body, maxTargets = DEFAULT_MAX_TARGETS) {
  const raw = Array.isArray(body?.targets) ? body.targets : undefined;
  if (raw === undefined) {
    throw new HttpError(400, 'invalid-body', 'request body must be {"targets":[{"port":5173,"pid":1234}]}');
  }
  if (raw.length === 0) throw new HttpError(400, 'invalid-body', 'targets must not be empty');
  if (raw.length > maxTargets) {
    throw new HttpError(400, 'invalid-body', `at most ${String(maxTargets)} targets are allowed per request`);
  }
  const seen = new Set();
  const targets = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      throw new HttpError(400, 'invalid-body', 'every target must be an object with port and pid');
    }
    const port = Number(item.port);
    const pid = Number(item.pid);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new HttpError(400, 'invalid-body', `invalid port: ${String(item.port)}`);
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new HttpError(400, 'invalid-body', `invalid pid: ${String(item.pid)}`);
    }
    const key = `${String(port)}:${String(pid)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ port, pid });
  }
  return targets;
}

/**
 * 建两个 handler。
 *
 * 与 apply 解耦是为了单元测试：测试用假 ctx / 假 req / 假 res / 假采集器直接驱动。
 *
 * @param options - normalizeOptions() 的结果。
 * @param ctxProvider - 返回运行中 context 的函数（apply 里是 `() => webCtx`）。
 * @param provider - createSnapshotProvider() 的结果（kill 需要 invalidate）。
 * @param killImpl - 可注入的 kill 实现。
 * @returns `{ snapshot, kill }` 两个 node:http handler。
 */
export function createHandlers(options, ctxProvider, provider, killImpl = killProcessTree) {
  /** 每次请求重新算自己人上下文：guiPort 要跟着当前 webServer 走。 */
  const contextOf = () => selfContext(typeof ctxProvider === 'function' ? ctxProvider() : undefined);
  /** 每个请求都拿最新的 ctx（connection 服务可能晚就绪）。 */
  const ctxOf = () => (typeof ctxProvider === 'function' ? ctxProvider() : undefined);
  const requireSession = options.requireSession !== false;

  const snapshot = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        throw new HttpError(405, 'method-not-allowed', 'use GET for the port snapshot');
      }
      const ctx = ctxOf();
      assertSameOrigin(req, ctx);
      // 会话校验失败时宿主已经把 401 写完了，这里必须直接返回。
      if (assertSession(req, res, ctx, requireSession) !== true) return;
      const url = new URL(req.url ?? SNAPSHOT_ROUTE, 'http://127.0.0.1');
      const mode = url.searchParams.get('fresh') === '1' ? 'fresh' : 'cache';
      const view = await provider.get(mode);
      applySafety(view, contextOf(), options.protectSystem);
      sendJson(res, 200, { ok: true, ...view });
    }
    catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, error: error.message, code: error.code });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'io',
      });
    }
  };

  const kill = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        throw new HttpError(405, 'method-not-allowed', 'use POST for closing ports');
      }
      const ctx = ctxOf();
      assertSameOrigin(req, ctx);
      if (assertSession(req, res, ctx, requireSession) !== true) return;
      assertJsonContentType(req);
      const text = await readBody(req, options.maxBodyBytes);
      let body;
      try {
        body = JSON.parse(text);
      }
      catch {
        throw new HttpError(400, 'invalid-body', 'request body is not valid JSON');
      }
      const targets = validateTargets(body, options.maxTargets);

      // 用新鲜快照核对：端口此刻是否仍归这个 PID、以及是否受保护。
      // 陈旧快照 + PID 复用是杀错进程的经典路径，必须在执行前一刻复核。
      const view = await provider.get('fresh');
      const context = contextOf();
      applySafety(view, context, options.protectSystem);
      const byPort = new Map();
      for (const entry of Array.isArray(view.ports) ? view.ports : []) {
        if (entry === null || typeof entry !== 'object') continue;
        const key = Number(entry.port);
        if (!byPort.has(key)) byPort.set(key, []);
        byPort.get(key).push(entry);
      }

      const results = [];
      const failed = [];
      for (const target of targets) {
        const candidates = byPort.get(target.port) ?? [];
        const current = candidates.find((entry) => Number(entry.pid) === target.pid);
        const record = { port: target.port, pid: target.pid };
        if (current === undefined) {
          const occupant = candidates.length > 0 ? Number(candidates[0].pid) : null;
          failed.push({ ...record, error: 'stale', message: '这个端口已经不属于该进程了（可能已经退出或被重新占用）', currentPid: occupant });
          continue;
        }
        if (current.killable !== true) {
          failed.push({
            ...record,
            error: 'protected',
            reason: current.protectedReason ?? 'unknown',
            message: '受保护的进程或端口，插件不会关闭它',
          });
          continue;
        }
        const outcome = await killImpl(target.pid);
        if (outcome.ok) {
          results.push({ ...record, ok: true });
        }
        else {
          failed.push({ ...record, error: outcome.code, message: outcome.message });
        }
      }
      provider.invalidate();
      sendJson(res, 200, {
        ok: failed.length === 0,
        results,
        failed,
        killed: results.length,
      });
    }
    catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, error: error.message, code: error.code });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'io',
      });
    }
  };

  return { snapshot, kill };
}

/**
 * 插件入口。
 *
 * @param ctx - 插件 context。
 * @param config - 可选配置（protectSystem / ttlMs / maxTargets / maxBodyBytes / snapshotTimeoutMs）。
 */
export function apply(ctx, config) {
  const options = normalizeOptions(config);
  const provider = createSnapshotProvider(options);
  ctx.inject(['webServer'], (webCtx) => {
    const handlers = createHandlers(options, () => webCtx, provider, killProcessTree);
    // register() 返回 disposer；包在 ctx.effect 里，插件热重载时路由被清掉而不是泄漏
    // （泄漏会让下一次注册因"重复路由"直接抛错）。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: SNAPSHOT_ROUTE,
      handler: handlers.snapshot,
    }));
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: KILL_ROUTE,
      handler: handlers.kill,
    }));
  });
}
