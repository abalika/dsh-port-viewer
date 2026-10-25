/**
 * lib/index.js 的单测：安全闸门与 HTTP 语义。
 *
 * 这里刻意不碰真实系统：采集器、kill 实现、ctx、req/res 全部是假的。
 * 真正要证明的是「谁能被杀、谁不能」，因为那是这个插件唯一可能造成损失的路径。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  applySafety,
  assertSession,
  createHandlers,
  createSnapshotProvider,
  KILL_ROUTE,
  killProcessTree,
  maskSecrets,
  normalizeOptions,
  protectionOf,
  SNAPSHOT_ROUTE,
  selfContext,
  validateTargets,
} from '../lib/index.js';

//#region 测试替身

/** 假 ctx：只需要 webServer.getOrigin()。 */
function fakeCtx(origin = 'http://127.0.0.1:54506') {
  return { webServer: { getOrigin: () => origin, protocol: 'http:' } };
}

/** 假 req：支持 for-await 读 body。 */
function fakeReq({ method = 'GET', url = SNAPSHOT_ROUTE, headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  let index = 0;
  return {
    method,
    url,
    headers,
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return index < chunks.length
            ? { value: chunks[index++], done: false }
            : { value: undefined, done: true };
        },
      };
    },
  };
}

/** 假 res：记录状态码与 body。 */
function fakeRes() {
  return {
    status: 0,
    headers: null,
    payload: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(payload) {
      this.payload = payload;
    },
    json() {
      return JSON.parse(this.payload);
    },
  };
}

/** 一个看起来正常的端口视图（会在 handler 里被 applySafety 标注）。 */
function sampleView() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-25T01:00:00.000Z',
    durationMs: 8,
    ports: [
      {
        port: 5173,
        pid: 100,
        processName: 'node.exe',
        exePath: 'C:\\Program Files\\nodejs\\node.exe',
        commandLine: 'node D:\\proj\\node_modules\\vite\\bin\\vite.js',
        cwd: 'D:\\proj',
        startedAt: '2026-10-25T00:00:00.000Z',
        uptimeMs: 60000,
        workingSetBytes: 1024,
        project: { key: 'd:\\proj', name: 'proj', root: 'D:\\proj', source: 'cwd' },
        flags: {},
        protectedReason: null,
        killable: true,
      },
      {
        port: 54506,
        pid: 200,
        processName: 'DeepSeek Harness.exe',
        exePath: 'D:\\Apps\\deepseek-harness\\DeepSeek Harness.exe',
        commandLine: '"D:\\Apps\\deepseek-harness\\DeepSeek Harness.exe"',
        project: { key: 'D:\\Apps\\deepseek-harness', name: 'deepseek-harness', root: 'D:\\Apps\\deepseek-harness', source: 'cwd' },
        flags: {},
        protectedReason: null,
        killable: true,
      },
      {
        port: 445,
        pid: 4,
        processName: 'System',
        exePath: null,
        commandLine: null,
        project: { key: 'unknown:4', name: 'System', root: null, source: 'none' },
        flags: {},
        protectedReason: null,
        killable: true,
      },
      {
        port: 135,
        pid: 900,
        processName: 'svchost.exe',
        exePath: 'C:\\Windows\\System32\\svchost.exe',
        commandLine: 'svchost.exe -k RPCSS',
        project: { key: 'unknown:900', name: 'svchost', root: null, source: 'none' },
        flags: {},
        protectedReason: null,
        killable: true,
      },
    ],
    projects: [
      { key: 'd:\\proj', name: 'proj', root: 'D:\\proj', source: 'cwd', portCount: 1, ports: [5173], killableCount: 1 },
      { key: 'D:\\Apps\\deepseek-harness', name: 'deepseek-harness', root: 'D:\\Apps\\deepseek-harness', source: 'cwd', portCount: 1, ports: [54506], killableCount: 1 },
    ],
    stats: { portCount: 4, projectCount: 2, orphanCount: 0, protectedCount: 0 },
    warnings: [],
  };
}

//#endregion

