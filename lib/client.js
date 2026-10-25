/**
 * dsh-port-viewer —— 浏览器半边（右下角胶囊 + 右侧端口抽屉）。
 *
 * 这是 classic script：无 import / export / JSX / 构建步骤。shell 的模块加载器把
 * 本文件当「包工厂」注册，materialize 时调用 factory() 取回模块面，再以 cordis
 * 客户端插件的方式调用 apply(ctx)。（与其它 dsh 客户端插件同一形状。）
 *
 * ## 为什么是 DOM 注入
 *
 * 官方 UI 组合机制是 slot 系统（ctx.slots.register + React），需要 React 与构建流程；
 * 本包刻意保持「零依赖、无构建」。shell 的 slot 表里也没有「右下角常驻状态位」。
 * 因此用 position:fixed 的 DOM 注入：所有样式都写在一条 <style> 里，且**全部选择器
 * 都限定在 #dsh-port-viewer-root 之下**，绝不污染 shell。
 *
 * ## 视觉
 *
 * 颜色 100% 来自 dsh 的 --dsw-* 设计变量（明暗主题自动跟随），本文件里唯一出现的
 * 颜色字面量是透明色 transparent。派生色用 color-mix() 从变量算出来，命名一律
 * --pv-*，方便审阅。
 *
 * ## 安全（XSS）
 *
 * 进程名 / 命令行 / 路径 / 端口都来自本机其它进程，属于不可信文本。本文件**不出现
 * innerHTML / outerHTML / insertAdjacentHTML / document.write**：一律 textContent +
 * createElement，SVG 用 createElementNS。
 *
 * ## 数据与交互
 *
 *   GET  /api/port-viewer/snapshot[?fresh=1]   → 契约 §5.4 的视图
 *   POST /api/port-viewer/kill  {"targets":[{"port":5173,"pid":1234}]}
 *
 * 首次展开抽屉时才拉数据（不在页面加载时就扫端口）；关闭端口一律「按 port+pid 成对」
 * 提交，宿主会在执行前用新鲜快照复核这一对是否仍然成立。
 *
 * ## HMR
 *
 * 模块层只有常量与纯函数，没有任何可变状态；挂载与定时器全部登记在 ctx.effect 的
 * disposer 上，重复 apply() 会先移除旧 DOM 与旧 <style>，不会叠出第二个胶囊。
 *
 * ## 为什么整个文件包在一个 IIFE 里（重要，别删）
 *
 * 这是 classic script：没有模块作用域，顶层 `var/function` 全部落到 `window` 上。而同一个
 * 页面里还跑着别的插件 —— 实测过同类插件在顶层也定义了一个同名工具函数
 * `el(tag, style, text)`（把第二参数写进 style 属性），本文件同样需要一个
 * `el(tag, className, text)`。谁后加载谁覆盖，后果是**对方插件的挂件丢掉全部内联样式、
 * 从右下角彻底消失**（反之亦然：我们的 class 会被写进 style，挂件变成没有定位的裸按钮）。
 *
 * 所以这里用 IIFE 把本文件的所有符号关进闭包，绝不与任何插件共享全局名字。
 */

;(function () {
'use strict';

window.__ModuleLoader__.load({
  id: 'dsh-port-viewer',
  factory: function () {
    'use strict';

    return {
      /** 与服务端插件同名，便于在浏览器端 Cordis 里辨识。 */
      name: 'port-viewer',

      /**
       * 客户端插件入口。
       *
       * @param {object} ctx 浏览器端 Cordis 根 Context（只用来登记 effect）。
       */
      apply: function (ctx) {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return startPanel(); }, 'dsh-port-viewer.panel');
          return;
        }
        startPanel();
      },
    };
  },
});

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

var ROOT_ID = 'dsh-port-viewer-root';
var STYLE_ID = 'dsh-port-viewer-style';
var SNAPSHOT_URL = '/api/port-viewer/snapshot';
var KILL_URL = '/api/port-viewer/kill';

/** 宿主 kill 前要重采一次快照、再 taskkill，慢机器上 20 秒是保守值。 */
var REQUEST_TIMEOUT_MS = 20000;
/** 行内二次确认的自动还原时间。 */
var CONFIRM_TIMEOUT_MS = 3000;
/** 自动刷新周期。 */
var AUTO_REFRESH_MS = 5000;
/** 宿主单次 kill 请求的目标数上限（lib/index.js 的 maxTargets 默认值）。 */
var KILL_MAX_TARGETS = 128;
var AUTO_KEY = 'dsh-port-viewer:auto-refresh';
/** 右侧下角已被别人占用时的默认落点（对方胶囊 bottom:16 + 高度 ~30 + 8px 间隙）。 */
var PILL_BOTTOM_FALLBACK = 60;
/** 与右下角其它常驻挂件之间的垂直间隙。 */
var PILL_GAP = 8;
/**
 * 右下角可能已经站着别人的挂件（同类插件、状态胶囊…）。这里列出已知会占用 `bottom:16`
 * 那一带的容器 id：命中就把自己的胶囊排到它上方。没命中就退回 `PILL_BOTTOM_FALLBACK`，
 * 不影响使用。装了什么就加什么，数组顺序即优先级。
 */
var BOTTOM_RIGHT_ANCHOR_IDS = ['dsh-go-svc-widget-root'];
/** 对方插件可能比我们晚挂载：挂载后再补量一次。 */
var PILL_REMEASURE_MS = 1500;
/** 抽屉关着的时候快照会变旧：超过这个年龄就标「可能已过期」并顺手刷一次。 */
var STALE_MS = 30000;
/** 打开抽屉时，快照超过这个年龄就静默刷新一次（避免显示明显过时的数据）。 */
var SOFT_TTL_MS = 10000;
/** 面板内提示条的存活时间。 */
var NOTICE_MS = 6000;

var SVG_NS = 'http://www.w3.org/2000/svg';

