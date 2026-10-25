/**
 * dsh-port-viewer — Host 采集层单测（node --test test/collect.test.mjs）
 *
 * 覆盖 docs/CONTRACT.md §5 的采集契约：
 *   - 项目归属五级优先级：cwd → cmdline → 父链 → DSH 工作区表 → 应用目录 / 同名 exe 目录
 *   - 绑定合并（同 port+pid 的 0.0.0.0 与 [::]）、同端口不同 PID 拆条、loopbackOnly/wildcard
 *   - 孤儿判定（父进程已退出 / PID 被复用）、系统进程保护、dsh 自身端口保护
 *   - kind 分类与 url（数据库端口不给 url）、projects 聚合、stats、warnings
 *   - 降级快照（processes 为空）不崩、不丢端口
 *   - collect.js 的错误码：script-missing / spawn / exit / timeout / no-output / parse
 *
 * 所有目录探测都注入假目录树（test/fixtures/fs-tree.json），不依赖真实磁盘布局；
 * 真实端到端由 PV_REAL=1 node --test 触发（默认跳过，避免单测受本机环境影响）。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPortView, extractPathCandidates, normalizeDir } from '../lib/projects.js';
import { collectRawSnapshot, collectSnapshot } from '../lib/collect.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readFixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const TREE = readFixture('fs-tree.json');
const MIXED = readFixture('raw-mixed.json');
const DEGRADED = readFixture('raw-degraded.json');

const NOW = Date.parse('2026-10-25T10:00:00+08:00');
const ENV = {
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\tester',
  TEMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
  DSH_HOME: 'd:\\dsh\\home',
};
const WORKSPACES = [{ path: 'd:\\work', title: 'legacy-workspace' }];

/** 假目录树 → listDir 注入函数（找不到/无权限一律 null，与真实实现一致）。 */
function makeFakeListDir(tree) {
  const dirs = new Map();
  for (const [dir, entries] of Object.entries(tree)) {
    if (dir.startsWith('_')) continue;
    const key = normalizeDir(dir);
    if (!key) continue;
    dirs.set(
      key.toLowerCase(),
      entries.map((entry) =>
        entry.endsWith('/')
          ? { name: entry.slice(0, -1), isDirectory: true }
          : { name: entry, isDirectory: false },
      ),
    );
  }
  return (dir) => {
    const key = normalizeDir(dir);
    if (!key) return null;
    const entries = dirs.get(key.toLowerCase());
    return entries ? entries.map((entry) => ({ ...entry })) : null;
  };
}

const listDir = makeFakeListDir(TREE);

function makeView(extra = {}) {
  return buildPortView(MIXED, {
    now: NOW,
    listDir,
    env: ENV,
    dshHome: ENV.DSH_HOME,
    workspaces: WORKSPACES,
    ...extra,
  });
}

function portOf(view, port, pid) {
  const found = view.ports.find((entry) => entry.port === port && (pid === undefined || entry.pid === pid));
  assert.ok(found, `视图里应该有端口 ${port}${pid === undefined ? '' : ` (pid ${pid})`}`);
  return found;
}

function projectOf(view, name) {
  const found = view.projects.find((entry) => entry.name === name);
  assert.ok(found, `视图里应该有项目 ${name}，实际有：${view.projects.map((item) => item.name).join(' | ')}`);
  return found;
}

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

test('normalizeDir：反斜杠/小写盘符/尾分隔符规范化，只接受绝对路径', () => {
  assert.equal(normalizeDir('D:\\work\\acme-web\\'), 'd:\\work\\acme-web');
  assert.equal(normalizeDir('d:/work/acme'), 'd:\\work\\acme');
  assert.equal(normalizeDir('D:\\'), 'd:\\');
  assert.equal(normalizeDir('D:'), 'd:\\');
  // UNC 一律不认：这些路径来自别的进程的命令行，而项目根探测会真的去 listDir 它，
  // 等于替对方发起一次 SMB 认证（NetNTLM 可被中继），不可达时还会同步卡住宿主。
  assert.equal(normalizeDir('\\\\nas\\share\\proj'), null, 'UNC 路径必须被拒绝');
  assert.equal(normalizeDir('\\\\?\\C:\\work'), null, '扩展长度路径同样拒绝');
  assert.equal(normalizeDir('\\\\.\\pipe\\x'), null, '设备路径同样拒绝');
  assert.equal(normalizeDir('work\\acme'), null, '相对路径不算项目根');
  assert.equal(normalizeDir(''), null);
  assert.equal(normalizeDir(null), null);
  assert.equal(normalizeDir('   '), null);
});