test('normalizeOptions 给出可用默认值并接受覆写', () => {
  const defaults = normalizeOptions(undefined);
  assert.equal(defaults.protectSystem, true);
  assert.equal(defaults.ttlMs, 1200);
  assert.equal(defaults.maxTargets, 128);
  assert.equal(defaults.snapshotTimeoutMs, 15000);

  const custom = normalizeOptions({ protectSystem: false, ttlMs: 0, maxTargets: -3, snapshotTimeoutMs: 5000 });
  assert.equal(custom.protectSystem, false);
  assert.equal(custom.ttlMs, 1200, '非正数要退回默认值');
  assert.equal(custom.maxTargets, 128, '非正数要退回默认值');
  assert.equal(custom.snapshotTimeoutMs, 5000);
});

test('maskSecrets 抹掉命令行里的密钥但保留可读上下文', () => {
  assert.equal(maskSecrets(null), null);
  assert.equal(maskSecrets('node vite.js'), 'node vite.js');

  const sk = maskSecrets('curl -H x sk-abcdefghijklmnopqrstuvwxyz123456');
  assert.ok(!sk.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), sk);
  assert.ok(sk.includes('«redacted»'), sk);

  const token = maskSecrets('node app.js --token supersecretvalue --port 3000');
  assert.ok(!token.includes('supersecretvalue'), token);
  assert.ok(token.includes('--token «redacted»'), token);
  assert.ok(token.includes('--port 3000'), token, '无关参数必须保留');

  const env = maskSecrets('FOO=1 API_KEY=abcd1234 node app.js');
  assert.ok(!env.includes('abcd1234'), env);
  assert.ok(env.includes('FOO=1'), env);

  const bearer = maskSecrets('node app.js --header "Bearer abcdefghijklmnopqrst"');
  assert.ok(!bearer.includes('abcdefghijklmnopqrst'), bearer);
});

test('maskSecrets 覆盖真实的泄漏形态（环境变量 / 短参数 / URL 凭据 / 厂商前缀）', () => {
  const cases = [
    ['node app.js DB_PASSWORD=hunter2secret', 'hunter2secret'],
    ['node app.js MY_SECRET_KEY=abc123def', 'abc123def'],
    ['node app.js OPENAI_API_KEY=abcd1234efgh', 'abcd1234efgh'],
    ['node app.js GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwx'],
    ['node app.js --pass s3cr3t', 's3cr3t'],
    ['node app.js -p s3cr3t', 's3cr3t'],
    ['git clone https://user:passw0rd@github.com/x/y.git', 'passw0rd'],
    ['psql postgres://admin:Pa55w0rd!@db.host/prod', 'Pa55w0rd!'],
    ['node app.js STRIPE=sk_live_51HabcdEFGHijkl', 'sk_live_51HabcdEFGHijkl'],
    ['node app.js --header "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl"', 'eyJhbGciOiJIUzI1NiJ9'],
  ];
  for (const [input, secret] of cases) {
    const masked = maskSecrets(input);
    assert.ok(!masked.includes(secret), `未抹掉 ${secret}：${masked}`);
    assert.ok(masked.includes('«redacted»'), `没有留下标记：${masked}`);
  }
  // 别误伤正常参数
  assert.equal(maskSecrets('node server.js --port 3000 --host 127.0.0.1'), 'node server.js --port 3000 --host 127.0.0.1');
});

test('protectionOf 认出系统进程、dsh 自身与 GUI 端口', () => {
  const context = selfContext(fakeCtx('http://127.0.0.1:54506'));
  const protect = (entry) => protectionOf(entry, context, true);

  assert.deepEqual(protect({ port: 5173, pid: 100, processName: 'node.exe' }), { protected: false, reason: null });
  assert.equal(protect({ port: 445, pid: 4, processName: 'System' }).reason, 'system-pid');
  assert.equal(protect({ port: 135, pid: 900, processName: 'svchost.exe' }).reason, 'system-process');
  assert.equal(
    protect({ port: 135, pid: 901, processName: 'weird.exe', exePath: 'C:\\Windows\\System32\\weird.exe' }).reason,
    'system-directory',
  );
  assert.equal(protect({ port: 54506, pid: 200, processName: 'anything.exe' }).reason, 'dsh-ui-port');
  // 测试进程自己（node）不因为名字叫 node.exe 就被保护，但同一 pid 必须被保护。
  assert.equal(protect({ port: 9999, pid: process.pid, processName: 'node.exe' }).reason, 'dsh-self');

  const loose = protectionOf({ port: 135, pid: 900, processName: 'svchost.exe' }, context, false);
  assert.equal(loose.protected, false, 'protectSystem=false 时系统进程放开');
  // 但 dsh 自身与 GUI 端口不受 protectSystem 影响。
  assert.equal(protectionOf({ port: 54506, pid: 200, processName: 'x.exe' }, context, false).protected, true);
});