/** 关键色都从设计变量派生，避免任何硬编码颜色。 */
var CSS = `
#dsh-port-viewer-root{
  position:fixed;inset:0;z-index:2147483000;pointer-events:none;
  font-family:var(--dsw-font-family);
  font-size:12px;line-height:1.45;letter-spacing:0;
  color:var(--dsw-alias-label-primary);
  -webkit-font-smoothing:antialiased;

  --pv-mono:var(--dsw-font-markdown-code-font-family,var(--ds-font-family-code,Consolas,monospace));
  --pv-hair:var(--dsw-alias-border-l1);
  --pv-hair2:var(--dsw-alias-border-l2);
  --pv-sheet:color-mix(in srgb,var(--dsw-alias-bg-base) 88%,transparent);
  --pv-head-bg:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));
  --pv-foot-bg:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-base));
  --pv-hover:var(--dsw-alias-interactive-bg-hover);
  --pv-chip-bg:var(--dsw-alias-button-ghost-active-fill);
  --pv-warn-fg:color-mix(in srgb,var(--dsw-alias-state-warn-label) 62%,var(--dsw-alias-label-primary));
  --pv-warn-bg:var(--dsw-alias-state-warn-tertiary);
  --pv-danger-fg:var(--dsw-alias-state-error-primary);
  --pv-danger-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);
  --pv-danger-line:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);
  --pv-ok-fg:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-label-primary));
  --pv-ok-bg:var(--dsw-alias-state-success-tertiary);
  --pv-info-fg:var(--dsw-alias-state-business-primary);
  --pv-focus:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
}
#dsh-port-viewer-root *,#dsh-port-viewer-root *::before,#dsh-port-viewer-root *::after{box-sizing:border-box}
#dsh-port-viewer-root [hidden]{display:none !important}
#dsh-port-viewer-root button{
  font-family:inherit;font-size:inherit;line-height:inherit;color:inherit;
  background:none;border:0;padding:0;margin:0;cursor:pointer;
}
#dsh-port-viewer-root :focus-visible{
  outline:var(--dsw-focus-ring-width,2px) solid var(--pv-focus);
  outline-offset:1px;
}
#dsh-port-viewer-root .pv-mono{
  font-family:var(--pv-mono);
  font-variant-numeric:tabular-nums;
  font-feature-settings:"tnum" 1;
}

/* ============================ 启动胶囊 ============================ */

#dsh-port-viewer-root .pv-pill{
  position:fixed;right:16px;bottom:var(--pv-pill-bottom,60px);pointer-events:auto;
  display:inline-flex;align-items:center;gap:7px;
  height:28px;padding:0 11px 0 10px;
  border:1px solid var(--pv-hair2);border-radius:999px;
  background:var(--pv-sheet);
  -webkit-backdrop-filter:blur(10px) saturate(150%);
  backdrop-filter:blur(10px) saturate(150%);
  box-shadow:var(--dsw-shadow-lv2,var(--dsw-shadow-lv3,none));
  color:var(--dsw-alias-label-secondary);
  white-space:nowrap;user-select:none;
  transition:background .14s ease,border-color .14s ease,box-shadow .14s ease,transform .14s ease;
  --pv-dot:var(--dsw-alias-label-caption);
}
#dsh-port-viewer-root .pv-pill:hover{
  background:color-mix(in srgb,var(--dsw-alias-bg-base) 97%,var(--dsw-alias-label-primary));
  border-color:var(--dsw-alias-border-l3);
  box-shadow:var(--dsw-shadow-lv3);
}
#dsh-port-viewer-root .pv-pill:active{transform:scale(.985)}
#dsh-port-viewer-root .pv-pill[data-state=ok]{--pv-dot:var(--dsw-alias-state-success-primary)}
#dsh-port-viewer-root .pv-pill[data-state=warn]{--pv-dot:var(--dsw-alias-state-warn-primary)}
#dsh-port-viewer-root .pv-pill[data-state=error]{--pv-dot:var(--dsw-alias-state-error-primary)}
#dsh-port-viewer-root .pv-pill[data-state=busy]{--pv-dot:var(--dsw-alias-state-business-primary)}
#dsh-port-viewer-root .pv-pill-dot{
  flex:none;width:7px;height:7px;border-radius:50%;
  background:var(--pv-dot);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--pv-dot) 16%,transparent);
  transition:background .2s ease;
}
#dsh-port-viewer-root .pv-pill[data-state=busy] .pv-pill-dot{animation:pv-pulse 1.1s ease-in-out infinite}
#dsh-port-viewer-root .pv-pill-label{color:var(--dsw-alias-label-secondary);font-size:12px}
#dsh-port-viewer-root .pv-pill-count{
  font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);
}
#dsh-port-viewer-root .pv-pill-count.is-dim{color:var(--dsw-alias-label-tertiary);font-weight:500}
#dsh-port-viewer-root .pv-pill-alert{
  font-size:11.5px;font-weight:500;color:var(--pv-warn-fg);
}

/* ============================ 抽屉外壳 ============================ */

#dsh-port-viewer-root .pv-drawer{
  position:fixed;right:16px;top:16px;bottom:16px;pointer-events:auto;
  width:min(520px,calc(100vw - 32px));
  display:flex;flex-direction:column;min-height:300px;overflow:hidden;
  border:1px solid var(--pv-hair2);border-radius:var(--dsw-radius-lg);
  background:var(--pv-sheet);
  -webkit-backdrop-filter:blur(10px) saturate(150%);
  backdrop-filter:blur(10px) saturate(150%);
  box-shadow:var(--dsw-shadow-lv3);
  color:var(--dsw-alias-label-primary);
  animation:pv-drawer-in .17s cubic-bezier(.4,0,.2,1);
}

/* 标题栏 */
#dsh-port-viewer-root .pv-head{
  flex:none;display:flex;align-items:center;gap:8px;
  padding:10px 10px 9px 16px;
  border-bottom:1px solid var(--pv-hair);
}
#dsh-port-viewer-root .pv-title{
  margin:0;font-size:13.5px;line-height:20px;font-weight:600;letter-spacing:.01em;
  color:var(--dsw-alias-label-primary);
}
#dsh-port-viewer-root .pv-chip{
  display:inline-flex;align-items:center;justify-content:center;
  height:18px;min-width:18px;padding:0 5px;border-radius:var(--dsw-radius-xs);
  font-size:10.5px;line-height:18px;font-weight:600;
  background:var(--pv-chip-bg);color:var(--dsw-alias-label-secondary);
}
#dsh-port-viewer-root .pv-chip-warn{
  background:var(--pv-warn-bg);color:var(--pv-warn-fg);font-weight:500;
}
#dsh-port-viewer-root .pv-head-spacer{flex:1 1 auto;min-width:0}
#dsh-port-viewer-root .pv-iconbtn{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:var(--dsw-radius-sm);
  color:var(--dsw-alias-label-tertiary);
  transition:background .12s ease,color .12s ease;
}
#dsh-port-viewer-root .pv-iconbtn:hover{background:var(--pv-hover);color:var(--dsw-alias-label-primary)}
#dsh-port-viewer-root .pv-iconbtn:disabled{cursor:default;opacity:.45;background:none}
#dsh-port-viewer-root .pv-iconbtn[data-spin=true] svg{animation:pv-spin .9s linear infinite}

/* 搜索 */
#dsh-port-viewer-root .pv-search{
  flex:none;display:flex;align-items:center;gap:7px;
  height:32px;padding:0 10px 0 15px;
  border-bottom:1px solid var(--pv-hair);
  color:var(--dsw-alias-label-caption);
  transition:background .12s ease;
}
#dsh-port-viewer-root .pv-search:focus-within{background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}
#dsh-port-viewer-root .pv-search input{
  flex:1 1 auto;min-width:0;height:100%;
  border:0;outline:0;background:transparent;
  font-family:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);
}
#dsh-port-viewer-root .pv-search input::placeholder{color:var(--dsw-alias-label-caption)}
#dsh-port-viewer-root .pv-search-clear{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;border-radius:50%;
  color:var(--dsw-alias-label-caption);
}
#dsh-port-viewer-root .pv-search-clear:hover{background:var(--pv-hover);color:var(--dsw-alias-label-primary)}
#dsh-port-viewer-root .pv-search-hint{
  flex:none;font-size:10px;color:var(--dsw-alias-label-caption);
  border:1px solid var(--pv-hair2);border-radius:4px;padding:0 4px;line-height:14px;
}

/* 提示条（错误 / 成功 / 警告，面板内展示，绝不用 alert） */
#dsh-port-viewer-root .pv-notice{
  flex:none;display:flex;align-items:flex-start;gap:6px;
  margin:8px 10px 2px;padding:6px 8px;
  border-radius:var(--dsw-radius-sm);
  font-size:11.5px;line-height:16px;
}
#dsh-port-viewer-root .pv-notice[data-tone=error]{background:var(--pv-danger-bg);color:var(--pv-danger-fg)}
#dsh-port-viewer-root .pv-notice[data-tone=warn]{background:var(--pv-warn-bg);color:var(--pv-warn-fg)}
#dsh-port-viewer-root .pv-notice[data-tone=success]{background:var(--pv-ok-bg);color:var(--pv-ok-fg)}
#dsh-port-viewer-root .pv-notice-text{flex:1 1 auto;min-width:0;word-break:break-word}
#dsh-port-viewer-root .pv-notice-detail{
  display:block;margin-top:1px;font-size:10.5px;opacity:.75;word-break:break-all;
  font-family:var(--pv-mono);
}

/* 主体滚动区 */
#dsh-port-viewer-root .pv-body{
  flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;
  overscroll-behavior:contain;
  scrollbar-width:thin;
  scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;
  padding:0 0 4px;
}
#dsh-port-viewer-root .pv-body::-webkit-scrollbar{width:8px}
#dsh-port-viewer-root .pv-body::-webkit-scrollbar-thumb{
  background:var(--dsw-alias-scrollbar-bg-l2);border-radius:999px;
  border:2px solid transparent;background-clip:content-box;
}
#dsh-port-viewer-root .pv-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2);background-clip:content-box}
#dsh-port-viewer-root .pv-body::-webkit-scrollbar-track{background:transparent}

/* ============================ 项目分组 ============================ */

#dsh-port-viewer-root .pv-group + .pv-group{border-top:1px solid var(--pv-hair)}
#dsh-port-viewer-root .pv-group-head{
  position:sticky;top:0;z-index:2;
  display:flex;flex-direction:column;gap:1px;
  padding:4px 10px 2px 12px;
  background:var(--pv-head-bg);
  border-bottom:1px solid var(--pv-hair);
}
#dsh-port-viewer-root .pv-group[data-kind=orphan] .pv-group-head{
  box-shadow:inset 2px 0 0 0 var(--dsw-alias-state-warn-primary);
}
#dsh-port-viewer-root .pv-gh{display:flex;align-items:center;gap:2px;min-width:0}
#dsh-port-viewer-root .pv-gtoggle{
  flex:0 1 auto;display:flex;align-items:center;gap:5px;min-width:0;min-height:24px;
  margin-left:-5px;padding:2px 5px;border-radius:var(--dsw-radius-xs);
  text-align:left;
}
#dsh-port-viewer-root .pv-gtoggle:hover{background:var(--pv-hover)}
#dsh-port-viewer-root .pv-caret{
  flex:none;display:inline-flex;color:var(--dsw-alias-label-caption);
  transition:transform .15s ease;
}
#dsh-port-viewer-root .pv-gtoggle[aria-expanded=false] .pv-caret{transform:rotate(-90deg)}
#dsh-port-viewer-root .pv-gname{
  flex:0 1 auto;min-width:0;font-size:13px;line-height:18px;font-weight:600;
  color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
#dsh-port-viewer-root .pv-group[data-kind=orphan] .pv-gname{color:var(--pv-warn-fg)}
#dsh-port-viewer-root .pv-gcount{flex:none;height:16px;min-width:16px;font-size:10px;line-height:16px}
#dsh-port-viewer-root .pv-ghelp{
  flex:none;margin-left:4px;font-size:10.5px;color:var(--dsw-alias-label-caption);
}
#dsh-port-viewer-root .pv-gkill{
  flex:none;margin-left:auto;height:20px;padding:0 7px;border-radius:var(--dsw-radius-xs);
  font-size:11px;color:var(--dsw-alias-label-caption);
  opacity:0;transition:opacity .12s ease,background .12s ease,color .12s ease;
}
#dsh-port-viewer-root .pv-group-head:hover .pv-gkill,
#dsh-port-viewer-root .pv-gkill:focus-visible{opacity:1}
#dsh-port-viewer-root .pv-gkill:hover{background:var(--pv-danger-bg);color:var(--pv-danger-fg)}
#dsh-port-viewer-root .pv-gsub{display:flex;align-items:center;gap:6px;min-width:0;padding-left:16px}
#dsh-port-viewer-root .pv-path{
  flex:0 1 auto;min-width:0;
  font-family:var(--pv-mono);font-size:10.5px;line-height:15px;
  color:var(--dsw-alias-label-tertiary);text-align:left;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  border-radius:3px;padding:0 2px;margin-left:-2px;
}
#dsh-port-viewer-root .pv-path:hover{color:var(--dsw-alias-label-secondary);text-decoration:underline dotted}
#dsh-port-viewer-root .pv-src{
  flex:none;font-size:10px;line-height:15px;color:var(--dsw-alias-label-caption);
}
#dsh-port-viewer-root .pv-src.is-flash{color:var(--pv-ok-fg)}
#dsh-port-viewer-root .pv-ghint{
  flex:1 1 auto;min-width:0;font-size:10.5px;line-height:15px;
  color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
#dsh-port-viewer-root .pv-group[data-kind=orphan] .pv-ghint{color:var(--pv-warn-fg)}

/* 分组级二次确认（替换组头第二行） */
#dsh-port-viewer-root .pv-gconfirm{
  display:flex;align-items:center;gap:7px;min-width:0;padding-left:16px;
  position:relative;
}
#dsh-port-viewer-root .pv-gconfirm::after{
  content:"";position:absolute;left:-12px;right:-10px;bottom:-6px;height:2px;
  background:var(--pv-danger-line);transform-origin:left center;
  animation:pv-countdown var(--pv-count) linear forwards;
}
#dsh-port-viewer-root .pv-gconfirm[data-busy=true]::after{animation:none;opacity:.3}

/* ============================ 端口行 ============================ */

#dsh-port-viewer-root .pv-rows{padding:1px 0 2px}
#dsh-port-viewer-root .pv-row{
  display:grid;
  grid-template-columns:44px minmax(0,1fr) 52px 58px auto 44px;
  align-items:center;column-gap:8px;
  height:28px;margin:0 6px;padding:0 4px 0 6px;
  border-radius:var(--dsw-radius-xs);
  transition:background .1s ease;
}
#dsh-port-viewer-root .pv-row:hover{background:var(--pv-hover)}
#dsh-port-viewer-root .pv-row[data-orphan=true]{box-shadow:inset 2px 0 0 0 color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent)}
#dsh-port-viewer-root .pv-port{
  justify-self:end;max-width:100%;
  font-size:13px;line-height:18px;font-weight:600;letter-spacing:-.02em;
  color:var(--dsw-alias-label-primary);text-decoration:none;
  border-radius:3px;padding:0 2px;margin-right:-2px;
  border-bottom:1px solid transparent;
}
#dsh-port-viewer-root a.pv-port:hover{
  color:var(--dsw-alias-link);
  background:color-mix(in srgb,var(--dsw-alias-link) 9%,transparent);
}
#dsh-port-viewer-root span.pv-port{color:var(--dsw-alias-label-secondary);cursor:default}
#dsh-port-viewer-root .pv-proc{
  display:flex;align-items:baseline;gap:6px;min-width:0;
}
#dsh-port-viewer-root .pv-proc-name{
  min-width:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
#dsh-port-viewer-root .pv-proj{
  flex:none;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);
  max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
#dsh-port-viewer-root .pv-proj::after{content:"·";margin:0 4px;color:var(--dsw-alias-label-caption)}
#dsh-port-viewer-root .pv-pid{
  flex:none;font-size:10.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);
}
#dsh-port-viewer-root .pv-num{
  font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);
  text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
#dsh-port-viewer-root .pv-num.is-dim{color:var(--dsw-alias-label-tertiary)}
#dsh-port-viewer-root .pv-badges{
  display:flex;align-items:center;gap:4px;justify-content:flex-end;min-width:0;
}
#dsh-port-viewer-root .pv-badge{
  flex:none;display:inline-flex;align-items:center;
  height:16px;padding:0 5px;border-radius:var(--dsw-radius-xs);
  font-size:10px;line-height:16px;letter-spacing:.01em;white-space:nowrap;
}
#dsh-port-viewer-root .pv-badge[data-tone=warn]{background:var(--pv-warn-bg);color:var(--pv-warn-fg);font-weight:500}
#dsh-port-viewer-root .pv-badge[data-tone=neutral]{background:var(--pv-chip-bg);color:var(--dsw-alias-label-secondary)}
#dsh-port-viewer-root .pv-badge[data-tone=info]{background:var(--pv-chip-bg);color:var(--pv-info-fg)}
#dsh-port-viewer-root .pv-action{
  display:flex;align-items:center;justify-content:flex-end;min-width:0;
}
#dsh-port-viewer-root .pv-kill{
  height:24px;padding:0 8px;border-radius:var(--dsw-radius-xs);
  font-size:11.5px;line-height:24px;color:var(--dsw-alias-label-caption);
  transition:background .12s ease,color .12s ease;
}
#dsh-port-viewer-root .pv-row:hover .pv-kill{color:var(--dsw-alias-label-secondary)}
#dsh-port-viewer-root .pv-kill:hover,#dsh-port-viewer-root .pv-kill:focus-visible{
  background:var(--pv-danger-bg);color:var(--pv-danger-fg);
}
#dsh-port-viewer-root .pv-kill[disabled]{cursor:default;color:var(--dsw-alias-label-caption);background:none;opacity:.6}
#dsh-port-viewer-root .pv-lock{
  display:inline-flex;color:var(--dsw-alias-label-caption);padding-right:2px;
}

/* 行内二次确认 */
#dsh-port-viewer-root .pv-row.is-confirm{
  display:flex;align-items:center;gap:8px;
  height:28px;padding:0 6px 0 12px;position:relative;overflow:hidden;
  background:var(--pv-danger-bg);
  box-shadow:inset 0 0 0 1px var(--pv-danger-line);
}
#dsh-port-viewer-root .pv-row.is-confirm::after{
  content:"";position:absolute;left:0;right:0;bottom:0;height:2px;
  background:var(--pv-danger-line);transform-origin:left center;
  animation:pv-countdown var(--pv-count) linear forwards;
}
#dsh-port-viewer-root .pv-row.is-confirm[data-busy=true]::after{animation:none;opacity:.35}
#dsh-port-viewer-root .pv-confirm-q{
  flex:1 1 auto;min-width:0;font-size:11.5px;line-height:16px;
  color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
#dsh-port-viewer-root .pv-confirm-q b{
  font-weight:600;color:var(--dsw-alias-label-primary);
}
#dsh-port-viewer-root .pv-btn{
  flex:none;height:24px;padding:0 10px;border-radius:var(--dsw-radius-xs);
  font-size:11.5px;line-height:24px;
  transition:background .12s ease,color .12s ease;
}
#dsh-port-viewer-root .pv-btn-danger{
  color:var(--pv-danger-fg);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);
  box-shadow:inset 0 0 0 1px var(--pv-danger-line);
}
#dsh-port-viewer-root .pv-btn-danger:hover{background:var(--pv-danger-bg);box-shadow:inset 0 0 0 1px var(--pv-danger-fg)}
#dsh-port-viewer-root .pv-btn-ghost{color:var(--dsw-alias-label-secondary)}
#dsh-port-viewer-root .pv-btn-ghost:hover{background:var(--pv-hover);color:var(--dsw-alias-label-primary)}
#dsh-port-viewer-root .pv-btn[disabled]{cursor:default;opacity:.6}

/* 空态 / 加载 / 错误 */
#dsh-port-viewer-root .pv-empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:6px;padding:44px 28px;text-align:center;
  color:var(--dsw-alias-label-caption);
}
#dsh-port-viewer-root .pv-empty-icon{color:var(--dsw-alias-label-dimmed);margin-bottom:2px}
#dsh-port-viewer-root .pv-empty-title{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
#dsh-port-viewer-root .pv-empty-desc{font-size:11px;max-width:34em;line-height:17px}
#dsh-port-viewer-root .pv-empty-action{
  margin-top:4px;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm);
  font-size:11.5px;color:var(--dsw-alias-label-secondary);
  box-shadow:inset 0 0 0 1px var(--pv-hair2);
}
#dsh-port-viewer-root .pv-empty-action:hover{background:var(--pv-hover);color:var(--dsw-alias-label-primary)}
#dsh-port-viewer-root .pv-spinner{
  flex:none;width:14px;height:14px;border-radius:50%;
  border:1.6px solid var(--pv-hair2);
  border-top-color:var(--dsw-alias-state-business-primary);
  animation:pv-spin .8s linear infinite;
}
#dsh-port-viewer-root .pv-loading{
  display:flex;align-items:center;justify-content:center;gap:8px;
  padding:40px 20px;font-size:12px;color:var(--dsw-alias-label-tertiary);
}

/* ============================ 底栏 ============================ */

#dsh-port-viewer-root .pv-warnbar{
  flex:none;display:flex;align-items:center;gap:5px;
  padding:4px 14px 4px 15px;
  border-top:1px solid var(--pv-hair);
  font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption);
  min-width:0;
}
#dsh-port-viewer-root .pv-warnbar-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-port-viewer-root .pv-foot{
  flex:none;display:flex;align-items:center;gap:8px;
  padding:5px 12px 6px 15px;
  border-top:1px solid var(--pv-hair);
  background:var(--pv-foot-bg);
}
#dsh-port-viewer-root .pv-stats{
  flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);
}
#dsh-port-viewer-root .pv-stats-stale{color:var(--pv-warn-fg)}
#dsh-port-viewer-root .pv-auto{
  flex:none;display:inline-flex;align-items:center;gap:5px;min-height:24px;padding:3px 0;
  font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  cursor:pointer;user-select:none;
}
#dsh-port-viewer-root .pv-switch{
  position:relative;flex:none;width:26px;height:15px;border-radius:999px;
  background:var(--dsw-alias-border-l3);
  transition:background .16s ease;
}
#dsh-port-viewer-root .pv-switch::after{
  content:"";position:absolute;top:2px;left:2px;
  width:11px;height:11px;border-radius:50%;
  background:var(--dsw-alias-switch-thumb);
  box-shadow:var(--dsw-elevation-stroke,none);
  transition:transform .16s cubic-bezier(.4,0,.2,1);
}
#dsh-port-viewer-root .pv-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
#dsh-port-viewer-root .pv-switch[aria-checked=true]::after{transform:translateX(11px)}

/* ============================ 动效 ============================ */

@keyframes pv-drawer-in{
  from{opacity:0;transform:translateY(6px)}
  to{opacity:1;transform:none}
}
@keyframes pv-spin{to{transform:rotate(360deg)}}
@keyframes pv-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes pv-countdown{from{transform:scaleX(1)}to{transform:scaleX(0)}}

@media (prefers-reduced-motion:reduce){
  #dsh-port-viewer-root .pv-drawer{animation:none}
  #dsh-port-viewer-root .pv-pill,
  #dsh-port-viewer-root .pv-caret,
  #dsh-port-viewer-root .pv-switch::after{transition:none}
  #dsh-port-viewer-root .pv-iconbtn[data-spin=true] svg,
  #dsh-port-viewer-root .pv-spinner,
  #dsh-port-viewer-root .pv-pill[data-state=busy] .pv-pill-dot{animation:none}
}

@media (max-width:640px){
  #dsh-port-viewer-root .pv-drawer{
    right:8px;left:8px;top:8px;bottom:8px;width:auto;
  }
  #dsh-port-viewer-root .pv-pill{right:8px;bottom:56px}
  #dsh-port-viewer-root .pv-row{grid-template-columns:44px minmax(0,1fr) 48px auto 40px}
  #dsh-port-viewer-root .pv-mem{display:none}
}
`;

