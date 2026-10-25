/**
 * dsh-port-viewer — Host 侧采集入口（docs/CONTRACT.md §5.2）。
 *
 * 职责很窄：拉起一次 Windows PowerShell 跑 lib/snapshot.ps1，读回那份 UTF-8 无 BOM 的
 * 原始快照 JSON，然后交给 lib/projects.js 完成「端口 → 项目」推断，返回 §5.4 的视图。
 *
 * 约定（Lead 的 lib/index.js 依赖）：
 *   const r = await collectSnapshot({ timeoutMs, includeCwd: true });
 *   r.ok === true  →  r.snapshot / r.view  是 §5.4 视图
 *   r.ok === false →  { ok:false, code, error }  code ∈ script-missing | spawn | timeout | exit | no-output | parse
 *
 * 全程零依赖：只用 node: 内置模块。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPortView } from './projects.js';

/** collector 自身版本，跟着采集契约走（1 = CONTRACT.md §5）。 */
export const COLLECT_VERSION = 1;

/** 默认超时：契约 §5.2 的 15000ms。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** 采集脚本位置（同目录下的 snapshot.ps1）。 */
export const SCRIPT_PATH = fileURLToPath(new URL('./snapshot.ps1', import.meta.url));

/** stderr 只保留尾巴，够定位问题即可。 */
const STDERR_TAIL_BYTES = 4096;

/** 子进程额外参数（契约 §5.2 指定）。 */
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

function toInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return fallback;
}

function tail(text, max = STDERR_TAIL_BYTES) {
  if (typeof text !== 'string' || !text) return '';
  return text.length <= max ? text : text.slice(text.length - max);
}

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function fail(code, error, details) {
  const result = { ok: false, code, error };
  if (details !== undefined) result.details = details;
  return result;
}

/**
 * 候选 powershell.exe：**先用 %SystemRoot% 的绝对路径**。
 *
 * 裸命令名走 PATH，而 PATH 里任何可写目录（`%APPDATA%\npm` 之类）都能塞一个同名程序
 * 劫持这次调用 —— 它是以 dsh 用户的身份执行的。PATH 只作为最后的退路。
 */
function powershellCandidates(options) {
  if (typeof options.powershellPath === 'string' && options.powershellPath) return [options.powershellPath];
  const sysRoot = (options.env && options.env.SystemRoot) || process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return [
    join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ];
}

/** 超时 kill 之后，再等这么久仍未拿到 close 就强行给结论（避免 inFlight 永挂）。 */
const KILL_DEADLINE_MS = 3000;

/**
 * 跑一次 powershell，等到退出为止。
 * 超时就 kill 掉，并额外 taskkill /T 兜住子进程树（netstat / WmiPrvSE 由 PS 拉起）。
 */
function runPowershell(executable, args, timeoutMs, spawnImpl, options = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
      });
    } catch (error) {
      resolvePromise({ spawnError: error });
      return;
    }

    let stderrText = '';
    let stdoutText = '';
    let settled = false;
    let timedOut = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 进程可能已经退出 */
      }
      try {
        const killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        if (killer && typeof killer.unref === 'function') killer.unref();
      } catch {
        /* 兜底失败无所谓，主进程已经收到 kill */
      }
      // 二次截止：万一 close 一直不来（句柄被子进程继承、taskkill 也失败），
      // 也不能让 inFlight 永远挂着 —— 那会让之后所有快照/kill 请求一起等死。
      setTimeout(() => {
        finish({ code: null, signal: null, timedOut: true, stderr: tail(stderrText), stdout: tail(stdoutText) });
      }, KILL_DEADLINE_MS).unref?.();
    }, Math.max(1000, timeoutMs));

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        if (stdoutText.length < STDERR_TAIL_BYTES) stdoutText += String(chunk);
      });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        stderrText += String(chunk);
        if (stderrText.length > STDERR_TAIL_BYTES * 2) stderrText = tail(stderrText);
      });
    }

    child.on('error', (error) => {
      finish({ spawnError: error, stderr: stderrText, stdout: stdoutText });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, timedOut, stderr: tail(stderrText), stdout: tail(stdoutText) });
    });
  });
}