test('宿主是真 Electron 应用时，同 exe 的 dsh 端口全部受保护（不误杀界面进程）', () => {
  // 真实运行时：插件的宿主进程就是 DeepSeek Harness.exe（ELECTRON_RUN_AS_NODE=1 的 node 模式），
  // 所以 selfExe 规则会把整个 Electron 进程树（主进程/renderer/GPU/subprocess）都护住。
  const electronContext = {
    selfPid: 10352,
    selfExe: 'd:\\apps\\deepseek-harness\\deepseek harness.exe',
    hostDir: 'd:\\apps\\deepseek-harness',
    systemRoot: 'c:\\windows',
    guiPort: 54506,
  };
  const dshEntry = {
    port: 8791,
    pid: 10352,
    processName: 'DeepSeek Harness.exe',
    exePath: 'D:\\Apps\\deepseek-harness\\DeepSeek Harness.exe',
    flags: {},
  };
  assert.deepEqual(protectionOf(dshEntry, electronContext, true), { protected: true, reason: 'dsh-self' });
  // 别的 dsh 进程（renderer / subprocess runner）同样受保护。
  assert.equal(
    protectionOf({ ...dshEntry, pid: 23856 }, electronContext, true).reason,
    'dsh-self',
  );
  // 但用户的 node 端口不受影响。
  assert.equal(
    protectionOf({ port: 5173, pid: 999, processName: 'node.exe', exePath: 'C:\\Program Files\\nodejs\\node.exe', flags: {} }, electronContext, true).protected,
    false,
  );
});

test('读不到身份的进程（flags.opaque）不放行，且不受 protectSystem 影响', () => {
  const context = selfContext(fakeCtx());
  const opaque = {
    port: 7897,
    pid: 11348,
    processName: 'verge-mihomo.exe',
    exePath: null,
    commandLine: null,
    flags: { opaque: true },
  };
  assert.deepEqual(protectionOf(opaque, context, true), { protected: true, reason: 'opaque-process' });
  assert.deepEqual(protectionOf(opaque, context, false), { protected: true, reason: 'opaque-process' });

  // 身份可读的同名进程不受此影响，仍然按普通进程处理。
  const readable = { ...opaque, exePath: 'D:\\Apps\\ClashVerge\\verge-mihomo.exe', flags: { opaque: false } };
  assert.equal(protectionOf(readable, context, true).protected, false);
});

test('applySafety 保留采集层的 opaque 标记并据此拒绝关闭', () => {
  const view = sampleView();
  view.ports.push({
    port: 7897,
    pid: 11348,
    processName: 'verge-mihomo.exe',
    exePath: null,
    commandLine: null,
    project: { key: 'D:\\Apps\\ClashVerge', name: 'Clash Verge', root: 'D:\\Apps\\ClashVerge', source: 'image-dir' },
    flags: { opaque: true },
    killable: true,
  });
  applySafety(view, selfContext(fakeCtx()), true);
  const opaqueEntry = view.ports.find((entry) => entry.port === 7897);
  assert.equal(opaqueEntry.killable, false);
  assert.equal(opaqueEntry.protectedReason, 'opaque-process');
  assert.equal(opaqueEntry.flags.opaque, true, 'applySafety 不能把采集层的 opaque 抹掉');
});

test('selfContext 在 node 宿主下不按 exe 相等保护（否则会锁死所有 node dev server）', () => {
  const context = selfContext(fakeCtx());
  const runningUnderElectron = /electron|deepseek harness/i.test(process.execPath);
  if (!runningUnderElectron) {
    // 关键断言：测试宿主是 node.exe，此时绝不能把 selfExe 当成保护指纹。
    assert.equal(context.selfExe, undefined);
    assert.equal(context.hostDir, undefined);
  }
  assert.equal(context.guiPort, 54506);
});