/** 图标（Feather 24×24 描边路径，用到时按 size 缩放）。 */
var ICON_SHAPES = {
  chevron: { size: 14, shapes: [{ t: 'path', d: 'M6 9l6 6 6-6' }] },
  close: { size: 14, shapes: [{ t: 'path', d: 'M18 6 6 18M6 6l12 12' }] },
  refresh: { size: 14, shapes: [
    { t: 'path', d: 'M23 4v6h-6' },
    { t: 'path', d: 'M20.5 15a9 9 0 1 1-2.1-9.4L23 10' },
  ] },
  search: { size: 13, shapes: [
    { t: 'circle', cx: 11, cy: 11, r: 7 },
    { t: 'path', d: 'M20 20l-4.3-4.3' },
  ] },
  lock: { size: 11, shapes: [
    { t: 'rect', x: 4.5, y: 10.5, width: 15, height: 10, rx: 2 },
    { t: 'path', d: 'M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5' },
  ] },
  warn: { size: 13, shapes: [
    { t: 'path', d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
    { t: 'path', d: 'M12 9v4M12 17h.01' },
  ] },
  check: { size: 13, shapes: [{ t: 'path', d: 'M20 6 9 17l-5-5' }] },
  power: { size: 26, shapes: [
    { t: 'path', d: 'M18.4 6.6a9 9 0 1 1-12.8 0' },
    { t: 'path', d: 'M12 2v10' },
  ] },
};

/** 项目归属来源 → 中文标签（和 lib/projects.js 的 project.source 取值对应）。 */
var SOURCE_LABEL = {
  cwd: '工作目录',
  cmdline: '命令行',
  parent: '父进程',
  workspace: '工作区',
  'app-dir': '程序目录',
  'image-dir': '可执行目录',
  system: '系统服务',
  none: '未识别',
};

/** protectedReason → 给用户看的解释（宿主 lib/index.js 的稳定错误码）。 */
var PROTECTED_REASON = {
  'system-pid': 'PID ≤ 4 的系统核心进程，关掉会让系统不稳定',
  'system-process': 'Windows 系统服务进程，插件不会关闭它',
  'system-directory': '可执行文件在 C:\\Windows 下，属于系统组件',
  'dsh-self': '这是 dsh 自身的进程，关掉会让当前界面和会话消失',
  'dsh-ui-port': '这是当前界面的端口，关掉会把界面弄掉',
  'opaque-process': '读不到进程身份（通常是 SYSTEM 账户拉起的服务），无法安全关闭',
};

// ---------------------------------------------------------------------------
// 小工具（纯函数，模块级无状态）
// ---------------------------------------------------------------------------

/**
 * 建元素。
 *
 * @param {string} tag 标签名。
 * @param {string} [className] class 列表。
 * @param {string} [text] 文本（一律走 textContent）。
 * @returns {HTMLElement} 新元素。
 */
function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * 建图标：createElementNS + 属性，绝不拼字符串。
 *
 * @param {string} name ICON_SHAPES 的键。
 * @param {number} [size] 覆盖默认尺寸（px）。
 * @returns {SVGElement} 图标节点。
 */
function icon(name, size) {
  var spec = ICON_SHAPES[name];
  var svg = document.createElementNS(SVG_NS, 'svg');
  var box = size || (spec ? spec.size : 14);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(box));
  svg.setAttribute('height', String(box));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.style.display = 'block';
  if (!spec) return svg;
  for (var i = 0; i < spec.shapes.length; i += 1) {
    var shape = spec.shapes[i];
    var node = document.createElementNS(SVG_NS, shape.t);
    for (var key in shape) {
      if (!Object.prototype.hasOwnProperty.call(shape, key) || key === 't') continue;
      node.setAttribute(key, String(shape[key]));
    }
    svg.appendChild(node);
  }
  return svg;
}

