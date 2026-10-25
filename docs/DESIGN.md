# 设计说明

这份文档解释 `dsh-port-viewer` 为什么长成这样：数据从哪来、项目归属怎么推、什么情况下
拒绝关闭、UI 的约束是什么。想改代码之前先读它。

## 1. 形态

dsh 插件 = **Host 半边**（Node，跑在 dsh 宿主进程里）+ **浏览器半边**（classic script，
注入 Web GUI）。不修改 `app.asar`，不改 dsh 源码，卸载即干净。

```
浏览器 lib/client.js ──fetch──▶ GET /api/port-viewer/snapshot
                                     │  lib/index.js（cordis 插件：路由 + 安全闸门）
                                     ▼
                               lib/collect.js ──spawn──▶ powershell.exe lib/snapshot.ps1
                                     │                        │ netstat -ano -p TCP
                                     │                        │ Get-CimInstance Win32_Process（全表）
                                     │                        │ PEB 读 CurrentDirectory
                                     ▼                        ▼
                               lib/projects.js            UTF-8（无 BOM）JSON 临时文件
                               （端口→项目推断）
```

几处刻意的设计：

- **不用原生模块**。Windows 没有「枚举监听端口」的 Node API，也没有「读别的进程工作目录」
  的 API，所以采集统一交给一次 PowerShell：`netstat` + WMI(CIM) + PEB 读取。
  代价是每次约 1 秒，收益是零依赖、零编译。
- **采集与控制分离**。采集只产出一个纯 JSON；归属推断是纯函数（`buildPortView`），
  可以用 fixtures 单测，不碰真实系统。
- **HTTP 语义与安全闸门放在 `lib/index.js`**，不散落在各处。

## 2. 采集（`lib/snapshot.ps1` → `lib/collect.js`）

`snapshot.ps1` 只做一件事：把原始事实写成 UTF-8（无 BOM）JSON。

```json
{
  "schemaVersion": 1,
  "generatedAt": "ISO",
  "timingsMs": { "compile": 0, "netstat": 0, "processes": 0, "total": 0 },
  "listeners": [{ "protocol": "TCP", "localAddress": "0.0.0.0", "port": 5173, "pid": 1234 }],
  "processes": [{
    "pid": 1234, "ppid": 1000, "name": "node.exe",
    "exe": "C:\\Program Files\\nodejs\\node.exe",
    "cmdLine": "node D:\\proj\\node_modules\\vite\\bin\\vite.js",
    "startedAt": "ISO", "workingSetBytes": 123456789, "cwd": "D:\\proj"
  }],
  "errors": []
}
```

- `listeners`：`netstat -ano -p TCP` 里状态为 `LISTENING` 的行；IPv6 保留方括号形式（`[::]:80`）。
- `processes`：**本机全部进程**（不是只有监听者）。父链与孤儿判定都需要全表。
- `cwd`：PEB 读取（`NtQueryInformationProcess` + `ReadProcessMemory`），只对「监听端口 PID
  及其祖先」尝试，读不到就是 `null`（系统进程 AccessDenied 是正常现象）。
- 单点失败只进 `errors[]`，绝不让整份快照失败。

`collect.js` 负责：临时目录、`spawn`、超时后**连同 PowerShell 进程树一起回收**、读回 JSON、
把中文路径按 UTF-8 正确解码。

## 3. 端口 → 项目（`lib/projects.js`）

这是这个插件的核心，按可信度依次回退，命中即停，并在 `project.source` 里记录来源：