test('extractPathCandidates：抽双引号路径、裸绝对路径、--cwd= 参数值', () => {
  const candidates = extractPathCandidates(
    '"C:\\Program Files\\nodejs\\node.exe" "D:\\work\\acme web\\server.js" --cwd=D:\\work\\other --prefix D:\\work\\third',
  );
  assert.ok(candidates.includes('c:\\Program Files\\nodejs\\node.exe'));
  assert.ok(candidates.includes('d:\\work\\acme web\\server.js'));
  assert.ok(candidates.includes('d:\\work\\other'), '--cwd= 的值要抽出来');
  assert.ok(candidates.includes('d:\\work\\third'), '--prefix 的值要抽出来');
  assert.deepEqual(extractPathCandidates('node index.js --watch'), [], '相对路径不算项目证据');
  assert.deepEqual(extractPathCandidates(null), []);
});

// ---------------------------------------------------------------------------
// 绑定合并 / 端口条目形状
// ---------------------------------------------------------------------------

test('同一 (port,pid) 的 0.0.0.0 与 [::] 合并成一条，bindings 越具体越前', () => {
  const view = makeView();
  const entries = view.ports.filter((entry) => entry.port === 5173);
  assert.equal(entries.length, 1, '5173 三行 netstat（含重复行）只出一条');
  const entry = entries[0];
  assert.deepEqual(entry.bindings, ['127.0.0.1', '[::]']);
  assert.equal(entry.flags.wildcard, true);
  assert.equal(entry.flags.loopbackOnly, false);
  assert.equal(entry.protocol, 'TCP');
  assert.equal(entry.pid, 100);
  assert.equal(entry.processName, 'node.exe');
  assert.equal(entry.exePath, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(entry.kind, 'dev-server');
  assert.equal(entry.url, 'http://127.0.0.1:5173/');
  assert.equal(entry.uptimeMs, 2 * 60 * 60 * 1000, '08:00 启动，10:00 快照 = 2 小时');
  assert.equal(entry.workingSetBytes, 104857600);
  assert.equal(entry.startingAt, undefined);
  assert.equal(typeof entry.startedAt, 'string');
});

test('同一端口被不同 PID 监听要拆成两条', () => {
  const view = makeView();
  const entries = view.ports.filter((entry) => entry.port === 8000);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.pid).sort((left, right) => left - right),
    [300, 1001],
  );
});

test('只绑 127.0.0.1 的端口 loopbackOnly=true、wildcard=false', () => {
  const entry = portOf(makeView(), 9222, 400);
  assert.equal(entry.flags.loopbackOnly, true);
  assert.equal(entry.flags.wildcard, false);
});

// ---------------------------------------------------------------------------
// 项目归属：五级优先级
// ---------------------------------------------------------------------------

test('第 1 级 cwd：vite dev server 归到 cwd 命中 package.json 的项目', () => {
  const entry = portOf(makeView(), 5173, 100);
  assert.equal(entry.project.name, 'acme-web');
  assert.equal(entry.project.root, 'd:\\work\\acme-web');
  assert.equal(entry.project.source, 'cwd');
  assert.equal(entry.cwd, 'D:\\work\\acme-web');
});

test('第 1 级 cwd：next dev server 同样按 package.json 命中项目根', () => {
  const entry = portOf(makeView(), 3000, 110);
  // 3000 是 next 还是 uvicorn 都不影响：项目名来自 cwd 的项目根
  assert.equal(entry.project.name, 'next-app');
  assert.equal(entry.project.source, 'cwd');
  assert.equal(entry.kind, 'dev-server', 'cmdline 里是 next dev');
});

