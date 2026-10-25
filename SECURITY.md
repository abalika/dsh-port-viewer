# 安全说明

这个插件能**结束本机进程**，所以它的威胁模型值得单独说明。

## 它能做什么

- `GET /api/port-viewer/snapshot`：返回本机 TCP 监听端口列表，每条含进程名、PID、命令行、
  工作目录，以及推断出的「所属项目」。
- `POST /api/port-viewer/kill`：接受 `{"targets":[{"port":5173,"pid":1234}]}`，用
  `taskkill /PID <pid> /T /F` 结束进程树。

两条路由都注册在 dsh 自己的 webServer 上，**只监听 dsh 绑定的本地地址**（默认 `127.0.0.1`）。

## 已经做的防护

| 面 | 措施 |
| --- | --- |
| 鉴权 | 两条路由复用 **dsh 自己的会话 cookie**（`ctx.get('connection').authorizeIndex`，与 `/api` 桥、index 服务同一个校验）。桌面壳转发 `/api/*` 时会带上这个 cookie，浏览器侧天然有凭证，本机的其它进程没有。宿主没有 `connection` 服务时自动跳过（退回同源 + CSRF）。<br>历史教训：不要试图用 `webServer.tapIndex` 往 index.html 注入令牌 —— 桌面壳对 `dsh-app://app/` 的主文档是从 `app.asar/renderer` 读盘直供的，只有 `/api/*`、`/plugins/*` 才转发给宿主，注入在桌面端**永远不会执行**，强制令牌必然 100% 401 |
| CSRF | 破坏性请求必须 `content-type: application/json`，且 `Origin`（若有）必须与本机源一致，`Sec-Fetch-Site` 必须是 `same-origin`/`none`。表单与跨源 `fetch` 都打不进来 |
| 误杀系统进程 | `pid <= 4`、已知系统进程名、`%SystemRoot%` 下的可执行文件一律拒绝 |
| 误杀 dsh 自身 | 宿主进程树（Electron 主进程 / renderer / GPU / subprocess）与**正在承载当前界面的端口**一律拒绝；宿主是 node 时不会按 exe 名误伤用户自己的 node 进程 |
| 身份不可知的进程 | 读不到 exe / 命令行的进程（典型是 SYSTEM 账户拉起的服务）标记为 `opaque`，拒绝关闭——`taskkill` 对它本来就是 AccessDenied |
| PID 复用 / TOCTOU | kill 之前用**绕过缓存的新快照**复核「这个端口此刻是否仍属于这个 PID」，不匹配返回 `stale`；`fresh` 采集失败时直接拒绝，绝不回退到旧缓存 |
| 结果可信 | taskkill 之后用「进程还在不在」判定成败，而不是相信退出码（128 既可能是「没有这个进程」，也可能是「拒绝访问」）；taskkill 自身有 5 秒超时 |
| 信息泄露 | 快照里的命令行会抹掉 `sk-…`/`sk_live_…`/`ghp_…`/`AKIA…`/JWT、`*_PASSWORD=`/`*_TOKEN=` 等环境变量、`--token`/`--pass`/`-p`、`Bearer …`、URL 内嵌凭据（`scheme://user:pass@`）；响应带 `cache-control: no-store` |
| 网络路径 | 一律不接受 UNC 路径（`\\host\share`、`\\?\`、`\\.\`）：这些来自别的进程的命令行，去枚举它等于替对方发起 SMB 认证，且会阻塞宿主 |
| 输出注入 | 浏览器半边所有动态文本走 `textContent`，不拼 HTML；服务端响应统一 `application/json` + `nosniff` |
| 资源耗尽 | 快照有 TTL 缓存 + 单飞（并发合并）、采集有超时并在超时后回收 PowerShell 进程树，且带二次截止（防止一次不收盘的子进程把所有后续请求挂死）；kill 单次最多 128 个目标、请求体上限 64 KiB |
| PATH 劫持 | `powershell.exe` / `taskkill.exe` / `netstat.exe` 优先用 `%SystemRoot%\System32` 下的绝对路径 |

## 明确**不**在防护范围内的事

- **同机同用户的本地进程**：它能直接 `taskkill`，本来就不需要这个插件；插件的定位不是
  权限边界。会话鉴权挡住的是**别的登录用户**、低权限服务、以及被页面脚本借刀的路径 ——
  它们拿不到 dsh 的会话 cookie。
- **会话鉴权失效的情形**：如果宿主版本太旧没有 `connection` 服务，插件会退回「同源 + CSRF」，
  此时本机任意进程都能读快照（含命令行）并调用 kill。日志里会有一次性的警示。
- 插件**不会**阻止你关掉自己的 dev server / 数据库 / 容器 —— 那是它的用途。
- `taskkill /T` 会连带子进程：对 `npm run dev` 这类父子结构是必要的，但如果你关的是
  一个多项目共用的父进程，它的子进程也会一起结束。
- **会读其它进程内存**：为了拿工作目录会 `OpenProcess` + `ReadProcessMemory` 读 PEB 的
  `CurrentDirectory`（x64 布局；32 位下直接跳过）。这是 EDR 眼里的敏感行为，属于功能必需，
  不在「防护」范畴。
- 不要把 dsh 的监听地址暴露到局域网/公网（dsh 本身也只绑回环）：令牌是明文放在页面里的，
  一旦有人能读到页面就同时拿到令牌。

## 报告漏洞

请开 issue 描述复现步骤与影响面；如果涉及可利用细节，先不要在公开 issue 里贴 PoC。
这是一个本地工具插件，凡是「需要本机代码执行」的前提都算已知条件，不算漏洞；
真正关心的是**跨源**（网页/其他应用借用户浏览器）、**越权结束受保护进程**、
**信息泄露到非本机**这三类。
