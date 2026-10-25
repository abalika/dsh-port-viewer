/**
 * dsh-port-viewer —— E2E shell browser half (verification fixture)
 *
 * Classic script: no import/export/JSX, no build step. The shell's module
 * loader registers this factory and the Cordis client runtime mounts it as a
 * plugin. It exists so the isolated-instance harness can prove:
 *   - `dsh.client.platform = "web"` packages really are served (the combo
 *     bundle /plugins/??dsh-port-viewer/client.js is fetched by the page),
 *   - the factory actually executes in the browser (this file plants
 *     `#dsh-port-viewer-root`, which the smoke check asserts).
 *
 * NOT the product panel (lib/client.js, owned by `panel`). Kept deliberately
 * tiny and side-effect-scoped so it cannot be mistaken for the real UI.
 */
window.__ModuleLoader__.load({
  id: "dsh-port-viewer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** Root element id (same id the real panel uses, per the UI contract). */
    var ROOT_ID = "dsh-port-viewer-root";

    /** Remove any previous mount; safe on HMR re-apply. */
    function removeMount() {
      var old = document.getElementById(ROOT_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }

    /** Build the throwaway pill + tiny drawer. */
    function buildRoot() {
      var root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("data-dsh-port-viewer", "shell");

      var pill = document.createElement("button");
      pill.type = "button";
      pill.id = "dsh-port-viewer-shell-pill";
      pill.textContent = "端口 shell";
      pill.title = "dsh-port-viewer E2E shell（验证夹具）";
      pill.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:60px",
        "z-index:2147483000",
        "padding:6px 12px",
        "border-radius:999px",
        "border:1px solid rgba(128,128,128,.45)",
        "background:rgba(128,128,128,.16)",
        "color:inherit",
        "font:12px/1.4 system-ui,sans-serif",
        "cursor:pointer",
        "backdrop-filter:blur(8px)",
      ].join(";");

      var panel = document.createElement("div");
      panel.id = "dsh-port-viewer-shell-panel";
      panel.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:104px",
        "z-index:2147483000",
        "display:none",
        "max-width:280px",
        "padding:10px 12px",
        "border-radius:10px",
        "border:1px solid rgba(128,128,128,.45)",
        "background:rgba(128,128,128,.14)",
        "color:inherit",
        "font:12px/1.5 system-ui,sans-serif",
        "backdrop-filter:blur(10px)",
      ].join(";");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "端口 shell");
      panel.textContent = "E2E shell：浏览器半边已加载";

      pill.addEventListener("click", function onToggle() {
        panel.style.display = panel.style.display === "none" ? "block" : "none";
      });

      root.appendChild(pill);
      root.appendChild(panel);
      return root;
    }

    /**
     * Cordis client plugin entry.
     * @param ctx - Cordis client context (may expose effect()).
     */
    function apply(ctx) {
      removeMount();
      var root = buildRoot();
      document.body.appendChild(root);

      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(function registerDisposer() {
          return function dispose() {
            removeMount();
          };
        });
      }
    }

    exports.name = "port-viewer";
    exports.apply = apply;
    return module.exports;
  },
});