test('第 2 级 cmdline：cwd 在临时目录（agent 从别的目录启动 vite）靠命令行路径回到项目', () => {
  const entry = portOf(makeView(), 9229, 120);
  assert.equal(entry.cwd, 'C:\\Users\\tester\\AppData\\Local\\Temp');
  assert.equal(entry.project.name, 'acme-web');
  assert.equal(entry.project.source, 'cmdline');
  assert.equal(entry.kind, 'dev-server');
});

test('第 2 级 cmdline：node_modules 里的 vite 不能让 npm 包冒充项目根', () => {
  const view = makeView();
  const entry = portOf(view, 9000, 1300);
  assert.equal(entry.project.root, 'd:\\work\\acme-web');
  assert.notEqual(entry.project.name, 'vite');
});

test('python -m uvicorn：项目来自 cwd 的 pyproject.toml，kind=python 且有 url', () => {
  const entry = portOf(makeView(), 8000, 300);
  assert.equal(entry.project.name, 'llm-svc');
  assert.equal(entry.project.source, 'cwd');
  assert.equal(entry.kind, 'python');
  assert.equal(entry.url, 'http://127.0.0.1:8000/');
});

test('Electron（dsh-pet）：cwd 落在 node_modules\\dsh-pet，项目名就是 dsh-pet', () => {
  const view = makeView();
  const entry = portOf(view, 54522, 400);
  assert.equal(entry.project.name, 'dsh-pet');
  assert.equal(entry.project.source, 'cwd');
  assert.equal(entry.exePath, 'D:\\dsh\\home\\electron\\electron.exe');
  assert.equal(portOf(view, 9222, 400).project.name, 'dsh-pet');
});

test('dsh 自身：profiles\\desktop 不算项目根，归到 exe 目录 deepseek-harness', () => {
  const entry = portOf(makeView(), 54506, 800);
  assert.equal(entry.project.name, 'deepseek-harness');
  assert.equal(entry.project.root, 'd:\\Apps\\deepseek-harness');
  assert.notEqual(entry.project.name, 'desktop', 'DSH_HOME\\profiles\\desktop 是 dsh 运行时目录');
  assert.notEqual(entry.project.name, 'pnpm', '不能被应用自带的 resources\\runtime 冒充');
  assert.equal(entry.project.source, 'app-dir');
});

test('Go 常驻服务（svc-agent）：cwd 没有标志物，用应用目录 go-svc', () => {
  const entry = portOf(makeView(), 7863, 500);
  assert.equal(entry.project.name, 'go-svc');
  assert.equal(entry.project.source, 'app-dir');
  assert.equal(entry.exePath, 'D:\\codex\\dsh-helper\\dist\\svc-agent.exe');
});

test('Clash：UI 走 cwd、内核无权限时靠同名 exe 目录，两者归到同一个项目', () => {
  const view = makeView();
  const ui = portOf(view, 54803, 600);
  assert.equal(ui.project.name, 'Clash Verge');
  assert.equal(ui.project.source, 'app-dir');

  const core = portOf(view, 7897, 700);
  assert.equal(core.project.name, 'Clash Verge');
  assert.equal(core.project.source, 'image-dir', 'verge-mihomo 读不到 cwd/exe，靠同名 exe 定位');

  const group = projectOf(view, 'Clash Verge');
  assert.deepEqual(group.ports, [7897, 54803]);
  assert.equal(group.source, 'app-dir', '一个项目组取最强的证据来源');
});

test('第 4 级 工作区表：路径在登记工作区内但无标志物 → 归到工作区', () => {
  const entry = portOf(makeView(), 18888, 1500);
  assert.equal(entry.project.name, 'legacy-workspace');
  assert.equal(entry.project.root, 'd:\\work');
  assert.equal(entry.project.source, 'workspace');
});

test('五级都失败：归到 unknown:<pid>，进程名当项目名，不静默丢弃', () => {
  const entry = portOf(makeView(), 19999, 1600);
  assert.equal(entry.project.key, 'unknown:1600');
  assert.equal(entry.project.name, 'mystery.exe');
  assert.equal(entry.project.root, null);
  assert.equal(entry.project.source, 'none');
});

// ---------------------------------------------------------------------------
// 孤儿 / 保护 / 分类 / url
// ---------------------------------------------------------------------------