/**
 * 定位 DSH 数据根。
 *
 * 优先 options.dshHome / $DSH_HOME；都没有时从「xx\profiles\<name>」这种目录反推
 * （先看宿主自己的 cwd，再看快照里进程的 cwd）。原因：<DSH_HOME>\profiles\<name>
 * 是 dsh 自己的运行时目录，lib/projects.js 靠 dshHome 把它排除在「项目根」之外，
 * 少了这个信息 dsh 自身会被归到「desktop」这种无意义的名字。
 */
function resolveDshHome(options, rawSnapshot) {
  const explicit =
    (typeof options.dshHome === 'string' && options.dshHome) ||
    (options.env && options.env.DSH_HOME) ||
    process.env.DSH_HOME;
  if (explicit) return explicit;

  const fromProfileDir = (value) => {
    if (typeof value !== 'string' || !value) return null;
    const normalized = value.replace(/\//g, '\\').replace(/\\+$/, '');
    const match = /^(.*)\\profiles\\[^\\]+$/i.exec(normalized);
    return match && match[1] ? match[1] : null;
  };

  const fromHostCwd = fromProfileDir(process.cwd());
  if (fromHostCwd) return fromHostCwd;

  const seen = new Map();
  const processes = rawSnapshot && Array.isArray(rawSnapshot.processes) ? rawSnapshot.processes : [];
  for (const entry of processes) {
    if (!entry || typeof entry.cwd !== 'string') continue;
    const home = fromProfileDir(entry.cwd);
    if (home) seen.set(home.toLowerCase(), home);
  }
  if (seen.size === 1) return [...seen.values()][0];
  return null;
}

/** 读 DSH 工作区表（<DSH_HOME>/storages/workspace.json），读不到就跳过（契约 §5.3 第 4 条）。 */
async function readDshWorkspaces(options) {
  const result = { workspaces: [], warning: null };
  if (Array.isArray(options.workspaces)) {
    result.workspaces = options.workspaces;
    return result;
  }
  const dshHome =
    (typeof options.dshHome === 'string' && options.dshHome) ||
    (options.env && options.env.DSH_HOME) ||
    process.env.DSH_HOME;
  if (!dshHome) return result;
  const file = typeof options.workspaceFile === 'string' && options.workspaceFile
    ? options.workspaceFile
    : join(dshHome, 'storages', 'workspace.json');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return result; // 没有工作区表是很正常的情况
    result.warning = `读取 DSH 工作区表失败（${file}）：${error && error.message ? error.message : error}`;
    return result;
  }
  try {
    const parsed = JSON.parse(stripBom(text));
    const table = parsed && parsed.tables && parsed.tables.workspaces;
    if (table && typeof table === 'object') {
      for (const value of Object.values(table)) {
        if (!value || typeof value.path !== 'string' || !value.path) continue;
        result.workspaces.push({
          path: value.path,
          title: typeof value.title === 'string' ? value.title : null,
        });
      }
    }
  } catch (error) {
    result.warning = `DSH 工作区表不是合法 JSON（${file}）：${error && error.message ? error.message : error}`;
  }
  return result;
}

/**
 * 计算 dsh 自身进程树：宿主 pid + 它在进程表里的所有祖先 + 同可执行文件的进程
 * （Electron 主进程 / 单实例复用会表现为多个同 exe 的进程，契约 §6）。
 */