test('applySafety 覆盖采集层的启发式标注并重算统计', () => {
  const view = sampleView();
  const context = selfContext(fakeCtx());
  applySafety(view, context, true);

  const byPort = new Map(view.ports.map((entry) => [entry.port, entry]));
  assert.equal(byPort.get(5173).killable, true);
  assert.equal(byPort.get(54506).killable, false);
  assert.equal(byPort.get(54506).protectedReason, 'dsh-ui-port');
  assert.equal(byPort.get(445).killable, false);
  assert.equal(byPort.get(135).killable, false);
  assert.equal(view.stats.protectedCount, 3);
  assert.equal(view.stats.killableCount, 1);
  assert.equal(view.projects[0].killableCount, 1);
  assert.equal(view.projects[1].killableCount, 0);
});

test('validateTargets 拒绝畸形输入并去重', () => {
  assert.throws(() => validateTargets({}), /targets/);
  assert.throws(() => validateTargets({ targets: [] }), /must not be empty/);
  assert.throws(() => validateTargets({ targets: [{ port: 70000, pid: 1 }] }), /invalid port/);
  assert.throws(() => validateTargets({ targets: [{ port: 80, pid: 0 }] }), /invalid pid/);
  assert.throws(() => validateTargets({ targets: Array.from({ length: 129 }, (_, i) => ({ port: (i % 60000) + 1, pid: i + 10 })) }), /at most/);

  const targets = validateTargets({ targets: [{ port: 5173, pid: 100 }, { port: 5173, pid: 100 }, { port: 3000, pid: 200 }] });
  assert.deepEqual(targets, [{ port: 5173, pid: 100 }, { port: 3000, pid: 200 }]);
});

test('killProcessTree 用「进程还在不在」而不是退出码判断成败', async () => {
  const makeSpawn = (code, stderr = '') => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stderr.length > 0) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
  // 一个肯定不存在的 PID：任何退出码都应判为「目标已达成」。
  const deadPid = 999999;
  const killed = await killProcessTree(deadPid, makeSpawn(0));
  assert.equal(killed.ok, true);
  assert.equal(killed.code, 'killed');
  assert.equal((await killProcessTree(deadPid, makeSpawn(128))).code, 'already-exited');
  assert.equal((await killProcessTree(deadPid, makeSpawn(128))).ok, true, '进程已退出视为目标达成');

  // 一个肯定活着的 PID（就是测试进程自己）：taskkill 报错时必须判失败，
  // 这就是 taskkill 返回 128 却被当成成功的那个 bug 的回归点。
  const alive = await killProcessTree(process.pid, makeSpawn(128, 'Access is denied.'));
  assert.equal(alive.ok, false, '进程还活着时不能报成功');
  assert.equal(alive.code, 'taskkill-failed');
  assert.match(alive.message, /Access is denied/);

  // 退出码 0 但进程仍在（taskkill 骗人 / 杀错了树）：同样判失败。
  const liar = await killProcessTree(process.pid, makeSpawn(0));
  assert.equal(liar.ok, false);
  assert.equal(liar.code, 'still-alive');
});

//#region handler 级测试

/** 组装一对 handler，返回便捷调用器。 */
function buildHarness({ view = sampleView(), collect = undefined, killImpl = undefined } = {}) {
  const options = normalizeOptions({ ttlMs: 0 });
  const calls = [];
  const collector = collect ?? (async (collectOptions) => {
    calls.push(collectOptions);
    return { ok: true, snapshot: view };
  });
  const provider = createSnapshotProvider(options, collector);
  const kills = [];
  const kill = killImpl ?? (async (pid) => {
    kills.push(pid);
    return { ok: true, code: 'killed', message: '' };
  });
  const handlers = createHandlers(options, () => fakeCtx(), provider, kill);
  return { handlers, calls, kills, view, options };
}

test('GET /snapshot 返回带权威安全标注的视图', async () => {
  const { handlers } = buildHarness();
  const res = fakeRes();
  await handlers.snapshot(fakeReq({ method: 'GET', url: SNAPSHOT_ROUTE }), res);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.ports.length, 4);
  assert.equal(body.stats.protectedCount, 3);
  const unprotected = body.ports.find((entry) => entry.port === 5173);
  assert.equal(unprotected.killable, true);
  assert.equal(body.ports.find((entry) => entry.port === 54506).killable, false);
});