test('孤儿：父进程不在进程表里 → flags.orphan=true（agent 跑完忘了关的典型）', () => {
  const view = makeView();
  const entry = portOf(view, 5175, 1001);
  assert.equal(entry.flags.orphan, true);
  assert.match(entry.orphanReason, /父进程已退出/);
  assert.equal(entry.project.name, 'stray');

  const alive = portOf(view, 5173, 100);
  assert.equal(alive.flags.orphan, false);
  assert.equal(alive.orphanReason, null);
});

test('孤儿：父进程 PID 被复用（父进程比子进程更晚启动）也算遗留', () => {
  const entry = portOf(makeView(), 9000, 1300);
  assert.equal(entry.flags.orphan, true);
  assert.match(entry.orphanReason, /复用/);
});

test('系统进程：保护、不可关闭、没有 url、kind=system、不被误判成遗留', () => {
  const entry = portOf(makeView(), 135, 900);
  assert.equal(entry.flags.system, true);
  assert.equal(entry.flags.protected, true);
  assert.equal(entry.killable, false);
  assert.equal(entry.url, null);
  assert.equal(entry.kind, 'system');
  assert.equal(entry.protectedReason, 'system-process');
  assert.equal(entry.flags.orphan, false, 'smss/services 的父进程退出属正常，不能标成遗留');
});

test('系统进程名单里的 wininit（父进程已退出）同样不算遗留', () => {
  const view = makeView();
  const orphanNames = view.ports.filter((entry) => entry.flags.orphan).map((entry) => entry.processName);
  assert.deepEqual(orphanNames.sort(), ['node.exe', 'node.exe', 'node.exe']);
});

test('Windows 系统端口合并成同一个分组，非系统的未识别进程仍按 PID 分组', () => {
  const raw = {
    generatedAt: '2026-10-25T10:00:00.000+08:00',
    listeners: [
      { protocol: 'TCP', localAddress: '0.0.0.0', port: 135, pid: 900 },
      { protocol: 'TCP', localAddress: '0.0.0.0', port: 445, pid: 4 },
      { protocol: 'TCP', localAddress: '0.0.0.0', port: 49665, pid: 1732 },
      { protocol: 'TCP', localAddress: '0.0.0.0', port: 49668, pid: 4680 },
      { protocol: 'TCP', localAddress: '127.0.0.1', port: 19999, pid: 1600 },
    ],
    processes: [
      { pid: 4, ppid: 0, name: 'System', exe: null, cmdLine: null, cwd: null },
      { pid: 60, ppid: 0, name: 'explorer.exe', exe: 'C:\\Windows\\Explorer.EXE', cwd: null },
      { pid: 900, ppid: 1864, name: 'svchost.exe', exe: 'C:\\Windows\\System32\\svchost.exe', cwd: 'C:\\Windows\\system32' },
      { pid: 1732, ppid: 0, name: 'wininit.exe', exe: 'C:\\Windows\\system32\\wininit.exe', cwd: null },
      { pid: 1864, ppid: 1732, name: 'services.exe', exe: 'C:\\Windows\\system32\\services.exe', cwd: 'C:\\Windows\\system32' },
      // spoolsv：系统服务，但读不到 exe / 命令行（SYSTEM 账户），只能靠父链判断
      { pid: 4680, ppid: 1864, name: 'spoolsv.exe', exe: null, cmdLine: null, cwd: null },
      { pid: 1600, ppid: 60, name: 'mystery.exe', exe: null, cmdLine: 'mystery.exe --watch', cwd: null },
    ],
  };
  const view = buildPortView(raw, { now: NOW, listDir, env: ENV });

  const systemGroups = view.projects.filter((group) => group.key === 'system');
  assert.equal(systemGroups.length, 1, '所有系统端口只占一个分组');
  const systemGroup = systemGroups[0];
  assert.equal(systemGroup.name, 'Windows 系统');
  assert.equal(systemGroup.root, null);
  assert.equal(systemGroup.source, 'system');
  assert.deepEqual(systemGroup.ports, [135, 445, 49665, 49668]);

  assert.equal(portOf(view, 135, 900).project.key, 'system', '系统进程名命中');
  assert.equal(portOf(view, 445, 4).project.key, 'system', 'pid <= 4');
  assert.equal(portOf(view, 49665, 1732).project.key, 'system', 'wininit 名单命中');
  assert.equal(
    portOf(view, 49668, 4680).project.key,
    'system',
    '读不到身份但由 services.exe 拉起 → 按 Windows 服务处理',
  );

  // 用户自己起的进程确实无法归属时，仍然按 PID 分组（可能是 python / 脚本）
  const userEntry = portOf(view, 19999, 1600);
  assert.equal(userEntry.project.key, 'unknown:1600');
  assert.equal(userEntry.project.name, 'mystery.exe');
  assert.equal(userEntry.project.source, 'none');

  // 分组顺序：用户/遗留在前，Windows 系统永远排最后
  assert.equal(view.projects[view.projects.length - 1].key, 'system');
});