| 顺序 | source | 依据 |
| --- | --- | --- |
| 1 | `cwd` | 进程工作目录，向上找项目标志物（`.git` / `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `pom.xml` / `*.csproj` / `composer.json` …） |
| 2 | `cmdline` | 命令行里的绝对路径（`node …\node_modules\vite\bin\vite.js`、`--cwd=`），会剥掉 `node_modules` 之前的部分 |
| 3 | `parent` | cwd 读不到时，沿父进程链最多 4 层，取第一个有 cwd 的祖先 |
| 4 | `workspace` | 读 `$DSH_HOME/storages/workspace.json` 里登记的工作区路径，做最长前缀匹配 |
| 5 | `app-dir` | 没有标志物时，把 cwd（其次 exe 所在目录）的目录名当应用目录 |
| 6 | `image-dir` | 身份被权限挡住时，去其它进程的 exe 目录找死名 exe（例如 Clash 内核 → Clash Verge） |
| — | `system` | 属于 Windows 系统的端口合并成一个组 `Windows 系统` |
| — | `none` | 仍推不出来的，按 `unknown:<pid>` 归到「未识别项目」，**不静默丢弃** |

排除项：`<DSH_HOME>` 与 `<DSH_HOME>/profiles/<name>`（正好一层）不算项目根，否则 dsh 自身
会被归到一个叫 `desktop` 的无意义组；命令行里落在**本进程自己安装目录**内的路径也忽略。

`key` 用规范化后的绝对路径（小写盘符、反斜杠、无尾分隔符）；`name` 用根目录 basename，
dsh 自身进程额外覆盖成 `DeepSeek Harness（本界面）`（key/root 不变）。

## 4. 安全（`lib/index.js`）

采集层只负责**标注**（像不像系统进程、像不像 dsh 自己），**能不能关**在真正执行 kill 的
同一个进程里判定，且用执行前一刻的数据：

0. **会话鉴权**：两条路由复用 **dsh 自己的会话 cookie** —— 调
   `ctx.get('connection').authorizeIndex(req, res)`，和 `/api` 桥、index 服务用的是同一个校验。
   桌面壳（`app.asar/lib/main.js`）把 `/api/*` 转发给宿主时会 `headers.set('cookie', hostCookie)`，
   所以浏览器侧天然带凭证，本机其它进程没有。宿主没有 `connection` 服务（旧版本）时自动跳过。
   **不要改回「插件自己发令牌 + index 注水」**：桌面壳对 `dsh-app://app/` 的主文档是
   `serveWebDocument(request, join(app.getAppPath(), "renderer"))` 直接从磁盘提供，只有
   `/api/*`、`/plugins/*` 才 `forwardWebRequest` 给宿主 —— `renderIndex`/`tapIndex` 对该文档
   永远不执行，令牌到不了页面，强制鉴权 = 面板 100% 401（实测踩过，见 v0.1 的两次修复）。
1. 前端拿到的 `killable` 只是界面提示；
2. `POST /kill` 用**绕过缓存的新快照**重新核对「这个端口此刻是否仍属于这个 PID」，
   不匹配则拒绝（`stale`）—— 防 PID 复用；`fresh` 采集失败时直接拒绝，**绝不回退旧缓存**；
3. 拒绝清单：`pid <= 4`、已知系统进程名、`%SystemRoot%` 下的可执行文件、dsh 宿主进程树、
   **正在承载当前界面的端口**、以及读不到身份的 `opaque` 进程（这条不受 `protectSystem` 影响：
   `taskkill` 对它本来就是 AccessDenied）；
4. 破坏性请求要求 `application/json` + 同源校验，跨源 fetch 与表单都被拒；
5. 命令行里的 `sk-…`/`ghp_…`/JWT、`*_PASSWORD=`/`*_TOKEN=`、`--token`/`--pass`/`-p`、
   `Bearer …`、URL 内嵌凭据都会被抹掉再发给浏览器；
6. 关闭用 `taskkill /T /F`（绝对路径、5 秒超时），成败以「进程还在不在」判定，不信退出码；
7. 路径推断一律拒绝 UNC（否则等于替别的进程发起 SMB 认证），`snapshot.ps1` 只在 x64 下读 PEB。

`protectedReason` 的稳定词表：`system-pid` / `system-process` / `system-directory` /
`dsh-self` / `dsh-ui-port` / `opaque-process`。

## 5. 快照视图（HTTP 契约）

```json
{
  "ok": true,
  "schemaVersion": 1,
  "generatedAt": "ISO",
  "durationMs": 612,
  "ports": [{
    "port": 5173, "protocol": "TCP", "bindings": ["127.0.0.1", "[::]"],
    "pid": 1234, "processName": "node.exe",
    "exePath": "C:\\Program Files\\nodejs\\node.exe",
    "commandLine": "node …vite.js", "cwd": "D:\\proj",
    "startedAt": "ISO", "uptimeMs": 123456, "workingSetBytes": 123456789,
    "url": "http://127.0.0.1:5173/",
    "project": { "key": "d:\\proj", "name": "proj", "root": "D:\\proj", "source": "cwd" },
    "kind": "dev-server",
    "orphanReason": null,
    "flags": { "orphan": false, "system": false, "protected": false, "opaque": false,
                "wildcard": true, "loopbackOnly": false },
    "protectedReason": null,
    "killable": true
  }],
  "projects": [{ "key": "d:\\proj", "name": "proj", "root": "D:\\proj", "source": "cwd",
                 "portCount": 2, "ports": [5173, 5174], "killableCount": 2 }],
  "stats": { "portCount": 12, "projectCount": 3, "orphanCount": 1, "protectedCount": 4,
             "killableCount": 8 },
  "warnings": []
}
```

同一 `(port, pid)` 的多个绑定合并成一条；同一端口被不同 PID 监听要拆成多条。
`orphan` = 父进程已不存在（或父 PID 被更晚启动的进程复用），这是「agent 跑完忘了关」的
典型特征；系统进程永不标 orphan。

`POST /api/port-viewer/kill` 请求体 `{"targets":[{"port":5173,"pid":1234}]}`，
响应 `{ ok, killed, results:[{port,pid,ok}], failed:[{port,pid,error,message,reason?,currentPid?}] }`，
`error` ∈ `protected` / `stale` / `taskkill-failed` / `already-exited` / `spawn-failed`。

## 6. 浏览器半边（`lib/client.js`）

技术选择：**`position: fixed` 的 DOM 注入**，classic script，零依赖、无构建。

- 不走 React slot 系统：这个面板需要自定义的密度与布局，而 slot 的容器样式不受控。
- **整个文件包在 IIFE 里**：classic script 的顶层声明会落到 `window` 上，而同页面还有别的
  插件；曾实测过与另一个插件的同名工具函数 `el()` 互相覆盖，导致对方 UI 整个从右下角消失。
  `test/client-scope.test.mjs` 用 `node:vm` 空沙箱把「不留全局符号」这件事锁死。
- 胶囊位置**动态避让**：量出右下角已有常驻组件的盒子，排在它上方；量不到退回 60px。
- 视觉只用 dsh 的 `--dsw-*` 设计变量，明暗主题自动跟随；动态文本一律 `textContent`。
- 首次展开才拉数据；关闭后的快照会标「可能已过期」；所有定时器 / 监听器 / 在飞请求都挂在
  `ctx.effect` 的 disposer 上，HMR 反复挂载不会叠加。

## 7. 本地验证

三层，从便宜到贵：

1. `node --test test/*.test.mjs` —— 安全闸门、归属推断、浏览器半边作用域，全离线。
2. `test/panel-harness.html` —— 不启 dsh 也能渲染面板：内嵌 dsh 真实的明暗两套
   `--dsw-*` 变量，mock 掉模块加载器与宿主，用固定快照驱动 9 种状态，并自带几何/对比度自检。
3. `scripts/verify-isolated.ps1 -Phase full` —— 起一个**隔离实例**（独立 `DSH_HOME` 与
   `portverify` profile，端口 3099），用无头 Edge + CDP 跑端到端断言：插件进入 boot 图、
   两条路由可用、自己起的牺牲监听器被 kill 且端口释放、受保护端口被拒且界面存活、
   抽屉打开后 dsh 界面仍可点击、明暗截图；结束断言端口释放与无遗留进程。
   绝不碰你正在用的桌面端。

安装/卸载走 `scripts/install-desktop.ps1` / `uninstall-desktop.ps1`：备份 profile 清单 →
登记 `dsh.profile.bundles` 与 `file:` 依赖 → 在 profile 的 `node_modules` 下建目录联接。
**必须重启桌面端**才生效（cordis 的 profile 图在进程启动时组装）。