function computeSelfContext(rawSnapshot, options) {
  const selfPids = new Set();
  const selfPid = toInt(process.pid, null);
  if (selfPid !== null) selfPids.add(selfPid);

  const processes = Array.isArray(rawSnapshot.processes) ? rawSnapshot.processes : [];
  const byPid = new Map();
  for (const entry of processes) {
    if (!entry || typeof entry !== 'object') continue;
    const pid = toInt(entry.pid, null);
    if (pid === null) continue;
    byPid.set(pid, entry);
  }

  // 宿主自己的祖先链
  let cursor = byPid.get(selfPid);
  for (let hop = 0; hop < 16 && cursor; hop += 1) {
    const ppid = toInt(cursor.ppid, 0);
    if (ppid <= 0) break;
    selfPids.add(ppid);
    cursor = byPid.get(ppid);
  }

  // 同 exe 的进程（Electron 主进程 / 复用实例）。只在宿主 exe 不是通用解释器时才做：
  // 用 `node lib/index.js` 这种方式跑起来的宿主，process.execPath 是 node.exe，
  // 按 exe 匹配会把用户所有 node 开发服务器都误标成「dsh 自身、受保护」。
  const selfExe =
    (typeof options.selfExe === 'string' && options.selfExe) || process.execPath || null;
  const selfExeName = selfExe ? selfExe.split(/[\\/]/).pop().toLowerCase() : '';
  const genericRuntimeExe = new Set([
    'node.exe',
    'node',
    'electron.exe',
    'bun.exe',
    'deno.exe',
    'python.exe',
    'pythonw.exe',
    'cmd.exe',
    'powershell.exe',
    'pwsh.exe',
  ]);
  if (selfExe && !genericRuntimeExe.has(selfExeName)) {
    const normalizedSelfExe = selfExe.toLowerCase().replace(/\//g, '\\');
    for (const entry of processes) {
      if (!entry || typeof entry.exe !== 'string' || !entry.exe) continue;
      if (entry.exe.toLowerCase().replace(/\//g, '\\') !== normalizedSelfExe) continue;
      const pid = toInt(entry.pid, null);
      if (pid !== null) selfPids.add(pid);
    }
  }

  if (Array.isArray(options.selfPids)) {
    for (const pid of options.selfPids) {
      const value = toInt(pid, null);
      if (value !== null) selfPids.add(value);
    }
  }

  const webServerPorts = [];
  if (Array.isArray(options.webServerPorts)) {
    for (const port of options.webServerPorts) {
      const value = toInt(port, null);
      if (value !== null) webServerPorts.push(value);
    }
  }

  return { selfPids: [...selfPids], selfExe, webServerPorts };
}

/**
 * 只跑采集、不做推断。调试 / 排障用，也方便单测单独验证原始快照。
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs=15000]
 * @param {boolean} [options.includeCwd=true]   false 时传 -SkipCwd（跳过 PEB 读取）
 * @param {string} [options.scriptPath]         覆盖 snapshot.ps1 位置
 * @param {string} [options.powershellPath]     覆盖 powershell.exe
 * @param {string} [options.env]                环境变量表（默认 process.env）
 * @param {string} [options.outFile]            自己指定临时文件（默认系统临时目录）
 * @param {Function} [options.spawnImpl]        测试注入的 spawn（默认 node:child_process.spawn）
 * @returns {Promise<{ok:boolean, raw?:object, timings?:object, code?:string, error?:string, details?:object}>}
 */
export async function collectRawSnapshot(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const timeoutMs = toInt(settings.timeoutMs, DEFAULT_TIMEOUT_MS);
  const includeCwd = settings.includeCwd !== false;
  const spawnImpl = typeof settings.spawnImpl === 'function' ? settings.spawnImpl : spawn;
  const scriptPath = settings.scriptPath ? resolve(String(settings.scriptPath)) : SCRIPT_PATH;
  if (!existsSync(scriptPath)) {
    return fail('script-missing', `找不到采集脚本：${scriptPath}（插件安装不完整？）`, { scriptPath });
  }

  let workDir;
  let outFile;
  let keepOutFile = false;
  if (settings.outFile) {
    outFile = resolve(String(settings.outFile));
    keepOutFile = true;
  } else {
    try {
      workDir = await mkdtemp(join(tmpdir(), 'dsh-port-viewer-'));
      outFile = join(workDir, 'snapshot.json');
    } catch (error) {
      return fail('temp-dir', `无法创建临时目录：${error && error.message ? error.message : error}`);
    }
  }

  const cleanup = async () => {
    if (keepOutFile) return;
    try {
      if (workDir) await rm(workDir, { recursive: true, force: true });
      else await unlink(outFile);
    } catch {
      /* 清理失败不影响结果 */
    }
  };

  try {
    const args = [...POWERSHELL_ARGS, scriptPath, '-OutFile', outFile];
    if (!includeCwd) args.push('-SkipCwd');

    let lastError = null;
    let run = null;
    for (const executable of powershellCandidates(settings)) {
      run = await runPowershell(executable, args, timeoutMs, spawnImpl, { cwd: workDir });
      if (run.spawnError) {
        lastError = run.spawnError;
        if (run.spawnError.code === 'ENOENT' || run.spawnError.code === 'EACCES') continue;
        return fail('spawn', `无法启动 PowerShell（${executable}）：${run.spawnError.message}`, {
          executable,
          code: run.spawnError.code || null,
        });
      }
      lastError = null;
      break;
    }
    if (!run || lastError) {
      return fail('spawn', `找不到可用的 powershell.exe：${lastError ? lastError.message : '未知原因'}`);
    }
    if (run.timedOut) {
      return fail('timeout', `采集超时（>${timeoutMs}ms），已终止 PowerShell`, {
        timeoutMs,
        stderr: run.stderr || '',
      });
    }
    if (run.code !== 0) {
      return fail('exit', `采集脚本退出码 ${run.code}`, {
        exitCode: run.code,
        signal: run.signal || null,
        stderr: run.stderr || '',
      });
    }

    let text;
    try {
      text = await readFile(outFile, 'utf8');
    } catch (error) {
      return fail('no-output', `采集脚本没有产出快照文件：${outFile}`, {
        stderr: run.stderr || '',
        cause: error && error.message ? error.message : String(error),
      });
    }
    if (!text || !text.trim()) {
      return fail('no-output', '采集脚本产出的快照文件是空的', { stderr: run.stderr || '' });
    }

    let raw;
    try {
      raw = JSON.parse(stripBom(text));
    } catch (error) {
      return fail('parse', `快照 JSON 解析失败：${error && error.message ? error.message : error}`, {
        bytes: text.length,
        head: text.slice(0, 200),
      });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail('parse', '快照 JSON 顶层不是对象', { head: text.slice(0, 200) });
    }
    if (!Array.isArray(raw.listeners)) raw.listeners = [];
    if (!Array.isArray(raw.processes)) raw.processes = [];

    return { ok: true, raw, timings: raw.timingsMs || null, outFile: keepOutFile ? outFile : null };
  } finally {
    await cleanup();
  }
}

/**
 * 采集 + 推断，返回 §5.4 视图（契约 §5.2）。
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs=15000]
 * @param {boolean} [options.includeCwd=true]
 * @param {string} [options.scriptPath] / [options.powershellPath] / [options.env]
 * @param {string} [options.dshHome]         DSH 数据根（默认 $DSH_HOME）
 * @param {string} [options.workspaceFile]   DSH 工作区表路径
 * @param {Array}  [options.workspaces]      直接给工作区列表（[{path,title}]，跳过读文件）
 * @param {number[]} [options.selfPids]      额外标为受保护的 pid
 * @param {string} [options.selfExe]         宿主可执行文件（默认 process.execPath）
 * @param {number[]} [options.webServerPorts] dsh 的 Web 服务端口
 * @param {number} [options.now]             注入当前时间（单测）
 * @param {boolean} [options.includeRaw=false] 结果里附带原始快照
 * @returns {Promise<{ok:boolean, snapshot?:object, view?:object, raw?:object, code?:string, error?:string}>}
 */
export async function collectSnapshot(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const startedAt = Date.now();

  const rawResult = await collectRawSnapshot(settings);
  if (!rawResult.ok) return rawResult;
  const raw = rawResult.raw;

  const dshHome = resolveDshHome(settings, raw);
  const workspaceInfo = await readDshWorkspaces({ ...settings, dshHome });
  const selfContext = computeSelfContext(raw, settings);

  const extraWarnings = [];
  if (workspaceInfo.warning) extraWarnings.push(workspaceInfo.warning);

  const view = buildPortView(raw, {
    now: typeof settings.now === 'number' ? settings.now : Date.now(),
    durationMs: Date.now() - startedAt,
    listDir: settings.listDir,
    env: settings.env,
    dshHome,
    workspaces: workspaceInfo.workspaces,
    selfPids: selfContext.selfPids,
    selfExe: selfContext.selfExe,
    webServerPorts: selfContext.webServerPorts,
    extraWarnings,
  });

  const result = { ok: true, snapshot: view, view };
  if (settings.includeRaw === true) result.raw = raw;
  return result;
}

export default collectSnapshot;