test('dsh 自身端口：注入 selfPids / webServerPorts 后不可关闭', () => {
  const byPid = makeView({ selfPids: [800] });
  const selfEntry = portOf(byPid, 54506, 800);
  assert.equal(selfEntry.flags.protected, true);
  assert.equal(selfEntry.killable, false);
  assert.equal(selfEntry.protectedReason, 'dsh-self', 'panel 按这个码显示「dsh 自身」徽标');

  const byPort = makeView({ webServerPorts: [54506] });
  const webEntry = portOf(byPort, 54506, 800);
  assert.equal(webEntry.flags.protected, true);
  assert.equal(webEntry.protectedReason, 'dsh-ui-port');

  // 默认（不做任何注入）时它是普通可关闭端口，保护判定由 lib/index.js 决定
  assert.equal(portOf(makeView(), 54506, 800).killable, true);
});

test('dsh 自身进程的项目显示名是可读的，key/root 保持不变', () => {
  const view = makeView({ selfPids: [800] });
  const entry = portOf(view, 54506, 800);
  assert.equal(entry.project.name, 'DeepSeek Harness（本界面）');
  assert.equal(entry.project.key, 'd:\\Apps\\deepseek-harness', 'key 不变，不影响别的分组');
  assert.equal(entry.project.root, 'd:\\Apps\\deepseek-harness');
  const group = view.projects.find((item) => item.key === 'd:\\Apps\\deepseek-harness');
  assert.equal(group.name, 'DeepSeek Harness（本界面）');
  // 用户自己的项目不受影响
  assert.equal(portOf(view, 5173, 100).project.name, 'acme-web');
});

test('宿主用 node 跑起来时，同 exe 的 node 端口不能被误标成 dsh 自身', () => {
  // 开发态 `node lib/index.js` / e2e 隔离实例：process.execPath 是 node.exe，
  // 按「同 exe」匹配会把用户自己的 node 开发服务器全变成不可关闭。
  const view = makeView({ selfExe: 'C:\\Program Files\\nodejs\\node.exe' });
  const entry = portOf(view, 5173, 100);
  assert.equal(entry.flags.protected, false);
  assert.equal(entry.killable, true);
});

test('宿主是真 Electron 应用时，同 exe 的其它 dsh 进程受保护', () => {
  const view = makeView({ selfExe: 'D:\\Apps\\deepseek-harness\\DeepSeek Harness.exe' });
  const entry = portOf(view, 54506, 800);
  assert.equal(entry.flags.protected, true);
  assert.equal(entry.killable, false);
  assert.equal(entry.protectedReason, 'dsh-self');
  // 别的普通进程不受影响
  assert.equal(portOf(view, 5173, 100).killable, true);
});

test('读不到进程身份（提权/系统账户启动）的端口按最保守处理：protected + flags.opaque', () => {
  const entry = portOf(makeView(), 7897, 700);
  assert.equal(entry.flags.protected, true);
  assert.equal(entry.killable, false);
  assert.equal(entry.flags.opaque, true, 'index.js 的闸门可以据此保守处理');
  assert.equal(entry.protectedReason, 'opaque-process');
  assert.equal(entry.exePath, null);
});

test('数据库端口：kind=database 且不给 http url；java -jar 归 kind=java', () => {
  const view = makeView();
  const db = portOf(view, 3306, 1700);
  assert.equal(db.kind, 'database');
  assert.equal(db.url, null);
  assert.equal(db.project.name, 'mysql');

  const java = portOf(view, 8080, 1100);
  assert.equal(java.kind, 'java');
  assert.equal(java.project.name, 'service');
  assert.equal(java.project.source, 'cwd');
  assert.equal(java.url, 'http://127.0.0.1:8080/');
});

