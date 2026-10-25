/**
 * dsh-port-viewer — Host 侧「端口 → 项目」归属推断（docs/CONTRACT.md §5.3 / §5.4）。
 *
 * 设计要点：
 * 1. **纯函数**。`buildPortView(rawSnapshot, options)` 不直接碰 fs / 网络 / 时钟：
 *    目录内容通过 `options.listDir` 注入（默认用 node:fs，测试注入假目录树），
 *    当前时间通过 `options.now` 注入。同样的输入 + 同样的注入 = 同样的输出。
 * 2. 项目归属是「证据链」：越具体的证据越优先（cwd 命中的项目根 > 命令行路径 >
 *    父链 > 工作区表 > 进程所在目录 > 同名 exe 所在目录），命中即停，
 *    并用 `project.source` 记录是哪一级命中的。
 * 3. 找不到证据也不丢端口：归到 `unknown:<pid>`，UI 里显示「未识别项目」。
 *
 * options（全部可选）：
 *   now            number     当前时间戳（ms），默认 Date.now()
 *   durationMs     number     采集总耗时，原样写进视图（collect.js 传入）
 *   listDir        (dir) => Array<{name, isDirectory}> | null  注入目录读取（测试用）
 *   env            object     环境变量表，默认 process.env（读 SystemRoot / USERPROFILE / TEMP）
 *   dshHome        string     DSH 数据根；默认 env.DSH_HOME。其下 profiles\<name> 是 dsh
 *                             自己的运行时目录，不算项目根（见 §8 环境事实）
 *   workspaces     Array<string|{path,title}>  DSH 工作区表里的登记路径（collect.js 读文件后传入）
 *   selfPids       number[]   dsh 自身进程树（宿主 pid + 祖先 + 同 exe 进程），标 protected
 *   webServerPorts number[]   dsh 的 Web 服务端口，标 protected
 *   extraWarnings  string[]   追加到视图 warnings 的提示（collect.js 用来汇报降级）
 */

import { readdirSync } from 'node:fs';
import { win32 as winPath } from 'node:path';

/** 视图 schema 版本，与 lib/snapshot.ps1 的 schemaVersion 保持一致。 */
export const SCHEMA_VERSION = 1;

/** 向上找项目根的最大层数（契约要求 6 层）。 */
export const MAX_ROOT_WALK = 6;

/** 父链回退的最大层数（契约要求 4 层）。 */
const MAX_PARENT_WALK = 4;

/** 判定「项目根」的标志物文件名（小写比较）。`.git` 可以是目录也可以是文件。 */
const MARKER_NAMES = new Set([
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'composer.json',
]);

/** 这些目录名太泛，不能直接当项目名（例如 D:\Tools\app → 应该是 D:\Tools）。 */
const GENERIC_DIR_NAMES = new Set([
  'app',
  'apps',
  'bin',
  'build',
  'dist',
  'obj',
  'out',
  'output',
  'release',
  'debug',
  'resources',
  'resource',
  'runtime',
  'lib',
  'libs',
  'src',
  'source',
  'sbin',
  'target',
  'x64',
  'x86',
  'win32',
  'win64',
  'node_modules',
  'locales',
  'assets',
  'static',
  'public',
  'packages',
  'content',
  'current',
  'versions',
  // Python 虚拟环境：D:\proj\.venv\Scripts\python.exe 的项目是 D:\proj
  'scripts',
  '.venv',
  'venv',
  'site-packages',
  'dist-packages',
]);

/**
 * 系统进程名单（契约 §6，已去掉 .exe 并小写）。
 * 只用于视图里 `flags.system` / `protected` 的启发式标注，
 * 真正的 kill 闸门在 lib/index.js 里，这里不求完备。
 */
const SYSTEM_PROCESS_NAMES = new Set([
  'system',
  'idle',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'smss',
  'svchost',
  'sppsvc',
  'msmpeng',
  'audiodg',
  'dwm',
  'explorer',
  'searchindexer',
  'sihost',
  'taskhostw',
  'runtimebroker',
]);

/** 数据库端口（契约 §5.4 的 kind=database）。 */
const DATABASE_PORTS = new Set([
  1433, 1434, 1521, 3306, 5432, 6379, 9042, 9200, 9300, 11211, 27017, 27018, 2181, 5672, 5984, 2379, 2380, 8500,
]);

/** dev-server 类进程名（node/vite/next/webpack/nuxt/angular/deno/bun 等）。 */
const DEV_SERVER_NAME_PATTERN =
  /^(node|nodejs|bun|deno|pnpm|pnpm\.cjs|npm|npm\.cjs|npx|yarn|yarn\.cjs|vite|next|nuxt|webpack|webpack-dev-server|angular|ng|http-server|serve|esbuild|tsx|ts-node|nodemon|astro|remix|svelte-kit|parcel)(\.exe|\.cmd|\.bat)?$/;

/** 命令行里出现这些就基本可以确定是本地开发服务器。 */
const DEV_SERVER_CMD_PATTERN =
  /(vite|webpack-dev-server|next[\\/]dist[\\/]bin[\\/]next|nuxt|@angular[\\/]cli|deno\s+(run|task)\s+dev|bun\s+(run\s+)?dev|nodemon|ts-node|esbuild|astro\s+dev|remix\s+(dev|watch)|parcel\s+serve)/i;

