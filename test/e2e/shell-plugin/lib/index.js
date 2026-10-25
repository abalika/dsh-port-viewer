/**
 * dsh-port-viewer —— E2E shell host half (verification fixture)
 *
 * This is NOT the product host half. It exists only so
 * scripts/verify-isolated.ps1 can prove, before the real lib/ halves exist,
 * that an isolated dsh web instance:
 *   - loads a profile-junctioned bundle (cordis.patch.yml row mounted),
 *   - registers an exact HTTP route on the webServer seat,
 *   - serves the browser bundle declared by `dsh.client`.
 *
 * It answers GET /api/port-viewer/snapshot with a clearly marked stub payload.
 * The real half (lib/index.js, owned by the Lead) replaces this file entirely.
 */

/** Stable Cordis plugin name, matching the bundle patch row id. */
export const name = 'port-viewer';

/** The single exact route the shell answers. */
export const ROUTE_PATH = '/api/port-viewer/snapshot';

/**
 * Send a JSON response with the headers every dsh same-origin route uses.
 * @param res - node:http response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

/**
 * Cordis plugin entry: provide the stub snapshot route once webServer exists.
 * @param ctx - Cordis host context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    // register() returns a disposer; wrapping it in effect() keeps reloads clean.
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler(req, res) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed', code: 'method-not-allowed' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          stub: true,
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          ports: [],
          projects: [],
          stats: { portCount: 0, projectCount: 0, orphanCount: 0, protectedCount: 0 },
          warnings: ['E2E shell plugin: this payload is a harness fixture, not real collection output'],
        });
      },
    }), 'port-viewer: shell snapshot route');
  });
}