// ---------------------------------------------------------------------------
// 聚合 / 统计 / 降级
// ---------------------------------------------------------------------------

test('projects 聚合：端口去重排序、killableCount、孤儿项目排最前', () => {
  const view = makeView();
  const acme = projectOf(view, 'acme-web');
  assert.deepEqual(acme.ports, [5173, 5174, 9000, 9229]);
  assert.equal(acme.portCount, 4);

  assert.equal(view.projects[0].name, 'stray', '孤儿项目排最前');
  assert.equal(view.projects[1].name, 'acme-web', '其次是有遗留端口的项目');
  assert.equal(projectOf(view, 'stray').orphanCount, 2);

  const titles = view.projects.map((project) => project.name);
  assert.equal(new Set(titles).size, titles.length, '项目组名唯一');
});

test('stats / warnings：19 个端口、3 个遗留、2 个受保护，warnings 说明降级情况', () => {
  const view = makeView();
  assert.equal(view.ok, true);
  assert.equal(view.schemaVersion, 1);
  assert.equal(view.durationMs, 0);
  assert.deepEqual(view.stats, { portCount: 19, projectCount: 13, orphanCount: 3, protectedCount: 2 });
  assert.ok(view.warnings.some((line) => /工作目录/.test(line)), '要说明有进程读不到 cwd');
});

test('降级快照（processes 为空）不崩、不丢端口、warnings 提示', () => {
  const view = buildPortView(DEGRADED, { now: NOW, listDir, env: ENV, dshHome: ENV.DSH_HOME });
  assert.equal(view.ok, true);
  assert.equal(view.stats.portCount, 2);
  const entry = portOf(view, 8080, 4321);
  assert.deepEqual(entry.bindings, ['0.0.0.0', '[::]']);
  assert.equal(entry.project.source, 'none');
  assert.equal(entry.project.key, 'unknown:4321');
  assert.equal(entry.exePath, null);
  assert.equal(entry.killable, false, '身份未知一律不可关闭');
  assert.ok(view.warnings.length >= 2);
  assert.ok(view.warnings.some((line) => /采集脚本报告/.test(line)));
});

test('空/非法入参不抛异常', () => {
  for (const raw of [undefined, null, {}, { listeners: null }, { listeners: [], processes: [] }]) {
    const view = buildPortView(raw, { now: NOW, listDir, env: ENV });
    assert.equal(view.ok, true);
    assert.deepEqual(view.stats, { portCount: 0, projectCount: 0, orphanCount: 0, protectedCount: 0 });
    assert.ok(Array.isArray(view.warnings));
  }
});

// ---------------------------------------------------------------------------
// collect.js：错误码走的是真实代码路径（用假 spawn 注入）
// ---------------------------------------------------------------------------