/** 清空子节点（不用 innerHTML=''）。 */
function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 内存 → 紧凑人类可读（412 MB / 1.2 GB / 86 MB）。
 *
 * @param {number} bytes workingSetBytes。
 * @returns {string} 显示文本，未知时 '—'。
 */
function fmtBytes(bytes) {
  var n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '—';
  var mb = n / 1048576;
  if (mb < 1) return Math.max(1, Math.round(n / 1024)) + ' KB';
  if (mb < 10) return mb.toFixed(1) + ' MB';
  if (mb < 1024) return Math.round(mb) + ' MB';
  return (mb / 1024).toFixed(1) + ' GB';
}

/**
 * 运行时长 → 紧凑形式（45s / 12m / 2h14m / 3d4h）。
 *
 * @param {number} ms uptimeMs。
 * @returns {string} 显示文本，未知时 '—'。
 */
function fmtUptime(ms) {
  var n = Number(ms);
  if (!isFinite(n) || n < 0) return '—';
  var sec = Math.floor(n / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  var hour = Math.floor(min / 60);
  if (hour < 24) return hour + 'h' + (min % 60 > 0 ? (min % 60) + 'm' : '');
  var day = Math.floor(hour / 24);
  return day + 'd' + (hour % 24 > 0 ? (hour % 24) + 'h' : '');
}

/**
 * ISO 时间 → 本地 HH:MM:SS。
 *
 * @param {string} iso startedAt / generatedAt。
 * @returns {string} 时钟文本，解析不了就 '—'。
 */
function fmtClock(iso) {
  if (typeof iso !== 'string' || iso === '') return '—';
  var date = new Date(iso);
  if (isNaN(date.getTime())) return '—';
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

/** 两位补零。 */
function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

/**
 * 受保护原因 → 解释文案。
 *
 * @param {object} entry 端口条目。
 * @returns {string} 中文解释。
 */
function protectedText(entry) {
  var reason = entry && typeof entry.protectedReason === 'string' ? entry.protectedReason : null;
  if (reason && PROTECTED_REASON[reason]) return PROTECTED_REASON[reason];
  return '受保护的进程或端口，插件不会关闭它';
}

/**
 * 宿主 kill 失败项 → 可直接展示的中文。技术细节（message）留给 title。
 *
 * @param {object} failure `failed[]` 中的一项。
 * @returns {string} 用户能行动的一句话。
 */
function killFailureText(failure) {
  var code = failure && typeof failure.error === 'string' ? failure.error : '';
  var currentPid = failure && failure.currentPid !== undefined && failure.currentPid !== null
    ? String(failure.currentPid) : '';
  if (code === 'protected') return '受保护的进程或端口，插件不会关闭它';
  if (code === 'stale') {
    return currentPid
      ? '端口已经被 PID ' + currentPid + ' 占用，原来那个进程已经不在了'
      : '端口已经不属于那个进程了（可能已经退出）';
  }
  if (code === 'taskkill-failed') return '系统拒绝了关闭请求（可能权限不足，或进程已被保护）';
  if (code === 'already-exited') return '进程已经退出，端口已释放';
  if (code === 'spawn-failed') return '无法执行关闭命令（taskkill 启动失败）';
  return '关闭失败' + (code ? '（' + code + '）' : '');
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------

/**
 * 挂载胶囊 + 抽屉，返回 disposer。
 *
 * @returns {function(): void} 清理函数（移除 DOM / 定时器 / 监听器）。
 */
function startPanel() {
  // HMR / 重复 apply 防护：旧实例先拆干净，避免叠出第二个胶囊。
  var staleRoot = document.getElementById(ROOT_ID);
  if (staleRoot && staleRoot.parentNode) staleRoot.parentNode.removeChild(staleRoot);
  var staleStyle = document.getElementById(STYLE_ID);
  if (staleStyle && staleStyle.parentNode) staleStyle.parentNode.removeChild(staleStyle);

  // ---- 状态（全部在闭包里，模块层不留可变单例） ----
  var state = {
    mounted: false,
    open: false,
    snapshot: null,
    loadedAt: 0,
    loading: false,
    stale: false,
    error: null,
    notice: null,
    query: '',
    collapsed: {},
    confirm: null,
    confirmTimer: null,
    killing: false,
    pending: {},
    auto: readAutoPreference(),
    autoTimer: null,
    noticeTimer: null,
    copyTimer: null,
    offsetTimer: null,
    aborts: [],
  };

  var refs = {};
  var root = el('div');
  root.id = ROOT_ID;
  var styleEl = null;
  var pill = null;
  var drawer = null;

  // ---- 组装静态结构 ----
  pill = buildPill();
  drawer = buildDrawer();
  root.appendChild(pill.node);
  root.appendChild(drawer.node);

  function buildPill() {
    var node = el('button', 'pv-pill');
    node.type = 'button';
    node.setAttribute('aria-expanded', 'false');
    node.setAttribute('aria-label', '端口可视化');
    var dot = el('span', 'pv-pill-dot');
    var label = el('span', 'pv-pill-label', '端口');
    var count = el('span', 'pv-pill-count pv-mono is-dim', '—');
    var alertEl = el('span', 'pv-pill-alert');
    alertEl.hidden = true;
    node.appendChild(dot);
    node.appendChild(label);
    node.appendChild(count);
    node.appendChild(alertEl);
    node.addEventListener('click', function (event) {
      event.stopPropagation();
      if (state.open) close(); else open();
    });
    return { node: node, count: count, alert: alertEl };
  }

  function buildDrawer() {
    var node = el('section', 'pv-drawer');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'false');
    node.setAttribute('aria-label', '端口占用');
    node.hidden = true;

    // 标题栏
    var head = el('header', 'pv-head');
    var title = el('h2', 'pv-title', '端口占用');
    var total = el('span', 'pv-chip pv-mono', '—');
    total.title = '监听端口总数';
    var orphanChip = el('span', 'pv-chip pv-chip-warn', '');
    orphanChip.hidden = true;
    var spacer = el('span', 'pv-head-spacer');
    var refreshBtn = el('button', 'pv-iconbtn');
    refreshBtn.type = 'button';
    refreshBtn.title = '重新扫描端口（强制执行一次采集）';
    refreshBtn.setAttribute('aria-label', '重新扫描端口');
    refreshBtn.appendChild(icon('refresh'));
    var closeBtn = el('button', 'pv-iconbtn');
    closeBtn.type = 'button';
    closeBtn.title = '收起面板（Esc）';
    closeBtn.setAttribute('aria-label', '收起面板');
    closeBtn.appendChild(icon('close'));
    head.appendChild(title);
    head.appendChild(total);
    head.appendChild(orphanChip);
    head.appendChild(spacer);
    head.appendChild(refreshBtn);
    head.appendChild(closeBtn);

    // 搜索
    var search = el('div', 'pv-search');
    search.appendChild(icon('search'));
    var input = el('input');
    input.type = 'text';
    input.setAttribute('placeholder', '搜索端口 / 项目 / 进程 / PID');
    input.setAttribute('aria-label', '搜索端口、项目或进程');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    var clearBtn = el('button', 'pv-search-clear');
    clearBtn.type = 'button';
    clearBtn.title = '清除搜索';
    clearBtn.setAttribute('aria-label', '清除搜索');
    clearBtn.appendChild(icon('close', 12));
    clearBtn.hidden = true;
    var hint = el('span', 'pv-search-hint', 'Esc');
    hint.title = 'Esc 清除搜索 / 收起面板';
    search.appendChild(input);
    search.appendChild(clearBtn);
    search.appendChild(hint);

    // 提示条
    var notice = el('div', 'pv-notice');
    notice.setAttribute('role', 'status');
    notice.hidden = true;

    // 主体
    var body = el('div', 'pv-body');
    body.setAttribute('role', 'group');
    body.setAttribute('aria-label', '端口列表');

    // 警告条
    var warnbar = el('div', 'pv-warnbar');
    warnbar.hidden = true;
    var warnIcon = icon('warn', 12);
    var warnText = el('span', 'pv-warnbar-text');
    warnbar.appendChild(warnIcon);
    warnbar.appendChild(warnText);

    // 底栏
    var foot = el('footer', 'pv-foot');
    var stats = el('span', 'pv-stats', '尚未读取端口');
    var autoWrap = el('span', 'pv-auto');
    autoWrap.title = '每 ' + AUTO_REFRESH_MS / 1000 + ' 秒自动刷新一次（面板打开时生效）';
    var autoLabel = el('span', '', '自动刷新');
    var switchBtn = el('button', 'pv-switch');
    switchBtn.type = 'button';
    switchBtn.setAttribute('role', 'switch');
    switchBtn.setAttribute('aria-label', '自动刷新（每 ' + AUTO_REFRESH_MS / 1000 + ' 秒）');
    switchBtn.setAttribute('aria-checked', state.auto ? 'true' : 'false');
    autoWrap.appendChild(autoLabel);
    autoWrap.appendChild(switchBtn);
    foot.appendChild(stats);
    foot.appendChild(autoWrap);

    node.appendChild(head);
    node.appendChild(search);
    node.appendChild(notice);
    node.appendChild(body);
    node.appendChild(warnbar);
    node.appendChild(foot);

    // ---- 事件 ----
    refreshBtn.addEventListener('click', function () { refresh(true); });
    closeBtn.addEventListener('click', function () { close(); });
    input.addEventListener('input', function () {
      state.query = input.value.trim().toLowerCase();
      clearBtn.hidden = input.value === '';
      renderList();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && input.value !== '') {
        // 输入框里的 Esc 先清搜索，再交给全局处理器（清空后才关面板）。
        event.stopPropagation();
        event.preventDefault();
        input.value = '';
        state.query = '';
        clearBtn.hidden = true;
        renderList();
      }
    });
    clearBtn.addEventListener('click', function () {
      input.value = '';
      state.query = '';
      clearBtn.hidden = true;
      renderList();
      input.focus();
    });
    switchBtn.addEventListener('click', function () {
      state.auto = !state.auto;
      switchBtn.setAttribute('aria-checked', state.auto ? 'true' : 'false');
      writeAutoPreference(state.auto);
      syncAutoTimer();
      if (state.auto && state.open && !state.snapshot) refresh(false);
      if (state.auto || state.snapshot) renderFooter();
    });
    autoWrap.addEventListener('click', function (event) {
      if (event.target === switchBtn) return;
      switchBtn.click();
    });

    refs = {
      node: node,
      head: head,
      total: total,
      orphanChip: orphanChip,
      refreshBtn: refreshBtn,
      closeBtn: closeBtn,
      input: input,
      clearBtn: clearBtn,
      notice: notice,
      body: body,
      warnbar: warnbar,
      warnText: warnText,
      stats: stats,
      switchBtn: switchBtn,
    };
    return { node: node };
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  /** 当前视图（没有成功快照时是 null）。 */
  function view() {
    return state.snapshot && state.snapshot.ok === true ? state.snapshot : null;
  }

  function statsOf(current) {
    var stats = current && current.stats && typeof current.stats === 'object' ? current.stats : {};
    return {
      portCount: typeof stats.portCount === 'number' ? stats.portCount : (current && current.ports ? current.ports.length : 0),
      projectCount: typeof stats.projectCount === 'number' ? stats.projectCount : 0,
      orphanCount: typeof stats.orphanCount === 'number' ? stats.orphanCount : 0,
      protectedCount: typeof stats.protectedCount === 'number' ? stats.protectedCount : 0,
    };
  }

  function renderPill() {
    var current = view();
    var stats = statsOf(current);
    if (current === null) {
      pill.count.textContent = '—';
      pill.count.className = 'pv-pill-count pv-mono is-dim';
      pill.alert.hidden = true;
    } else {
      pill.count.textContent = String(stats.portCount);
      pill.count.className = 'pv-pill-count pv-mono';
      pill.alert.hidden = stats.orphanCount <= 0;
      pill.alert.textContent = stats.orphanCount > 0 ? '· ' + stats.orphanCount + ' 遗留' : '';
    }
    var dotState = 'idle';
    if (state.loading && current === null) dotState = 'busy';
    else if (state.error !== null && current === null) dotState = 'error';
    else if (current !== null && stats.orphanCount > 0) dotState = 'warn';
    else if (current !== null) dotState = 'ok';
    pill.node.setAttribute('data-state', dotState);
    var title = current === null
      ? '端口可视化· 展开查看本机监听端口'
      : '端口占用 · ' + stats.portCount + ' 个端口 / ' + stats.projectCount + ' 个项目'
        + (stats.orphanCount > 0 ? ' · ' + stats.orphanCount + ' 个遗留' : '');
    pill.node.title = title + '（点击展开）';
    pill.node.setAttribute('aria-expanded', state.open ? 'true' : 'false');
  }

  function renderHeader() {
    var current = view();
    var stats = statsOf(current);
    refs.total.textContent = current === null ? '—' : String(stats.portCount);
    refs.orphanChip.hidden = !(current !== null && stats.orphanCount > 0);
    if (current !== null && stats.orphanCount > 0) {
      refs.orphanChip.textContent = stats.orphanCount + ' 遗留';
      refs.orphanChip.title = '父进程已经退出的端口，常见于 agent 跑完没关';
    }
    refs.refreshBtn.disabled = state.loading;
    refs.refreshBtn.setAttribute('data-spin', state.loading ? 'true' : 'false');
    refs.refreshBtn.title = state.loading ? '正在扫描…' : '重新扫描端口（强制执行一次采集）';
  }

  function renderFooter() {
    var current = view();
    var stats = statsOf(current);
    var parts = [];
    if (current === null) {
      parts.push('尚未读取端口');
    } else {
      parts.push('共 ' + stats.portCount + ' 个端口');
      parts.push(stats.projectCount + ' 个项目');
      if (stats.protectedCount > 0) parts.push(stats.protectedCount + ' 个受保护');
      parts.push('更新于 ' + fmtClock(current.generatedAt));
    }
    refs.stats.textContent = parts.join(' · ');
    if (state.stale && current !== null) {
      var stale = el('span', 'pv-stats-stale', ' · 可能已过期');
      refs.stats.appendChild(stale);
    }
    refs.switchBtn.setAttribute('aria-checked', state.auto ? 'true' : 'false');
  }

  function renderNotice() {
    var notice = state.notice;
    if (!notice) {
      refs.notice.hidden = true;
      clear(refs.notice);
      return;
    }
    refs.notice.hidden = false;
    refs.notice.setAttribute('data-tone', notice.tone || 'error');
    clear(refs.notice);
    refs.notice.appendChild(icon(notice.tone === 'success' ? 'check' : 'warn', 13));
    var textWrap = el('div', 'pv-notice-text', notice.message);
    if (notice.detail) {
      var detail = el('span', 'pv-notice-detail', notice.detail);
      textWrap.appendChild(detail);
    }
    refs.notice.appendChild(textWrap);
    refs.notice.title = (notice.hint ? String(notice.hint) + '\n' : '') + '点击关闭这条提示';
    refs.notice.onclick = function () { clearNotice(); };
  }

  function renderWarnings() {
    var current = view();
    var warnings = current && Array.isArray(current.warnings) ? current.warnings : [];
    if (warnings.length === 0) {
      refs.warnbar.hidden = true;
      refs.warnText.textContent = '';
      return;
    }
    refs.warnbar.hidden = false;
    var head = warnings[0];
    refs.warnText.textContent = warnings.length > 1 ? head + '（还有 ' + (warnings.length - 1) + ' 条）' : head;
    refs.warnbar.title = warnings.join('\n');
  }

  /** 全量重绘（结构级）。 */
  function renderAll() {
    renderPill();
    renderHeader();
    renderNotice();
    renderList();
    renderWarnings();
    renderFooter();
  }

  /** 只重绘滚动区（列表 / 空态 / 加载态）。 */
  function renderList() {
    clear(refs.body);

    if (state.loading && view() === null) {
      var loading = el('div', 'pv-loading');
      loading.appendChild(el('span', 'pv-spinner'));
      loading.appendChild(el('span', '', '正在读取监听端口…'));
      refs.body.appendChild(loading);
      return;
    }

    var current = view();
    if (current === null) {
      var failure = el('div', 'pv-empty');
      var failureIcon = el('div', 'pv-empty-icon');
      failureIcon.appendChild(icon('warn', 24));
      failure.appendChild(failureIcon);
      failure.appendChild(el('div', 'pv-empty-title', '读不到端口列表'));
      failure.appendChild(el('div', 'pv-empty-desc',
        state.error ? state.error.message : '请求没有返回数据，稍后重试。'));
      var retry = el('button', 'pv-empty-action', '重试');
      retry.type = 'button';
      retry.addEventListener('click', function () { refresh(true); });
      failure.appendChild(retry);
      refs.body.appendChild(failure);
      return;
    }

    var groups = buildGroups(current, state.query);
    if (groups.length === 0) {
      var empty = el('div', 'pv-empty');
      var emptyIcon = el('div', 'pv-empty-icon');
      emptyIcon.appendChild(icon(state.query ? 'search' : 'power', 24));
      empty.appendChild(emptyIcon);
      if (state.query) {
        empty.appendChild(el('div', 'pv-empty-title', '没有匹配的端口'));
        empty.appendChild(el('div', 'pv-empty-desc',
          '试试端口号、项目名、进程名或 PID。当前筛选：「' + state.query + '」'));
        var reset = el('button', 'pv-empty-action', '清除筛选');
        reset.type = 'button';
        reset.addEventListener('click', function () {
          refs.input.value = '';
          state.query = '';
          refs.clearBtn.hidden = true;
          renderList();
        });
        empty.appendChild(reset);
      } else {
        empty.appendChild(el('div', 'pv-empty-title', '没有发现监听端口'));
        empty.appendChild(el('div', 'pv-empty-desc', '本机目前没有任何 TCP 监听端口。'));
      }
      refs.body.appendChild(empty);
      return;
    }

    for (var i = 0; i < groups.length; i += 1) {
      refs.body.appendChild(renderGroup(groups[i]));
    }
  }

  /**
   * 把端口条目整理成渲染用的分组。
   *
   * 分组优先级（也就是渲染顺序）：
   *   1. 遗留（orphan）—— 置顶，最需要对用户喊话；
   *   2. 用户项目（按名字稳定排序，便于每次打开都能快速定位）；
   *   3. 未识别项目 —— 读不到工作目录的端口，放最后但不丢弃；
   *   4. Windows 系统 —— collector 合并出来的系统端口组，默认收起、永远垫底，
   *      让面板第一眼看到的全是用户自己的东西。
   *
   * @param {object} current 视图。
   * @param {string} query 已小写化的搜索词。
   * @returns {Array<object>} 分组数组。
   */
  function buildGroups(current, query) {
    var ports = Array.isArray(current.ports) ? current.ports : [];
    var matched = [];
    for (var i = 0; i < ports.length; i += 1) {
      var entry = ports[i];
      if (!entry || typeof entry !== 'object') continue;
      if (query === '' || matchesQuery(entry, query)) matched.push(entry);
    }

    var orphanEntries = [];
    var unknownEntries = [];
    var systemEntries = [];
    var buckets = {};
    var order = [];
    for (var j = 0; j < matched.length; j += 1) {
      var item = matched[j];
      var flags = item.flags && typeof item.flags === 'object' ? item.flags : {};
      if (flags.orphan) { orphanEntries.push(item); continue; }
      var project = item.project && typeof item.project === 'object' ? item.project : {};
      var source = typeof project.source === 'string' ? project.source : 'none';
      var root = typeof project.root === 'string' && project.root !== '' ? project.root : null;
      if (source === 'system') { systemEntries.push(item); continue; }
      if (source === 'none' || root === null) { unknownEntries.push(item); continue; }
      var key = String(project.key || root).toLowerCase();
      var bucket = buckets[key];
      if (!bucket) {
        bucket = buckets[key] = {
          id: 'project:' + key,
          kind: 'project',
          name: typeof project.name === 'string' && project.name !== '' ? project.name : root,
          root: root,
          source: source,
          entries: [],
          killable: 0,
        };
        order.push(bucket);
      }
      bucket.entries.push(item);
    }

    var groups = [];
    if (orphanEntries.length > 0) {
      groups.push(makeVirtualGroup('orphan', '遗留端口', orphanEntries,
        '父进程已退出，可能是 agent 跑完没收'));
    }

    order.sort(function (left, right) {
      return String(left.name).localeCompare(String(right.name), 'zh-Hans-CN');
    });
    for (var k = 0; k < order.length; k += 1) groups.push(order[k]);

    if (unknownEntries.length > 0) {
      groups.push(makeVirtualGroup('unknown', '未识别项目', unknownEntries,
        '读不到工作目录，按进程名归组'));
    }
    if (systemEntries.length > 0) {
      var systemGroup = makeVirtualGroup('system', 'Windows 系统', systemEntries,
        'Windows 服务进程，全部受保护，不会被关闭');
      systemGroup.source = 'system';
      groups.push(systemGroup);
    }

    for (var g = 0; g < groups.length; g += 1) {
      groups[g].killable = countKillable(groups[g].entries);
      var stored = state.collapsed[groups[g].id];
      if (query !== '') {
        groups[g].collapsed = false; // 搜索时强制展开，折叠无意义
      } else if (stored === undefined) {
        groups[g].collapsed = groups[g].kind === 'system'; // 系统噪音默认收起
      } else {
        groups[g].collapsed = stored === true;
      }
    }
    return groups;
  }

  /** 虚拟分组（遗留 / 未识别）。 */
  function makeVirtualGroup(kind, name, entries, hint) {
    return {
      id: 'virtual:' + kind,
      kind: kind,
      name: name,
      root: null,
      source: null,
      hint: hint,
      entries: entries,
      killable: 0,
      collapsed: false,
    };
  }

  function countKillable(entries) {
    var count = 0;
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i] && entries[i].killable === true) count += 1;
    }
    return count;
  }

  /**
   * 搜索匹配：端口 / 进程名 / PID / 项目名 / 路径 / 命令行 / url。
   *
   * @param {object} entry 端口条目。
   * @param {string} query 已小写化的搜索词。
   * @returns {boolean} 是否命中。
   */
  function matchesQuery(entry, query) {
    var project = entry.project && typeof entry.project === 'object' ? entry.project : {};
    var haystack = [
      entry.port === undefined ? '' : String(entry.port),
      entry.processName || '',
      entry.pid === undefined || entry.pid === null ? '' : String(entry.pid),
      project.name || '',
      project.root || '',
      entry.cwd || '',
      entry.commandLine || '',
      entry.url || '',
      entry.kind || '',
    ].join(' ').toLowerCase();
    return haystack.indexOf(query) >= 0;
  }

  /** 渲染一个分组（组头 + 行 + 可选的组内确认）。 */
  function renderGroup(group) {
    var wrap = el('div', 'pv-group');
    wrap.setAttribute('data-kind', group.kind);
    wrap.setAttribute('data-group', group.id);
    wrap.appendChild(renderGroupHead(group));
    if (group.collapsed) return wrap;

    var rows = el('div', 'pv-rows');
    for (var i = 0; i < group.entries.length; i += 1) {
      rows.appendChild(renderRow(group.entries[i], group));
    }
    wrap.appendChild(rows);
    return wrap;
  }

  /** 组头：项目名 + 端口数 + 路径/说明 + 「关闭全部」。 */
  function renderGroupHead(group) {
    var head = el('div', 'pv-group-head');
    var line = el('div', 'pv-gh');

    var toggle = el('button', 'pv-gtoggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', group.collapsed ? 'false' : 'true');
    toggle.title = group.collapsed ? '展开这个分组' : '收起这个分组';
    toggle.appendChild(withClass(icon('chevron'), 'pv-caret'));
    toggle.appendChild(el('span', 'pv-gname', group.name));
    var count = el('span', 'pv-chip pv-gcount pv-mono', String(group.entries.length));
    count.title = group.entries.length + ' 个端口，其中 ' + group.killable + ' 个可关闭';
    toggle.appendChild(count);
    toggle.addEventListener('click', function () {
      if (state.query !== '') return; // 搜索时强制展开，折叠无意义
      state.collapsed[group.id] = !group.collapsed;
      group.collapsed = !group.collapsed;
      renderList();
    });
    line.appendChild(toggle);

    if (group.kind === 'project' && group.source) {
      var srcHint = el('span', 'pv-ghelp', '· ' + (SOURCE_LABEL[group.source] || group.source));
      srcHint.title = '项目归属依据：' + (SOURCE_LABEL[group.source] || group.source);
      line.appendChild(srcHint);
    }

    var confirming = state.confirm !== null && state.confirm.kind === 'group'
      && state.confirm.groupId === group.id;
    if (!confirming && group.killable > 0) {
      var killAll = el('button', 'pv-gkill', '关闭全部');
      killAll.type = 'button';
      killAll.title = '关闭「' + group.name + '」下 ' + group.killable + ' 个可关闭的端口';
      killAll.addEventListener('click', function () {
        startGroupConfirm(group);
      });
      line.appendChild(killAll);
    }
    head.appendChild(line);

    if (confirming) head.appendChild(renderGroupConfirm(group));
    else head.appendChild(renderGroupSub(group));
    return head;
  }

  /** 组头第二行：路径（可点击复制）+ 来源；虚拟分组用一句说明。 */
  function renderGroupSub(group) {
    var sub = el('div', 'pv-gsub');
    if (group.kind === 'project' && group.root) {
      var path = el('button', 'pv-path', group.root);
      path.type = 'button';
      path.title = group.root + '\n点击复制路径';
      path.addEventListener('click', function () {
        copyText(group.root).then(function (ok) {
          flashSource(sub, ok ? '已复制' : '复制失败');
        });
      });
      sub.appendChild(path);
      sub.appendChild(el('span', 'pv-src', '· ' + (SOURCE_LABEL[group.source] || group.source || '')));
      return sub;
    }
    sub.appendChild(el('span', 'pv-ghint', group.hint || ''));
    return sub;
  }

  /** 组内二次确认（替换组头第二行）。 */
  function renderGroupConfirm(group) {
    var wrap = el('div', 'pv-gconfirm');
    wrap.style.setProperty('--pv-count', (CONFIRM_TIMEOUT_MS / 1000) + 's');
    wrap.setAttribute('data-busy', state.killing ? 'true' : 'false');
    var question = el('span', 'pv-confirm-q');
    var groupTargets = collectGroupTargets(group);
    question.appendChild(el('span', '', '关闭 ' + groupTargets.length + ' 个端口？'));
    wrap.appendChild(question);
    wrap.appendChild(confirmButtons(group.name + ' 下的 ' + groupTargets.length + ' 个端口', groupTargets,
      state.confirm.key, 'group'));
    return wrap;
  }

  function collectGroupTargets(group) {
    var targets = [];
    for (var i = 0; i < group.entries.length; i += 1) {
      var entry = group.entries[i];
      if (!entry || entry.killable !== true) continue;
      targets.push({ port: Number(entry.port), pid: Number(entry.pid) });
      // 宿主单次请求有目标上限（默认 128），超了会被 400 拒绝。这里截断，
      // 确认文案用的是同一份列表，所以不会出现「说 150 实际关 128」。
      if (targets.length >= KILL_MAX_TARGETS) break;
    }
    return targets;
  }

  function startGroupConfirm(group) {
    var key = 'group:' + group.id;
    if (state.confirmTimer !== null) clearTimeout(state.confirmTimer);
    state.confirm = {
      kind: 'group',
      groupId: group.id,
      key: key,
      label: group.name,
      targets: collectGroupTargets(group),
    };
    state.confirmTimer = setTimeout(function () {
      state.confirmTimer = null;
      state.confirm = null;
      renderList();
    }, CONFIRM_TIMEOUT_MS);
    renderList();
  }

  /** 渲染一行端口。 */
  function renderRow(entry, group) {
    var key = rowKey(entry);
    var confirming = state.confirm !== null && state.confirm.kind === 'port' && state.confirm.key === key;
    if (confirming) return renderConfirmRow(entry, group, key);

    var flags = entry.flags && typeof entry.flags === 'object' ? entry.flags : {};
    var row = el('div', 'pv-row');
    row.setAttribute('data-port', entry.port === undefined ? '' : String(entry.port));
    row.setAttribute('data-pid', entry.pid === undefined || entry.pid === null ? '' : String(entry.pid));
    if (flags.orphan) row.setAttribute('data-orphan', 'true');

    // 1) 端口号（有 http url 时可点开）
    var bindings = Array.isArray(entry.bindings) ? entry.bindings.join(', ') : '';
    var portText = String(entry.port === undefined ? '?' : entry.port);
    if (typeof entry.url === 'string' && entry.url !== '') {
      var link = el('a', 'pv-port pv-mono', portText);
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.title = '在浏览器打开 ' + entry.url + (bindings ? '\n监听 ' + bindings : '');
      row.appendChild(link);
    } else {
      var plain = el('span', 'pv-port pv-mono', portText);
      plain.title = 'TCP ' + portText + (bindings ? '\n监听 ' + bindings : '') + '\n非 HTTP 端口，不能直接打开';
      row.appendChild(plain);
    }

    // 2) 进程名 + PID（遗留/未识别分组里补项目名，避免丢失归属信息）
    var proc = el('span', 'pv-proc');
    var project = entry.project && typeof entry.project === 'object' ? entry.project : {};
    if ((group.kind === 'orphan' || group.kind === 'unknown')
      && typeof project.name === 'string' && project.name !== ''
      && project.name !== entry.processName) {
      proc.appendChild(el('span', 'pv-proj', project.name));
    }
    proc.appendChild(el('span', 'pv-proc-name', entry.processName || '未知进程'));
    proc.appendChild(el('span', 'pv-pid pv-mono', '#' + String(entry.pid === undefined || entry.pid === null ? '?' : entry.pid)));
    proc.title = describeProcess(entry, bindings);
    row.appendChild(proc);

    // 3) 运行时长
    var uptime = el('span', 'pv-num pv-mono', fmtUptime(entry.uptimeMs));
    if (entry.startedAt) uptime.title = '启动于 ' + fmtClock(entry.startedAt);
    row.appendChild(uptime);

    // 4) 内存
    var mem = fmtBytes(entry.workingSetBytes);
    var memNode = el('span', 'pv-num pv-mono pv-mem' + (mem === '—' ? ' is-dim' : ''), mem);
    memNode.title = mem === '—' ? '读不到这个进程的工作集内存' : '工作集内存 ' + mem;
    row.appendChild(memNode);

    // 5) 徽标
    var badges = el('span', 'pv-badges');
    var list = badgeList(entry);
    for (var i = 0; i < list.length; i += 1) {
      var badge = el('span', 'pv-badge', list[i].text);
      badge.setAttribute('data-tone', list[i].tone);
      if (list[i].title) badge.title = list[i].title;
      badges.appendChild(badge);
    }
    row.appendChild(badges);

    // 6) 操作
    var action = el('span', 'pv-action');
    if (entry.killable === true) {
      var pending = state.pending[key] === true;
      var killBtn = el('button', 'pv-kill', pending ? '关闭中…' : '关闭');
      killBtn.type = 'button';
      killBtn.disabled = pending || state.killing;
      killBtn.title = '关闭 ' + portText + '（' + (entry.processName || '未知进程') + ' · PID ' + String(entry.pid) + '）';
      killBtn.addEventListener('click', function () {
        startRowConfirm(entry, group, key);
      });
      action.appendChild(killBtn);
    } else {
      var lock = el('span', 'pv-lock');
      lock.title = protectedText(entry);
      lock.appendChild(icon('lock'));
      action.appendChild(lock);
    }
    row.appendChild(action);

    return row;
  }

  /** 行内二次确认：替换整行内容（不弹全局模态框）。 */
  function renderConfirmRow(entry, group, key) {
    var row = el('div', 'pv-row is-confirm');
    row.setAttribute('data-port', entry.port === undefined ? '' : String(entry.port));
    row.setAttribute('data-pid', entry.pid === undefined || entry.pid === null ? '' : String(entry.pid));
    row.style.setProperty('--pv-count', (CONFIRM_TIMEOUT_MS / 1000) + 's');
    row.setAttribute('data-busy', state.killing ? 'true' : 'false');

    var question = el('span', 'pv-confirm-q');
    question.appendChild(el('span', '', '关闭 '));
    question.appendChild(el('b', '', String(entry.port)));
    question.appendChild(el('span', '',
      '（' + (entry.processName || '未知进程') + ' · PID ' + String(entry.pid) + '）？'));
    row.appendChild(question);

    var targets = [{ port: Number(entry.port), pid: Number(entry.pid) }];
    row.appendChild(confirmButtons('端口 ' + String(entry.port), targets, key, 'port'));
    return row;
  }

  /** 「确认关闭 / 取消」按钮组。 */
  function confirmButtons(label, targets, key, kind) {
    var wrap = el('span', 'pv-confirm-actions');
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';
    wrap.style.flex = 'none';

    var confirm = el('button', 'pv-btn pv-btn-danger', state.killing ? '关闭中…' : '确认关闭');
    confirm.type = 'button';
    confirm.disabled = state.killing;
    confirm.title = '确认关闭' + label.replace(/^端口 /, '端口 ');
    confirm.addEventListener('click', function () {
      kill(targets);
    });

    var cancel = el('button', 'pv-btn pv-btn-ghost', '取消');
    cancel.type = 'button';
    cancel.disabled = state.killing;
    cancel.title = '取消（' + CONFIRM_TIMEOUT_MS / 1000 + ' 秒后自动取消）';
    cancel.addEventListener('click', function () {
      cancelConfirm();
    });

    wrap.appendChild(confirm);
    wrap.appendChild(cancel);
    wrap.setAttribute('data-key', key);
    wrap.setAttribute('data-kind', kind);
    return wrap;
  }

  function startRowConfirm(entry, group, key) {
    if (state.confirmTimer !== null) clearTimeout(state.confirmTimer);
    state.confirm = {
      kind: 'port',
      key: key,
      groupId: group.id,
      targets: [{ port: Number(entry.port), pid: Number(entry.pid) }],
    };
    state.confirmTimer = setTimeout(function () {
      state.confirmTimer = null;
      state.confirm = null;
      renderList();
    }, CONFIRM_TIMEOUT_MS);
    renderList();
  }

  function cancelConfirm() {
    if (state.confirmTimer !== null) clearTimeout(state.confirmTimer);
    state.confirmTimer = null;
    if (state.confirm === null) return;
    state.confirm = null;
    renderList();
  }

  /** 行 key：port + pid 成对（同一端口可能被多个 PID 监听）。 */
  function rowKey(entry) {
    return String(entry.port) + ':' + String(entry.pid);
  }

  /** 行徽标：状态徽标（遗留/系统/受保护）+ 至多一个信息徽标。 */
  function badgeList(entry) {
    var flags = entry.flags && typeof entry.flags === 'object' ? entry.flags : {};
    var out = [];
    if (flags.orphan) {
      out.push({
        text: '遗留',
        tone: 'warn',
        title: (entry.orphanReason ? entry.orphanReason + '。' : '父进程已退出。') + '可能是 agent 跑完没收',
      });
    }
    if (flags.protected) {
      if (flags.system) {
        out.push({ text: '系统', tone: 'neutral', title: protectedText(entry) });
      } else {
        out.push({ text: '受保护', tone: 'neutral', title: protectedText(entry) });
      }
    }
    if (entry.kind === 'database') {
      out.push({ text: '数据库', tone: 'neutral', title: '数据库端口，不是 HTTP 服务，不能直接打开' });
    } else if (entry.kind === 'docker') {
      out.push({ text: '容器', tone: 'neutral', title: '容器映射出来的端口' });
    } else if (!flags.protected && flags.wildcard && !flags.loopbackOnly) {
      out.push({ text: '对外', tone: 'info', title: '绑定在 0.0.0.0/[::]，局域网内其它机器可以访问' });
    }
    return out.slice(0, 2);
  }

  /** 行悬浮提示：可执行文件 / 工作目录 / 命令行。 */
  function describeProcess(entry, bindings) {
    var lines = [];
    lines.push((entry.processName || '未知进程') + ' · PID ' + String(entry.pid));
    if (bindings) lines.push('监听 ' + bindings);
    if (entry.exePath) lines.push('可执行文件 ' + entry.exePath);
    if (entry.cwd) lines.push('工作目录 ' + entry.cwd);
    if (entry.commandLine) {
      var cmd = String(entry.commandLine);
      lines.push('命令行 ' + (cmd.length > 220 ? cmd.slice(0, 220) + '…' : cmd));
    }
    return lines.join('\n');
  }

  /** 复制路径后的短暂反馈（就地换掉来源标签）。 */
  function flashSource(parent, text) {
    var label = parent.querySelector('.pv-src') || parent.querySelector('.pv-ghint');
    if (!label) return;
    var original = label.textContent;
    label.textContent = text;
    label.className = (label.className.replace(' is-flash', '')) + ' is-flash';
    if (state.copyTimer !== null) clearTimeout(state.copyTimer);
    state.copyTimer = setTimeout(function () {
      state.copyTimer = null;
      label.textContent = original;
      label.className = label.className.replace(' is-flash', '');
    }, 1200);
  }

  function withClass(node, className) {
    node.setAttribute('class', className);
    return node;
  }

  // -------------------------------------------------------------------------
  // 数据
  // -------------------------------------------------------------------------

  /**
   * 统一的一次性 JSON 请求：超时、中止、非 JSON 响应都折叠成结构化结果。
   *
   * @param {string} url 同源地址。
   * @param {object} init fetch 选项。
   * @param {number} timeoutMs 超时毫秒数。
   * @returns {Promise<object>} `{res, body, aborted, error}`。
   */
  function requestJson(url, init, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    // 默认头 + 鉴权头 + 调用方头，逐层覆盖（调用方显式给的同名头优先）。
    var headers = { accept: 'application/json' };
    if (init && init.headers) {
      for (var name in init.headers) {
        if (Object.prototype.hasOwnProperty.call(init.headers, name)) headers[name] = init.headers[name];
      }
    }
    var options = { headers: headers };
    if (init) {
      for (var key in init) {
        if (key === 'headers') continue;
        if (Object.prototype.hasOwnProperty.call(init, key)) options[key] = init[key];
      }
    }
    options.signal = controller.signal;
    state.aborts.push(controller);

    function settle() {
      clearTimeout(timer);
      var index = state.aborts.indexOf(controller);
      if (index >= 0) state.aborts.splice(index, 1);
    }

    return fetch(url, options).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        if (text) {
          try { body = JSON.parse(text); } catch (_error) { body = null; }
        }
        return { res: res, body: body, aborted: false, error: null };
      }, function () {
        return { res: res, body: null, aborted: false, error: null };
      });
    }, function (error) {
      var aborted = controller.signal.aborted === true || (error && error.name === 'AbortError');
      return { res: null, body: null, aborted: aborted, error: error || null };
    }).then(function (result) {
      settle();
      return result;
    });
  }

  /**
   * 拉快照。
   *
   * @param {boolean} fresh true 时带 `?fresh=1` 强制重采（下拉刷新按钮用）。
   */
  function refresh(fresh) {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    renderPill();
    renderHeader();
    renderList();
    // 只清「上一次读取失败」这类提示；关闭成功/失败的结果要留够时间给用户看。
    if (state.notice && state.notice.source === 'refresh') clearNotice();

    var url = SNAPSHOT_URL + (fresh === true ? '?fresh=1' : '');
    requestJson(url, { method: 'GET' }, REQUEST_TIMEOUT_MS).then(function (result) {
      state.loading = false;
      if (result.aborted) {
        state.error = { message: '读取超时（' + Math.round(REQUEST_TIMEOUT_MS / 1000) + ' 秒），端口没变化就不影响使用。', detail: '' };
      } else if (result.res === null) {
        state.error = {
          message: '连不上 dsh 服务，确认桌面端还在运行。',
          detail: result.error && result.error.message ? String(result.error.message) : '',
        };
      } else if (result.res.status === 401) {
        // 路由复用 dsh 自己的会话 cookie（桌面壳转发时带的是同一个），401 = 会话过期/被清。
        state.error = {
          message: '当前会话已失效，刷新一次页面就好。',
          detail: 'HTTP 401：端口路由复用 dsh 的会话 cookie，页面刷新会重新认证。',
        };
      } else if (result.res.ok !== true || result.body === null || result.body.ok !== true) {
        var body = result.body || {};
        state.error = {
          message: '读取端口失败' + (body.code ? '（' + body.code + '）' : '') + '，可以稍后重试。',
          detail: typeof body.error === 'string' ? body.error : 'HTTP ' + String(result.res.status),
        };
      } else {
        state.snapshot = result.body;
        state.loadedAt = Date.now();
        state.stale = false;
        state.error = null;
        if (state.notice && state.notice.source === 'refresh') clearNotice();
      }
      if (state.error !== null && view() !== null) {
        // 有旧数据时不要用错误覆盖列表，只在提示条里说明这次没刷新成功。
        setNotice({ tone: 'warn', message: state.error.message, detail: state.error.detail, source: 'refresh' });
      }
      renderAll();
      syncAutoTimer();
    });
  }

  /**
   * 关闭端口：按 port+pid 成对提交，逐条渲染宿主返回的结果。
   *
   * @param {Array<object>} targets `[{port, pid}]`。
   */
  function kill(targets) {
    if (state.killing || !Array.isArray(targets) || targets.length === 0) return;
    var pending = {};
    for (var i = 0; i < targets.length; i += 1) pending[rowKey(targets[i])] = true;
    state.pending = pending;
    state.killing = true;
    if (state.confirmTimer !== null) clearTimeout(state.confirmTimer);
    state.confirmTimer = null;
    state.confirm = null;
    clearNotice();
    renderList();

    requestJson(KILL_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ targets: targets }),
    }, REQUEST_TIMEOUT_MS).then(function (result) {
      state.killing = false;
      state.pending = {};

      if (result.aborted) {
        setNotice({
          tone: 'warn',
          message: '关闭请求超时，结果未知。列表已重新读取，请确认端口是否还在。',
          detail: '',
          source: 'action',
        });
        refresh(false);
        return;
      }
      if (result.res !== null && result.res.status === 401) {
        setNotice({
          tone: 'error',
          message: '当前会话已失效，这次没有关闭任何端口。刷新页面后重试。',
          detail: 'HTTP 401：端口路由复用 dsh 的会话 cookie。',
          source: 'action',
        });
        renderList();
        return;
      }
      if (result.res === null || result.body === null) {
        setNotice({
          tone: 'error',
          message: '关闭请求没有送达 dsh 服务。',
          detail: result.error && result.error.message ? String(result.error.message) : '',
          source: 'action',
        });
        renderList();
        return;
      }
      var body = result.body;
      var failed = Array.isArray(body.failed) ? body.failed : [];
      var results = Array.isArray(body.results) ? body.results : [];
      var killed = typeof body.killed === 'number' ? body.killed : results.length;

      if (failed.length === 0 && killed > 0) {
        setNotice({
          tone: 'success',
          message: killed === 1 ? '端口已关闭' : '已关闭 ' + killed + ' 个端口',
          detail: '',
          source: 'action',
        });
      } else if (failed.length > 0) {
        var messages = [];
        var details = [];
        for (var j = 0; j < failed.length; j += 1) {
          var one = failed[j] || {};
          var prefix = failed.length > 1 ? '端口 ' + String(one.port) + '：' : '';
          messages.push(prefix + killFailureText(one));
          if (typeof one.message === 'string' && one.message !== '') details.push(one.message);
        }
        var message = messages.join('；');
        if (killed > 0) message = '已关闭 ' + killed + ' 个，另外 ' + messages.join('；');
        setNotice({
          tone: killed > 0 ? 'warn' : 'error',
          message: message,
          detail: '',
          hint: details.length > 0 ? details.join(' · ') : '',
          source: 'action',
        });
      } else if (body.ok !== true) {
        setNotice({
          tone: 'error',
          message: '关闭失败' + (body.error ? '：' + String(body.error) : '，宿主没有返回结果。'),
          detail: typeof body.code === 'string' ? body.code : '',
          source: 'action',
        });
      }
      renderAll();
      refresh(false);
    });
  }

  /**
   * 提示条：显示一条会自己消失的消息（错误 / 成功 / 警告都走这里）。
   *
   * @param {object} notice `{tone, message, detail}`。
   */
  function setNotice(notice) {
    state.notice = notice;
    if (state.noticeTimer !== null) clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(function () {
      state.noticeTimer = null;
      state.notice = null;
      renderNotice();
    }, NOTICE_MS);
    renderNotice();
  }

  function clearNotice() {
    if (state.noticeTimer !== null) clearTimeout(state.noticeTimer);
    state.noticeTimer = null;
    state.notice = null;
    renderNotice();
  }

  // -------------------------------------------------------------------------
  // 开关 / 对话
  // -------------------------------------------------------------------------

  function open() {
    if (state.open) return;
    state.open = true;
    pill.node.hidden = true;
    drawer.node.hidden = false;
    // 展开时顺手补量一次：对方插件可能在这次会话里才挂载/改变高度。
    syncPillOffset();
    renderAll();
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    // 首次展开才拉数据：不在页面加载时就扫端口。
    if (state.snapshot === null) {
      refresh(false);
    } else {
      var age = Date.now() - state.loadedAt;
      if (age > STALE_MS) {
        state.stale = true;
        renderFooter();
        refresh(false);
      } else if (age > SOFT_TTL_MS) {
        refresh(false);
      }
    }
    syncAutoTimer();
    if (state.query === '') {
      try { refs.input.focus({ preventScroll: true }); } catch (_error) { refs.input.focus(); }
    }
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    cancelConfirm();
    drawer.node.hidden = true;
    pill.node.hidden = false;
    renderPill();
    syncAutoTimer();
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    try { pill.node.focus({ preventScroll: true }); } catch (_error) { /* 焦点无所谓 */ }
  }

  function onKeydown(event) {
    if (event.key !== 'Escape' || !state.open) return;
    if (state.confirm !== null) {
      event.preventDefault();
      cancelConfirm();
      return;
    }
    if (refs.input.value !== '') {
      event.preventDefault();
      refs.input.value = '';
      state.query = '';
      refs.clearBtn.hidden = true;
      renderList();
      return;
    }
    event.preventDefault();
    close();
  }

  function onDocPointerDown(event) {
    if (!state.open) return;
    if (drawer.node.contains(event.target)) return;
    if (pill.node.contains(event.target)) return;
    close();
  }

  function syncAutoTimer() {
    var shouldRun = state.open === true && state.auto === true;
    if (shouldRun && state.autoTimer === null) {
      state.autoTimer = setInterval(function () {
        if (state.killing || state.confirm !== null || state.loading) return;
        refresh(false);
      }, AUTO_REFRESH_MS);
    } else if (!shouldRun && state.autoTimer !== null) {
      clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // 偏好 / 剪贴板
  // -------------------------------------------------------------------------

  function readAutoPreference() {
    try {
      return window.localStorage.getItem(AUTO_KEY) === '1';
    } catch (_error) {
      return false;
    }
  }

  function writeAutoPreference(value) {
    try {
      window.localStorage.setItem(AUTO_KEY, value ? '1' : '0');
    } catch (_error) { /* 隐私模式下写不了，忽略 */ }
  }

  /**
   * 复制文本：优先 clipboard API，file:// 或权限被拒时退回 execCommand。
   *
   * @param {string} text 要复制的文本。
   * @returns {Promise<boolean>} 是否成功。
   */
  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      area.style.pointerEvents = 'none';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok === true;
    } catch (_error) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 挂载 / 清理
  // -------------------------------------------------------------------------

  /**
   * 把胶囊放到「右下角已有常驻 UI」的上方，而不是硬钉一个 bottom:60px。
   *
   * 右下角是公共地盘：同类挂件通常把自己钉在 `bottom:16`。我们不去抢那个位置，而是量出
   * 它的实际盒子、排到它上面 —— 加载顺序不保证，对方可能比我们晚挂载，也可能因为窗口
   * 尺寸变化而改变高度，所以挂载后、每次展开、以及 resize 时都重新量一次。
   * 量不到（没装同类挂件）就退回默认 60px。
   *
   * @see BOTTOM_RIGHT_ANCHOR_IDS
   */
  function syncPillOffset() {
    var offset = PILL_BOTTOM_FALLBACK;
    var other = null;
    for (var i = 0; i < BOTTOM_RIGHT_ANCHOR_IDS.length && other === null; i += 1) {
      var candidate = document.getElementById(BOTTOM_RIGHT_ANCHOR_IDS[i]);
      if (candidate !== null && candidate !== root) other = candidate;
    }
    if (other !== null) {
      var rect = other.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        var above = Math.round(window.innerHeight - rect.top) + PILL_GAP;
        if (isFinite(above) && above >= 16 && above + 28 <= window.innerHeight) offset = above;
      }
    }
    root.style.setProperty('--pv-pill-bottom', offset + 'px');
  }

  function onWindowResize() {
    syncPillOffset();
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
    document.body.appendChild(root);
    renderAll();
    syncPillOffset();
    // 对方插件可能还没挂载：补量一次，之后交给 resize 与每次展开。
    state.offsetTimer = window.setTimeout(function () {
      state.offsetTimer = null;
      syncPillOffset();
    }, PILL_REMEASURE_MS);
    window.addEventListener('resize', onWindowResize, { passive: true });
  }

  if (document.body && document.head) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  /** 卸载：定时器、监听器、在飞的请求、DOM、样式，一个都不留。 */
  return function dispose() {
    if (state.autoTimer !== null) clearInterval(state.autoTimer);
    if (state.confirmTimer !== null) clearTimeout(state.confirmTimer);
    if (state.noticeTimer !== null) clearTimeout(state.noticeTimer);
    if (state.copyTimer !== null) clearTimeout(state.copyTimer);
    if (state.offsetTimer !== null) clearTimeout(state.offsetTimer);
    state.autoTimer = null;
    state.confirmTimer = null;
    state.noticeTimer = null;
    state.copyTimer = null;
    state.offsetTimer = null;
    window.removeEventListener('resize', onWindowResize);
    for (var i = 0; i < state.aborts.length; i += 1) {
      try { state.aborts[i].abort(); } catch (_error) { /* 已结束 */ }
    }
    state.aborts = [];
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('DOMContentLoaded', mount);
    if (root.parentNode) root.parentNode.removeChild(root);
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    state.mounted = false;
  };
}

})();