/** Python 运行时 / WSGI 服务器进程名。 */
const PYTHON_NAME_PATTERN = /^(python|pythonw|py|uvicorn|gunicorn|hypercorn|waitress-serve)(\.exe)?$/;

/** 命令行里出现这些就基本可以确定是 Python 服务。 */
const PYTHON_CMD_PATTERN =
  /(-m\s+uvicorn|-m\s+gunicorn|-m\s+flask|-m\s+django|-m\s+http\.server|-m\s+jupyter|-m\s+streamlit|-m\s+gradio|manage\.py\s+runserver|hypercorn|waitress-serve)/i;

const JAVA_NAME_PATTERN = /^(java|javaw|javaws)(\.exe)?$/;
const DOTNET_NAME_PATTERN = /^(dotnet|w3wp|iisexpress|mono|msbuild)(\.exe)?$/;
const DOCKER_NAME_PATTERN = /(docker|com\.docker|docker-proxy|vpnkit|nerdctl|podman|containerd)/i;

/** 这些 kind 才给 http:// URL（契约：非 HTTP 端口留 null）。 */
const HTTP_KINDS = new Set(['dev-server', 'python', 'java', 'dotnet', 'app']);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function parseTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 规范化 Windows 绝对路径：统一反斜杠、小写盘符、去掉尾部分隔符。
 * 只接受绝对路径（盘符或 UNC），其它一律返回 null。
 * 项目 key 与 root 都用这个函数的结果（契约 §5.3）。
 */
export function normalizeDir(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim().replace(/\//g, '\\');
  if (!text) return null;
  // UNC 一律不认（\\host\share、\\?\C:、\\.\PIPE\…）。这些路径来自**别的进程的命令行**，
  // 而项目根探测会真的去 listDir 它 —— 那等于替对方发起一次 SMB 认证（NetNTLM 可被中继），
  // 遇到不可达主机还会同步阻塞宿主的事件循环。宁可归到「未识别」，也不碰网络路径。
  if (text.startsWith('\\\\')) return null;
  if (!/^[a-zA-Z]:\\/.test(text)) {
    if (/^[a-zA-Z]:$/.test(text)) text = text + '\\';
    else return null;
  }
  text = winPath.normalize(text);
  if (/^[a-zA-Z]:/.test(text)) text = text[0].toLowerCase() + text.slice(1);
  if (text.length > 3 && text.endsWith('\\')) text = text.replace(/\\+$/, '');
  return text;
}

function lowerDir(value) {
  const normalized = normalizeDir(value);
  return normalized === null ? null : normalized.toLowerCase();
}

function isDriveRoot(dir) {
  return /^[a-z]:\\?$/.test(dir.toLowerCase());
}

function isInsideNodeModules(dir) {
  return /\\node_modules(\\|$)/i.test(dir);
}

function basenameOf(dir) {
  const normalized = normalizeDir(dir);
  if (!normalized) return null;
  const base = winPath.basename(normalized);
  return base || null;
}

function stripExeSuffix(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/\.(exe|com|bat|cmd)$/i, '');
}

/** 默认的目录读取实现：读不到（不存在 / 无权限）返回 null，绝不抛错。 */
export function defaultListDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 项目根识别
// ---------------------------------------------------------------------------

/** 目录里是否存在「这是项目根」的标志物。 */
function hasProjectMarker(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const files = new Set();
  const dirs = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    const lower = entry.name.toLowerCase();
    files.add(lower);
    if (entry.isDirectory) dirs.add(lower);
  }
  for (const marker of MARKER_NAMES) {
    if (files.has(marker)) return true;
  }
  for (const name of files) {
    if (name.endsWith('.csproj') || name.endsWith('.sln')) return true;
  }
  // 契约特例：index.html 且同级有 src/ 才算法前端项目根
  if (files.has('index.html') && dirs.has('src')) return true;
  return false;
}

/**
 * 从 startDir 向上找项目根，最多 MAX_ROOT_WALK 层、不越过盘符根。
 *
 * allowNodeModules=false 时忽略 node_modules 里的 package.json：
 * 命令行里出现 `D:\proj\node_modules\vite\bin\vite.js` 时，`node_modules\vite`
 * 也有 package.json，但项目是 `D:\proj`，不能让 npm 包冒充项目根。
 * （cwd 就落在 node_modules\dsh-pet 这种插件目录时仍然要能识别成 dsh-pet，
 *  所以 cwd / 父链这两级允许 node_modules 根。）
 */
function findMarkedRoot(startDir, deps, allowNodeModules = true) {
  let dir = normalizeDir(startDir);
  if (!dir) return null;
  for (let hop = 0; hop <= MAX_ROOT_WALK; hop += 1) {
    if (!dir) return null;
    const blockedNodeModules = !allowNodeModules && isInsideNodeModules(dir);
    if (!blockedNodeModules && !deps.isRejectedRoot(dir)) {
      const entries = deps.listDir(dir);
      if (entries && hasProjectMarker(entries)) return dir;
    }
    const parent = winPath.dirname(dir);
    if (!parent || parent === dir) return null;
    const next = normalizeDir(parent);
    if (!next || next === dir) return null;
    dir = next;
  }
  return null;
}