test('GET /snapshot 拒绝 POST 与跨源请求', async () => {
  const { handlers } = buildHarness();

  const wrongMethod = fakeRes();
  await handlers.snapshot(fakeReq({ method: 'POST' }), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const crossSite = fakeRes();
  await handlers.snapshot(fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } }), crossSite);
  assert.equal(crossSite.status, 403);

  const crossOrigin = fakeRes();
  await handlers.snapshot(fakeReq({ headers: { origin: 'https://evil.example' } }), crossOrigin);
  assert.equal(crossOrigin.status, 403);

  const sameOrigin = fakeRes();
  await handlers.snapshot(fakeReq({ headers: { origin: 'http://localhost:54506', 'sec-fetch-site': 'same-origin' } }), sameOrigin);
  assert.equal(sameOrigin.status, 200, 'loopback 拼写差异应视为同源');
});

test('POST /kill 能关掉可关闭的端口', async () => {
  const { handlers, kills } = buildHarness();
  const res = fakeRes();
  await handlers.kill(
    fakeReq({
      method: 'POST',
      url: KILL_ROUTE,
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:54506', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ targets: [{ port: 5173, pid: 100 }] }),
    }),
    res,
  );
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.killed, 1);
  assert.deepEqual(kills, [100]);
  assert.deepEqual(body.results, [{ port: 5173, pid: 100, ok: true }]);
});

test('POST /kill 拒绝受保护目标与过期（PID/端口不再匹配）目标', async () => {
  const { handlers, kills } = buildHarness();

  const protectedRes = fakeRes();
  await handlers.kill(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [{ port: 54506, pid: 200 }, { port: 135, pid: 900 }] }),
    }),
    protectedRes,
  );
  assert.equal(protectedRes.status, 200);
  let body = protectedRes.json();
  assert.equal(body.ok, false);
  assert.equal(body.killed, 0);
  assert.equal(body.failed.length, 2);
  assert.equal(body.failed[0].error, 'protected');
  assert.equal(body.failed[0].reason, 'dsh-ui-port');
  assert.deepEqual(kills, [], '受保护目标绝不允许走到 taskkill');

  const staleRes = fakeRes();
  await handlers.kill(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [{ port: 5173, pid: 999 }] }),
    }),
    staleRes,
  );
  body = staleRes.json();
  assert.equal(body.failed[0].error, 'stale');
  assert.equal(body.failed[0].currentPid, 100);
  assert.deepEqual(kills, []);
});

test('POST /kill 记录 taskkill 失败原因且不影响其它目标', async () => {
  const view = sampleView();
  view.ports.push({
    port: 3000,
    pid: 300,
    processName: 'python.exe',
    exePath: 'C:\\Python311\\python.exe',
    commandLine: 'python -m uvicorn app:app',
    project: { key: 'd:\\api', name: 'api', root: 'D:\\api', source: 'cwd' },
    flags: {},
    killable: true,
  });
  const { handlers } = buildHarness({
    view,
    killImpl: async (pid) => (pid === 100
      ? { ok: false, code: 'taskkill-failed', message: '拒绝访问' }
      : { ok: true, code: 'killed', message: '' }),
  });

  const res = fakeRes();
  await handlers.kill(
    fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [{ port: 5173, pid: 100 }, { port: 3000, pid: 300 }] }),
    }),
    res,
  );
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.killed, 1);
  assert.equal(body.failed[0].error, 'taskkill-failed');
});

test('POST /kill 要求 JSON content-type 且拒绝畸形请求体', async () => {
  const { handlers } = buildHarness();

  const formPost = fakeRes();
  await handlers.kill(
    fakeReq({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'port=5173' }),
    formPost,
  );
  assert.equal(formPost.status, 403, '表单无法触发破坏性动作');

  const badJson = fakeRes();
  await handlers.kill(
    fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }),
    badJson,
  );
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json().code, 'invalid-body');

  const wrongMethod = fakeRes();
  await handlers.kill(fakeReq({ method: 'GET' }), wrongMethod);
  assert.equal(wrongMethod.status, 405);
});

test('采集失败时 snapshot 返回 503 而不是崩掉宿主', async () => {
  const provider = createSnapshotProvider(normalizeOptions({ ttlMs: 0 }), async () => ({
    ok: false,
    code: 'timeout',
    error: 'powershell 采集超时',
  }));
  const handlers = createHandlers(normalizeOptions({ ttlMs: 0 }), () => fakeCtx(), provider, async () => ({ ok: true }));
  const res = fakeRes();
  await handlers.snapshot(fakeReq(), res);
  assert.equal(res.status, 503);
  assert.equal(res.json().code, 'timeout');
});