/** 假子进程：stdout/stderr 都是 EventEmitter，支持 kill()。 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit('close', null, 'SIGTERM'));
  };
  return child;
}

function makeFakeSpawn(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = makeFakeChild();
    calls.push({ command, args, options });
    setImmediate(() => handler({ child, command, args, options }));
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

function outFileFrom(args) {
  const index = args.indexOf('-OutFile');
  return index >= 0 ? args[index + 1] : null;
}

test('collectRawSnapshot：脚本缺失 → code=script-missing', async () => {
  const result = await collectRawSnapshot({ scriptPath: join(FIXTURES, 'no-such-script.ps1') });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'script-missing');
  assert.match(result.error, /找不到采集脚本/);
});

test('collectRawSnapshot：powershell 不存在 → code=spawn', async () => {
  const spawnImpl = makeFakeSpawn(({ child }) => {
    const error = new Error('not found');
    error.code = 'ENOENT';
    child.emit('error', error);
  });
  const result = await collectRawSnapshot({ spawnImpl, powershellPath: 'definitely-missing-powershell.exe', env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'spawn');
  const args = spawnImpl.calls[0].args;
  assert.deepEqual(args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', args[5]]);
  assert.ok(args.includes('-OutFile'));
});

test('collectRawSnapshot：退出码非 0 → code=exit 且带回 stderr', async () => {
  const spawnImpl = makeFakeSpawn(({ child }) => {
    child.stderr.emit('data', 'boom in powershell');
    child.emit('close', 1, null);
  });
  const result = await collectRawSnapshot({ spawnImpl, powershellPath: 'fake-powershell.exe', env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'exit');
  assert.equal(result.details.exitCode, 1);
  assert.match(result.details.stderr, /boom/);
});

test('collectRawSnapshot：JSON 解析失败 → code=parse，空文件 → code=no-output', async () => {
  const badJson = makeFakeSpawn(({ child, args }) => {
    writeFileSync(outFileFrom(args), '<<not json>>');
    child.emit('close', 0, null);
  });
  const parsed = await collectRawSnapshot({ spawnImpl: badJson, powershellPath: 'fake-powershell.exe', env: {} });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'parse');

  const empty = makeFakeSpawn(({ child }) => {
    child.emit('close', 0, null);
  });
  const missing = await collectRawSnapshot({ spawnImpl: empty, powershellPath: 'fake-powershell.exe', env: {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'no-output');
});

test('collectRawSnapshot：超时 → 杀子进程并返回 code=timeout', async () => {
  const spawnImpl = makeFakeSpawn(() => {
    /* 永远不 close：模拟卡死的 PowerShell */
  });
  const startedAt = Date.now();
  const result = await collectRawSnapshot({
    spawnImpl,
    powershellPath: 'fake-powershell.exe',
    env: {},
    timeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timeout');
  assert.ok(Date.now() - startedAt >= 900, '确实等到了超时时间');
  assert.equal(spawnImpl.calls[0].args.includes('-SkipCwd'), false, 'includeCwd 默认 true');
});

test('collectRawSnapshot：includeCwd=false 时传 -SkipCwd', async () => {
  const spawnImpl = makeFakeSpawn(({ child }) => child.emit('close', 0, null));
  await collectRawSnapshot({ spawnImpl, powershellPath: 'fake-powershell.exe', env: {}, includeCwd: false });
  assert.equal(spawnImpl.calls[0].args.includes('-SkipCwd'), true);
});

test('collectSnapshot：完整链路（假 PowerShell），返回 §5.4 视图且 r.snapshot === r.view', async () => {
  const spawnImpl = makeFakeSpawn(({ child, args }) => {
    writeFileSync(outFileFrom(args), JSON.stringify(MIXED));
    child.emit('close', 0, null);
  });
  const result = await collectSnapshot({
    spawnImpl,
    powershellPath: 'fake-powershell.exe',
    env: ENV,
    dshHome: ENV.DSH_HOME,
    workspaces: WORKSPACES,
    listDir,
    now: NOW,
    includeCwd: true,
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot, result.view, '两个键指向同一个视图对象');
  assert.equal(result.snapshot.ok, true);
  assert.equal(result.snapshot.stats.portCount, 19);
  assert.equal(portOf(result.snapshot, 5173, 100).project.name, 'acme-web');
  assert.equal(portOf(result.snapshot, 54506, 800).project.name, 'deepseek-harness');
  assert.ok(Number.isInteger(result.snapshot.durationMs));
  assert.ok(Array.isArray(result.snapshot.ports));
  assert.ok(Array.isArray(result.snapshot.projects));
  assert.equal(result.snapshot.timings.total, 0, 'timings 从原始快照透传');
});

// ---------------------------------------------------------------------------
// 真实端到端（默认跳过）：PV_REAL=1 node --test test/collect.test.mjs
// ---------------------------------------------------------------------------

test('真实快照：本机采集一次并能给出端口→项目', { skip: !process.env.PV_REAL }, async () => {
  const startedAt = Date.now();
  const result = await collectSnapshot({ timeoutMs: 15000, includeCwd: true });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.ok, true);
  assert.ok(result.snapshot.ports.length > 0, '本机至少有一个监听端口');
  assert.ok(elapsedMs < 15000, `采集耗时 ${elapsedMs}ms`);
  assert.ok(result.snapshot.ports.every((entry) => typeof entry.port === 'number'));
  assert.ok(result.snapshot.ports.every((entry) => entry.project && typeof entry.project.key === 'string'));
});