/**
 * 从命令行里抽绝对路径候选。
 * 覆盖：双引号包裹的路径、裸 `D:\...`、`--cwd=` / `--prefix=` / `-C` 之类参数值，
 * 以及「node_modules 之前的目录」（真正的项目目录）。
 */
export function extractPathCandidates(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine) return [];
  const found = [];
  const push = (raw) => {
    if (typeof raw !== 'string') return;
    let value = raw.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    const normalized = normalizeDir(value);
    if (!normalized) return;
    if (!found.includes(normalized)) found.push(normalized);
  };

  for (const match of commandLine.matchAll(/"([^"]{2,1024})"/g)) push(match[1]);
  for (const match of commandLine.matchAll(/(?:^|[\s=])([a-zA-Z]:\\[^\s"']{1,1024}|\\\\[^\s"']{1,1024})/g)) {
    push(match[1]);
  }
  for (const match of commandLine.matchAll(
    /(?:--cwd|--prefix|--project|--root|--dir|--working-directory|-C)\s*[= ]\s*("[^"]{2,512}"|\S{2,512})/gi,
  )) {
    push(match[1]);
  }
  return found;
}

function isSameOrInsideDir(candidate, ancestor) {
  const left = lowerDir(candidate);
  const right = lowerDir(ancestor);
  if (!left || !right) return false;
  return left === right || left.startsWith(right + '\\');
}

/** 把路径候选展开成「可能的项目起点目录」：路径本身、它的父目录、node_modules 之前的目录。 */
function expandPathStarts(candidates) {
  const starts = [];
  const add = (value) => {
    const normalized = normalizeDir(value);
    if (normalized && !starts.includes(normalized)) starts.push(normalized);
  };
  for (const candidate of candidates) {
    const nodeModulesIndex = candidate.toLowerCase().indexOf('\\node_modules\\');
    if (nodeModulesIndex > 2) add(candidate.slice(0, nodeModulesIndex));
    add(candidate);
    const parent = winPath.dirname(candidate);
    if (parent && parent !== candidate) add(parent);
  }
  return starts;
}

/** 目录名太泛时向上爬，得到「用户能看懂」的目录；系统目录 / dsh 运行时目录不算项目。 */
function softDirRoot(startDir, deps, maxHops = 3) {
  let dir = normalizeDir(startDir);
  if (!dir) return null;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (!dir || isDriveRoot(dir)) return null;
    if (deps.isSystemDir(dir) || deps.isRejectedRoot(dir)) return null;
    if (isInsideNodeModules(dir)) {
      // 爬出 node_modules：多半是某个项目的依赖目录
      const nodeModulesIndex = dir.toLowerCase().lastIndexOf('\\node_modules');
      const parent = nodeModulesIndex > 2 ? normalizeDir(dir.slice(0, nodeModulesIndex)) : null;
      if (!parent) return null;
      dir = parent;
      continue;
    }
    const base = basenameOf(dir);
    if (!base) return null;
    if (!GENERIC_DIR_NAMES.has(base.toLowerCase())) return dir;
    const parent = winPath.dirname(dir);
    if (!parent || parent === dir) return null;
    dir = normalizeDir(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// deps 装配（纯函数，所有外部输入都从 options 注入）
// ---------------------------------------------------------------------------

function makeDeps(options) {
  const env = isPlainObject(options.env) ? options.env : process.env;
  const rawListDir = typeof options.listDir === 'function' ? options.listDir : defaultListDir;
  const cache = new Map();
  const listDir = (dir) => {
    const key = dir.toLowerCase();
    if (!cache.has(key)) cache.set(key, rawListDir(dir));
    return cache.get(key);
  };

  const windir = normalizeDir(env.SystemRoot || env.WINDIR || 'C:\\Windows') || 'C:\\Windows';
  const dshHome = normalizeDir(options.dshHome || env.DSH_HOME);

  const systemDirs = [];
  const addSystemDir = (value) => {
    const normalized = lowerDir(value);
    if (normalized && !systemDirs.includes(normalized)) systemDirs.push(normalized);
  };
  addSystemDir(windir);
  addSystemDir('C:\\Program Files');
  addSystemDir('C:\\Program Files (x86)');
  addSystemDir('C:\\ProgramData');
  addSystemDir(env.TEMP);
  addSystemDir(env.TMP);
  const profile = normalizeDir(env.USERPROFILE);
  if (profile) {
    addSystemDir(profile);
    for (const sub of ['Desktop', 'Downloads', 'Documents', 'AppData', 'OneDrive', '桌面', '下载', '文档']) {
      addSystemDir(winPath.join(profile, sub));
    }
  }

  const isSystemDir = (dir) => {
    const lower = lowerDir(dir);
    if (lower === null) return true;
    if (/^[a-z]:\\?$/.test(lower)) return true;
    for (const prefix of systemDirs) {
      if (lower === prefix || lower.startsWith(prefix + '\\')) return true;
    }
    return false;
  };

  // dsh 自己的运行时目录：<DSH_HOME>\profiles\<name>（正好一层）以及 DSH_HOME 本身。
  // 这些不是用户项目；不这样排除的话，dsh 自身进程会归到「desktop」这种无意义的名字。
  const profilesPrefix = dshHome ? dshHome.toLowerCase() + '\\profiles\\' : null;
  const isRejectedRoot = (dir) => {
    if (!dshHome) return false;
    const lower = lowerDir(dir);
    if (lower === null) return false;
    if (lower === dshHome.toLowerCase()) return true;
    if (profilesPrefix && lower.startsWith(profilesPrefix)) {
      const rest = lower.slice(profilesPrefix.length);
      if (rest.length > 0 && !rest.includes('\\')) return true;
    }
    return false;
  };

  const workspaces = [];
  if (Array.isArray(options.workspaces)) {
    for (const entry of options.workspaces) {
      const rawPath = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry.path : null;
      const normalized = normalizeDir(rawPath);
      if (!normalized) continue;
      const title = isPlainObject(entry) && typeof entry.title === 'string' ? entry.title.trim() : '';
      workspaces.push({ path: normalized, lowerPath: normalized.toLowerCase(), title: title || null });
    }
  }

  const selfPids = new Set();
  if (Array.isArray(options.selfPids)) {
    for (const pid of options.selfPids) {
      const value = toInt(pid);
      if (value !== null && value > 0) selfPids.add(value);
    }
  }
  // 「同可执行文件 = dsh 自身」只对真正的宿主应用成立。宿主用 node / electron 跑起来时
  // （开发态 `node lib/index.js`、e2e 隔离实例），按 exe 匹配会把用户所有 node 开发服务器
  // 都标成受保护，必须忽略。
  const genericHostExe = /^(node|electron|bun|deno|python|pythonw|cmd|powershell|pwsh)(\.exe)?$/;
  const rawSelfExe = lowerDir(options.selfExe);
  const selfExeLower = rawSelfExe && !genericHostExe.test(rawSelfExe.split('\\').pop()) ? rawSelfExe : null;
  const webServerPorts = new Set();
  if (Array.isArray(options.webServerPorts)) {
    for (const port of options.webServerPorts) {
      const value = toInt(port);
      if (value !== null && value > 0) webServerPorts.add(value);
    }
  }

  return { listDir, windir, isSystemDir, isRejectedRoot, workspaces, selfPids, selfExeLower, webServerPorts };
}

// ---------------------------------------------------------------------------
// 单条端口的归属判定
// ---------------------------------------------------------------------------

function makeProject(root, source, name) {
  const normalized = normalizeDir(root);
  if (!normalized) return null;
  return {
    key: normalized,
    name: name || basenameOf(normalized) || normalized,
    root: normalized,
    source,
  };
}

/** 证据强度排序（越小越可信），用于「一个项目组里多个端口来源不同」时取最强的一级。 */
const PROJECT_SOURCE_RANK = {
  cwd: 0,
  cmdline: 1,
  parent: 2,
  workspace: 3,
  'app-dir': 4,
  'image-dir': 5,
  system: 8,
  none: 9,
};

/** 所有「归不到项目」的 Windows 系统进程共用的分组（面板里排最后）。 */
const WINDOWS_SYSTEM_PROJECT = { key: 'system', name: 'Windows 系统', root: null, source: 'system' };

/** dsh 自身进程在视图里的显示名（key/root 不变，仍指向安装目录）。 */
const DSH_SELF_PROJECT_NAME = 'DeepSeek Harness（本界面）';

function projectSourceRank(source) {
  const rank = PROJECT_SOURCE_RANK[source];
  return typeof rank === 'number' ? rank : 9;
}

/** 按契约 §5.3 的优先级给一个进程找项目；都失败返回 null。 */
function resolveProject(proc, ctx) {
  const { deps } = ctx;
  const exeDir = proc.exe ? normalizeDir(winPath.dirname(normalizeDir(proc.exe) || proc.exe)) : null;

  // 1) cwd 直接落在项目里
  if (proc.cwd) {
    const root = findMarkedRoot(proc.cwd, deps, true);
    const project = root ? makeProject(root, 'cwd') : null;
    if (project) return project;
  }

  // 2) 命令行里的绝对路径（npm 包 / node_modules 里的文件靠这里跳出）
  const cmdCandidates = extractPathCandidates(proc.cmdLine);
  if (cmdCandidates.length > 0) {
    for (const start of expandPathStarts(cmdCandidates)) {
      // 落在本进程 exe 自己的安装目录里的路径 = 应用自带的资源/运行时，不是用户项目。
      // （典型：Electron 应用的 resources\app.asar\... 与 resources\runtime\...，
      //   不排除的话 dsh 自身会被它自带的 pnpm 目录冒充成项目 "pnpm"。）
      if (exeDir && isSameOrInsideDir(start, exeDir)) continue;
      const root = findMarkedRoot(start, deps, false);
      const project = root ? makeProject(root, 'cmdline') : null;
      if (project) return project;
    }
  }

  // 3) 父链：cwd 读不到时，沿 ppid 向上找第一个有 cwd 的祖先
  let cursor = proc;
  for (let hop = 0; hop < MAX_PARENT_WALK; hop += 1) {
    const parent = ctx.procsByPid.get(cursor.ppid);
    if (!parent) break;
    if (parent.cwd) {
      const root = findMarkedRoot(parent.cwd, deps, true);
      const project = root ? makeProject(root, 'parent') : null;
      if (project) return project;
    }
    cursor = parent;
  }

  // 4) DSH 工作区表：拿所有路径证据去和登记的绝对路径做最长前缀匹配
  const pathEvidence = [];
  const pushEvidence = (value) => {
    const normalized = normalizeDir(value);
    if (!normalized || deps.isRejectedRoot(normalized)) return;
    if (!pathEvidence.includes(normalized)) pathEvidence.push(normalized);
  };
  pushEvidence(proc.cwd);
  for (const candidate of cmdCandidates) pushEvidence(candidate);
  const exeDirEvidence = proc.exe ? normalizeDir(winPath.dirname(normalizeDir(proc.exe) || proc.exe)) : null;
  if (exeDirEvidence) pushEvidence(exeDirEvidence);
  for (const candidate of pathEvidence) {
    const lower = candidate.toLowerCase();
    for (const workspace of deps.workspaces) {
      if (lower === workspace.lowerPath || lower.startsWith(workspace.lowerPath + '\\')) {
        const project = makeProject(workspace.path, 'workspace', workspace.title);
        if (project) return project;
      }
    }
  }

  // 5) 进程所在目录：没有项目标志物时，用 cwd / exe 目录当「应用目录」
  //    （装好就常驻的桌面程序、代理内核、本地服务都靠这一级）
  //    名字统一取目录 basename，保证同一目录无论从 cwd 还是 exe 命中都得到同一个组名。
  if (proc.cwd) {
    const root = softDirRoot(proc.cwd, deps);
    const project = root ? makeProject(root, 'app-dir') : null;
    if (project) return project;
  }
  if (exeDir) {
    const root = softDirRoot(exeDir, deps);
    const project = root ? makeProject(root, 'app-dir') : null;
    if (project) return project;
  }

  // 6) 同名 exe 所在目录：身份信息全被权限挡住时（SYSTEM 启动的服务进程），
  //    去其它已知进程的 exe 目录里找同名可执行文件，命中即认为是同一个应用
  if (proc.name) {
    const target = proc.name.toLowerCase();
    for (const dir of ctx.knownExeDirs) {
      const entries = deps.listDir(dir);
      if (!entries) continue;
      if (entries.some((entry) => typeof entry.name === 'string' && entry.name.toLowerCase() === target)) {
        const project = makeProject(dir, 'image-dir');
        if (project) return project;
      }
    }
  }

  return null;
}

/** 没有项目证据时的兜底（契约 §5.3 第 5 条：不静默丢弃）。 */
function unknownProject(proc, pid) {
  const name = proc && proc.name ? proc.name : `PID ${pid}`;
  return { key: `unknown:${pid}`, name, root: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// 分类 / 保护标注
// ---------------------------------------------------------------------------

function isSystemProcess(proc, deps) {
  if (!proc) return false;
  if (proc.pid <= 4) return true;
  const name = stripExeSuffix(proc.name || '').toLowerCase();
  if (name && SYSTEM_PROCESS_NAMES.has(name)) return true;
  const exe = lowerDir(proc.exe);
  if (exe && (exe === deps.windir.toLowerCase() || exe.startsWith(deps.windir.toLowerCase() + '\\'))) return true;
  return false;
}

/** kind 粗分类（契约 §5.4）。 */
function classifyKind(proc, port, isSystem) {
  if (isSystem) return 'system';
  if (!proc) return 'unknown';
  const name = (proc.name || '').toLowerCase();
  const cmdLine = proc.cmdLine || '';
  if (DATABASE_PORTS.has(port)) return 'database';
  if (DOCKER_NAME_PATTERN.test(name)) return 'docker';
  if (PYTHON_NAME_PATTERN.test(name) || PYTHON_CMD_PATTERN.test(cmdLine)) return 'python';
  if (JAVA_NAME_PATTERN.test(name)) return 'java';
  if (DOTNET_NAME_PATTERN.test(name)) return 'dotnet';
  if (DEV_SERVER_NAME_PATTERN.test(name) || DEV_SERVER_CMD_PATTERN.test(cmdLine)) return 'dev-server';
  if (name) return 'app';
  return 'unknown';
}

/**
 * 保护标注（契约 §6 的只读镜像；lib/index.js 的 applySafety 会用宿主上下文再判一次）。
 *
 * reason 用稳定的短错误码，和 lib/index.js 的 protectionOf() 保持同一套词表，
 * UI 可以直接按字符串匹配（例如 protectedReason === 'dsh-self' 显示「dsh 自身」徽标）：
 *   dsh-self | dsh-ui-port | system-pid | system-process | system-directory | opaque-process
 *
 * @returns {{protected: boolean, system: boolean, opaque: boolean, reason: string|null}}
 */
function protectionOf(proc, port, ctx) {
  if (!proc) {
    // 连进程信息都拿不到：无法核对身份，按最保守处理
    return { protected: true, system: false, opaque: true, reason: 'opaque-process' };
  }
  const isSystem = isSystemProcess(proc, ctx.deps);
  // 读不到 exe 也读不到命令行：基本是 SYSTEM 账户或提权启动的服务进程
  const opaque = !proc.exe && !proc.cmdLine;
  if (proc.pid <= 4) {
    return { protected: true, system: true, opaque: false, reason: 'system-pid' };
  }
  const name = stripExeSuffix(proc.name || '').toLowerCase();
  if (name && SYSTEM_PROCESS_NAMES.has(name)) {
    return { protected: true, system: true, opaque, reason: 'system-process' };
  }
  const exe = lowerDir(proc.exe);
  if (exe && (exe === ctx.deps.windir.toLowerCase() || exe.startsWith(ctx.deps.windir.toLowerCase() + '\\'))) {
    return { protected: true, system: true, opaque: false, reason: 'system-directory' };
  }
  if (ctx.deps.selfPids.has(proc.pid)) {
    return { protected: true, system: isSystem, opaque, reason: 'dsh-self' };
  }
  if (ctx.deps.selfExeLower && exe && exe === ctx.deps.selfExeLower) {
    return { protected: true, system: isSystem, opaque, reason: 'dsh-self' };
  }
  if (ctx.deps.webServerPorts.has(port)) {
    return { protected: true, system: isSystem, opaque, reason: 'dsh-ui-port' };
  }
  if (opaque) {
    return { protected: true, system: isSystem, opaque: true, reason: 'opaque-process' };
  }
  return { protected: false, system: isSystem, opaque: false, reason: null };
}

/** dsh 自身进程：宿主 pid 树命中，或与宿主可执行文件相同。 */
function isDshSelfProcess(proc, ctx) {
  if (!proc) return false;
  if (ctx.deps.selfPids.has(proc.pid)) return true;
  const exe = lowerDir(proc.exe);
  return !!(exe && ctx.deps.selfExeLower && exe === ctx.deps.selfExeLower);
}

/** 沿父链往上看，是否直接由 Windows 服务控制环境（services.exe / wininit.exe）拉起。 */
function hasServiceAncestor(proc, procsByPid) {
  if (!proc) return false;
  let cursor = proc;
  for (let hop = 0; hop < 6; hop += 1) {
    const parent = procsByPid.get(cursor.ppid);
    if (!parent) return false;
    const name = stripExeSuffix(parent.name || '').toLowerCase();
    if (name === 'services' || name === 'wininit') return true;
    cursor = parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 绑定地址
// ---------------------------------------------------------------------------

function bareAddress(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
}

function isWildcardAddress(address) {
  const bare = bareAddress(address);
  return bare === '0.0.0.0' || bare === '::' || bare === '0:0:0:0:0:0:0:0' || bare === '*';
}

function isLoopbackAddress(address) {
  const bare = bareAddress(address);
  return bare === '::1' || /^127\./.test(bare);
}

/** 绑定地址排序：越具体越前（127.0.0.1 → ::1 → 其它具体地址 → 0.0.0.0 → [::]）。 */
function bindingRank(address) {
  const bare = bareAddress(address);
  if (/^127\./.test(bare)) return 0;
  if (bare === '::1') return 1;
  if (bare === '0.0.0.0') return 3;
  if (bare === '::' || bare === '0:0:0:0:0:0:0:0' || bare === '*') return 4;
  return 2;
}

function sortBindings(bindings) {
  return [...bindings].sort((left, right) => {
    const rankDiff = bindingRank(left) - bindingRank(right);
    if (rankDiff !== 0) return rankDiff;
    return String(left).localeCompare(String(right));
  });
}

// ---------------------------------------------------------------------------
// 原始进程记录归一化
// ---------------------------------------------------------------------------

function normalizeRawProcess(raw) {
  const pid = toInt(raw.pid);
  if (pid === null || pid <= 0) return null;
  const ppid = toInt(raw.ppid);
  return {
    pid,
    ppid: ppid === null ? 0 : ppid,
    name: typeof raw.name === 'string' && raw.name ? raw.name : null,
    exe: typeof raw.exe === 'string' && raw.exe ? raw.exe : null,
    cmdLine: typeof raw.cmdLine === 'string' && raw.cmdLine ? raw.cmdLine : null,
    startedAt: typeof raw.startedAt === 'string' && raw.startedAt ? raw.startedAt : null,
    startedMs: parseTime(raw.startedAt),
    workingSetBytes: Number.isFinite(raw.workingSetBytes) ? raw.workingSetBytes : 0,
    cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : null,
  };
}

/**
 * 父进程是否还在。
 * 除了「不在进程表里」，还挡 PID 复用：父进程的启动时间晚于子进程，
 * 说明这个 pid 已经被系统分配给别的进程了，不能当成父进程。
 */
function detectOrphan(proc, procsByPid) {
  if (!proc || proc.ppid === 0) return { orphan: false, reason: null };
  const parent = procsByPid.get(proc.ppid);
  if (!parent) return { orphan: true, reason: '父进程已退出' };
  if (parent.startedMs !== null && proc.startedMs !== null && parent.startedMs > proc.startedMs + 1000) {
    return { orphan: true, reason: '父进程 PID 已被复用（父进程比它更晚启动）' };
  }
  return { orphan: false, reason: null };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 把 lib/snapshot.ps1 的原始快照变成 GET /api/port-viewer/snapshot 的响应体。
 *
 * @param {object} rawSnapshot §5.1 的原始快照
 * @param {object} [options]   见文件头注释
 * @returns {object} §5.4 视图
 */
export function buildPortView(rawSnapshot, options = {}) {
  const settings = isPlainObject(options) ? options : {};
  const nowMs = typeof settings.now === 'number' && Number.isFinite(settings.now) ? settings.now : Date.now();
  const deps = makeDeps(settings);
  const raw = isPlainObject(rawSnapshot) ? rawSnapshot : {};
  const warnings = [];
  const extraWarnings = Array.isArray(settings.extraWarnings) ? settings.extraWarnings : [];

  const rawProcesses = Array.isArray(raw.processes) ? raw.processes : [];
  const rawListeners = Array.isArray(raw.listeners) ? raw.listeners : [];
  if (!Array.isArray(raw.listeners)) warnings.push('快照里没有 listeners 数组，端口列表为空');
  if (!Array.isArray(raw.processes)) warnings.push('快照里没有 processes 数组，项目归属与「遗留」判定已降级');
  else if (rawListeners.length > 0 && rawProcesses.length === 0) {
    warnings.push('快照里没有进程信息，项目归属与「遗留」判定已降级');
  }
  if (Array.isArray(raw.errors)) {
    for (const item of raw.errors) {
      if (typeof item === 'string' && item) warnings.push(`采集脚本报告：${item}`);
    }
  }

  const procsByPid = new Map();
  for (const rawProcess of rawProcesses) {
    if (!isPlainObject(rawProcess)) continue;
    const proc = normalizeRawProcess(rawProcess);
    if (proc) procsByPid.set(proc.pid, proc);
  }

  // 供「同名 exe 所在目录」这一级使用：其它进程的 exe 目录
  const knownExeDirs = [];
  for (const proc of procsByPid.values()) {
    if (!proc.exe) continue;
    const exeDir = normalizeDir(winPath.dirname(normalizeDir(proc.exe) || proc.exe));
    if (!exeDir || deps.isSystemDir(exeDir) || deps.isRejectedRoot(exeDir)) continue;
    if (!knownExeDirs.includes(exeDir)) knownExeDirs.push(exeDir);
    if (knownExeDirs.length >= 48) break;
  }

  const ctx = { deps, procsByPid, knownExeDirs };

  // 同一 (port, pid) 的多个绑定合并；同端口不同 PID 保持多条（契约 §5.4）。
  const buckets = new Map();
  for (const listener of rawListeners) {
    if (!isPlainObject(listener)) continue;
    const port = toInt(listener.port);
    const pid = toInt(listener.pid);
    if (port === null || port <= 0) continue;
    const bucketKey = `${port}|${pid === null ? 'null' : pid}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { port, pid, protocol: typeof listener.protocol === 'string' ? listener.protocol : 'TCP', bindings: [] };
      buckets.set(bucketKey, bucket);
    }
    const address = typeof listener.localAddress === 'string' ? listener.localAddress : null;
    if (address && !bucket.bindings.includes(address)) bucket.bindings.push(address);
  }

  const ports = [];
  let cwdMissing = 0;
  let unresolved = 0;
  let procMissing = 0;

  for (const bucket of buckets.values()) {
    const proc = bucket.pid === null ? null : procsByPid.get(bucket.pid) || null;
    if (bucket.pid !== null && !proc) procMissing += 1;
    if (proc && !proc.cwd) cwdMissing += 1;

    const protection = protectionOf(proc, bucket.port, ctx);
    // Windows 系统进程的父进程本来就早已退出（smss 起完就退、服务由 services.exe 接管），
    // 那不是「agent 跑完忘了关」的遗留，别在 UI 里把 wininit / lsass 标成「遗留」。
    const orphanInfo = protection.system
      ? { orphan: false, reason: null }
      : detectOrphan(proc, procsByPid);
    let project = (proc ? resolveProject(proc, ctx) : null) || unknownProject(proc, bucket.pid);

    // dsh 自己的进程：项目名字换成用户能看懂的名字，key/root 保持不变（不影响别的分组）。
    if (project.source !== 'none' && isDshSelfProcess(proc, ctx)) {
      project = { ...project, name: DSH_SELF_PROJECT_NAME };
    }

    // 「归不到项目 + 是 Windows 系统进程」统一并到一个组，别让 svchost × 5 / System × 2
    // 在面板里各占一行。非系统的未识别进程仍然按 pid 分组（可能是用户自己起的脚本）。
    // 读不到 exe/cmd 但由 services.exe 拉起的（spoolsv 之类）也算 Windows 服务。
    const windowsSystem =
      protection.system || (protection.opaque && hasServiceAncestor(proc, procsByPid));
    if (project.source === 'none' && windowsSystem) project = { ...WINDOWS_SYSTEM_PROJECT };
    if (project.source === 'none') unresolved += 1;

    const bindings = sortBindings(bucket.bindings);
    const wildcard = bindings.some((address) => isWildcardAddress(address));
    const loopbackOnly = bindings.length > 0 && bindings.every((address) => isLoopbackAddress(address));
    const kind = classifyKind(proc, bucket.port, protection.system);

    ports.push({
      port: bucket.port,
      protocol: bucket.protocol,
      bindings,
      pid: bucket.pid,
      processName: proc && proc.name ? proc.name : null,
      // 契约：视图里必须带 exePath，lib/index.js 的安全闸门靠它判系统目录 / dsh 自身进程
      exePath: proc && proc.exe ? proc.exe : null,
      commandLine: proc && proc.cmdLine ? proc.cmdLine : null,
      cwd: proc && proc.cwd ? proc.cwd : null,
      startedAt: proc && proc.startedAt ? proc.startedAt : null,
      uptimeMs:
        proc && proc.startedMs !== null && proc.startedMs !== undefined
          ? Math.max(0, nowMs - proc.startedMs)
          : null,
      workingSetBytes: proc ? proc.workingSetBytes : 0,
      url: HTTP_KINDS.has(kind) ? `http://127.0.0.1:${bucket.port}/` : null,
      project,
      kind,
      flags: {
        orphan: orphanInfo.orphan,
        system: protection.system,
        protected: protection.protected,
        wildcard,
        loopbackOnly,
        // 读不到 exe / 命令行（SYSTEM 账户或提权启动）：lib/index.js 的安全闸门可以据此保守处理
        opaque: protection.opaque,
      },
      orphanReason: orphanInfo.reason,
      protectedReason: protection.reason,
      killable: !protection.protected,
    });
  }

  ports.sort((left, right) => left.port - right.port || (left.pid || 0) - (right.pid || 0));

  // 按项目聚合
  const groups = new Map();
  for (const entry of ports) {
    const groupKey = entry.project.key.toLowerCase();
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: entry.project.key,
        name: entry.project.name,
        root: entry.project.root,
        source: entry.project.source,
        sourceRank: projectSourceRank(entry.project.source),
        portCount: 0,
        ports: [],
        killableCount: 0,
        protectedCount: 0,
        orphanCount: 0,
      };
      groups.set(groupKey, group);
    }
    // 同一项目里的端口可能来自不同证据级别，组上记录最可信的那一级
    const rank = projectSourceRank(entry.project.source);
    if (rank < group.sourceRank) {
      group.sourceRank = rank;
      group.source = entry.project.source;
    }
    group.portCount += 1;
    if (!group.ports.includes(entry.port)) group.ports.push(entry.port);
    if (entry.killable) group.killableCount += 1;
    if (entry.flags.protected) group.protectedCount += 1;
    if (entry.flags.orphan) group.orphanCount += 1;
  }
  const projects = [...groups.values()];
  for (const group of projects) {
    group.ports.sort((left, right) => left - right);
    delete group.sourceRank;
  }
  // 分组顺序：遗留端口 → 用户项目 → Windows 系统。
  // panel 可以直接按这个顺序渲染，不用自己再排一遍。
  const systemLast = (group) => (group.source === 'system' ? 1 : 0);
  projects.sort(
    (left, right) =>
      systemLast(left) - systemLast(right) ||
      right.orphanCount - left.orphanCount ||
      right.killableCount - left.killableCount ||
      right.portCount - left.portCount ||
      String(left.name).localeCompare(String(right.name), 'zh-Hans-CN'),
  );

  if (procMissing > 0) warnings.push(`${procMissing} 个端口读不到所属进程信息`);
  if (cwdMissing > 0) warnings.push(`${cwdMissing} 个监听进程读不到工作目录（系统进程或更高权限进程属正常）`);
  if (unresolved > 0) warnings.push(`${unresolved} 个端口未能识别所属项目，已归入「未识别项目」`);
  for (const warning of extraWarnings) {
    if (typeof warning === 'string' && warning) warnings.push(warning);
  }

  const orphanCount = ports.filter((entry) => entry.flags.orphan).length;
  const protectedCount = ports.filter((entry) => entry.flags.protected).length;

  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    generatedAt:
      typeof raw.generatedAt === 'string' && raw.generatedAt ? raw.generatedAt : new Date(nowMs).toISOString(),
    durationMs: toInt(settings.durationMs) === null ? 0 : Math.max(0, toInt(settings.durationMs)),
    ports,
    projects,
    stats: {
      portCount: ports.length,
      projectCount: projects.length,
      orphanCount,
      protectedCount,
    },
    warnings,
    // 附加字段（契约之外，供 index.js 排障用，不影响 §5.4 消费方）
    timings: isPlainObject(raw.timingsMs) ? raw.timingsMs : null,
  };
}

export default buildPortView;