test('快照提供者：TTL 内命中缓存、fresh 强制重采、并发请求合并', async () => {
  let calls = 0;
  const options = normalizeOptions({ ttlMs: 60000 });
  const provider = createSnapshotProvider(options, async () => {
    calls += 1;
    return { ok: true, snapshot: { ports: [], projects: [], stats: {} } };
  });

  await provider.get();
  await provider.get();
  assert.equal(calls, 1, 'TTL 内的第二次请求不应再采集');

  await provider.get('fresh');
  assert.equal(calls, 2, 'fresh 必须绕过缓存');

  const before = calls;
  await Promise.all([provider.get('fresh'), provider.get('fresh'), provider.get('fresh')]);
  assert.equal(calls, before + 1, '并发请求应合并成一次采集');
});

test('fresh 请求在采集失败时绝不回退到旧缓存（kill 授权宁可失败）', async () => {
  let mode = 'ok';
  const options = normalizeOptions({ ttlMs: 60000 });
  const provider = createSnapshotProvider(options, async () => {
    if (mode === 'fail') return { ok: false, code: 'timeout', error: 'collector exploded' };
    return { ok: true, snapshot: { ports: [], projects: [], stats: {} } };
  });

  await provider.get();          // 先有一份缓存
  mode = 'fail';
  await assert.rejects(() => provider.get('fresh'), /stale snapshot|collector exploded|port collection failed/i);
  // 普通读取仍然可以用缓存（面板不该因为一次采集失败就变空）
  const cached = await provider.get();
  assert.ok(cached, 'cache 模式下仍应返回上一份快照');
});

//#endregion

//#region 会话鉴权

test('assertSession：复用宿主会话校验，且任何异常都不连累用户', () => {
  // 1) 宿主没有 connection 服务（旧版本）→ 放行，退回同源 + CSRF 的老行为。
  assert.equal(assertSession({ headers: {} }, fakeRes(), fakeCtx(), true), true);
  // 2) 会话有效 → 放行。
  const allowCtx = { ...fakeCtx(), connection: { authorizeIndex: () => true } };
  assert.equal(assertSession({ headers: {} }, fakeRes(), allowCtx, true), true);
  // 3) 会话无效 → 宿主自己写完 401，调用方必须停手。
  const denyCtx = { ...fakeCtx(), connection: { authorizeIndex: () => false } };
  assert.equal(assertSession({ headers: {} }, fakeRes(), denyCtx, true), false);
  // 4) 宿主内部抛错 → 放行（宁可少一层防护，也不要把面板锁死）。
  const boomCtx = { ...fakeCtx(), connection: { authorizeIndex: () => { throw new Error('boom'); } } };
  assert.equal(assertSession({ headers: {} }, fakeRes(), boomCtx, true), true);
  // 5) config.requireSession=false 时压根不调用。
  let called = 0;
  const counted = { ...fakeCtx(), connection: { authorizeIndex: () => { called += 1; return false; } } };
  assert.equal(assertSession({ headers: {} }, fakeRes(), counted, false), true);
  assert.equal(called, 0, 'requireSession=false 时不应询问会话');
});

test('handler 层：会话被拒时 handler 不再写 JSON，也不会走到 taskkill', async () => {
  const options = normalizeOptions({ ttlMs: 0 });
  const provider = createSnapshotProvider(options, async () => ({ ok: true, snapshot: sampleView() }));
  const kills = [];
  const ctx = {
    ...fakeCtx(),
    connection: {
      authorizeIndex(_req, res) {
        res.writeHead(401);
        res.end('{}');
        return false;
      },
    },
  };
  const handlers = createHandlers(options, () => ctx, provider, async (pid) => {
    kills.push(pid);
    return { ok: true, code: 'killed', message: '' };
  });

  const snapshotRes = fakeRes();
  await handlers.snapshot(fakeReq({ url: SNAPSHOT_ROUTE }), snapshotRes);
  assert.equal(snapshotRes.status, 401, '会话无效时应当直接返回宿主的 401');
  assert.equal(snapshotRes.payload, '{}', '不能被插件自己的 JSON 覆盖');

  const killRes = fakeRes();
  await handlers.kill(fakeReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: [{ port: 5173, pid: 100 }] }),
  }), killRes);
  assert.equal(killRes.status, 401);
  assert.deepEqual(kills, [], '会话被拒时绝不能走到 taskkill');
});

//#endregion
