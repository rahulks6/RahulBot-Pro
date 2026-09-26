import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Studio } from '../app/studio.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { appRoot } from '../lib/paths.ts';
import { mimeForKey } from '../storage/storage.ts';
import type { SafeHtml } from './html.ts';
import { checkCsrf, parseForm, readBody, Router, securityHeaders, type Req, type Result } from './http.ts';
import { registerBenchmarkPages } from './pages/benchmarks.ts';
import { registerCharacterPages } from './pages/characters.ts';
import { registerCloudPages } from './pages/cloud.ts';
import { registerDashboard } from './pages/dashboard.ts';
import { registerOpsPages } from './pages/ops.ts';
import { registerProductionPages } from './pages/production.ts';
import { registerProjectPages } from './pages/projects.ts';
import { registerQualityPages } from './pages/quality.ts';
import { registerStoryPages } from './pages/stories.ts';
import { csrf, html, page } from './ui.ts';

export interface Web {
  studio: Studio;
  router: Router;
  /** Render a full page, carrying ?notice= / ?error= flash messages. */
  render(req: Req, title: string, active: string, body: SafeHtml): Result;
  /** Redirect with a flash message. */
  redirect(location: string, notice?: string, error?: string): Result;
}

const STATIC: Record<string, string> = {
  'app.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
};

function modeInfo(studio: Studio): NonNullable<import('./ui.ts').PageOpts['mode']> {
  const st = studio.cloud.status();
  const anyActive = studio.gpuRepo.active().some((i) => i.is_mock === 0 && i.provider !== 'local-worker');
  return {
    kind: st.mode,
    label: st.modeLabel,
    gpu: st.instance
      ? {
          state: st.instance.state,
          model: st.instance.gpu,
          runtimeSec: st.instance.runtimeSec,
          spentInr: st.instance.spentInr,
        }
      : null,
    // Visible whenever a paid GPU could exist: cloud allowed, a GPU is tracked, or leftovers were found.
    emergency: st.canProvision || anyActive || (st.recovery?.ownedPods.length ?? 0) > 0,
  };
}

export function createWebApp(
  studio: Studio,
  opts: { csrfToken?: string } = {},
): { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; web: Web } {
  csrf.token = opts.csrfToken ?? randomBytes(24).toString('hex');
  const router = new Router();
  const web: Web = {
    studio,
    router,
    render(req, title, active, body) {
      return {
        type: 'html',
        body: page(title, active, body, {
          notice: req.query.get('notice'),
          error: req.query.get('error'),
          mock: studio.env.mockGeneration,
          cloudGpu: studio.env.enableCloudGpu,
          mode: modeInfo(studio),
        }),
      };
    },
    redirect(location, notice, error) {
      const url = new URL(location, 'http://local');
      if (notice) url.searchParams.set('notice', notice);
      if (error) url.searchParams.set('error', error);
      return { type: 'redirect', location: url.pathname + url.search };
    },
  };

  registerDashboard(web);
  registerProjectPages(web);
  registerStoryPages(web);
  registerCharacterPages(web);
  registerProductionPages(web);
  registerQualityPages(web);
  registerOpsPages(web);
  registerBenchmarkPages(web);
  registerCloudPages(web);

  // Media from local storage (keys are validated by the storage provider: no traversal).
  router.get('/media/:key*', (req) => {
    const key = req.params['key'] ?? '';
    const path = studio.storage.localPath(key);
    if (!existsSync(path)) throw new AppError('NOT_FOUND', 'File not found');
    return { type: 'file', path, mime: mimeForKey(key) };
  });
  router.get('/static/:name', (req) => {
    const name = req.params['name'] ?? '';
    const mime = STATIC[name];
    if (!mime) throw new AppError('NOT_FOUND', 'Not found');
    return { type: 'file', path: join(appRoot(), 'src', 'web', 'public', name), mime };
  });

  /**
   * A form whose security token no longer matches: almost always a page opened before the app
   * was restarted. Nothing was saved; say so and link back to the page (a reload gets a new token).
   */
  function staleFormPage(req: IncomingMessage): Result {
    let back = '/';
    try {
      const ref = req.headers.referer;
      if (ref && new URL(ref).host === req.headers.host) back = new URL(ref).pathname;
    } catch {
      back = '/';
    }
    return {
      type: 'html',
      status: 403,
      body: page(
        'Please reload the page',
        '',
        html`<p>
            <strong>Nothing was saved.</strong> AI Story Studio was restarted after this page was opened (or
            the page is from another tab or site), so its form is no longer valid.
          </p>
          <p><a class="btn primary" href="${back}">Reload the page</a> and enter the change again.</p>`,
        { mock: studio.env.mockGeneration, cloudGpu: studio.env.enableCloudGpu, mode: modeInfo(studio) },
      ),
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    securityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';
    const matched = router.match(method, url.pathname);
    const request: Req = {
      method,
      path: url.pathname,
      query: url.searchParams,
      params: {},
      form: {},
      formAll: {},
      raw: req,
    };
    try {
      if (!matched) throw new AppError('NOT_FOUND', `No page at ${url.pathname}`);
      request.params = matched.params;
      if (method === 'POST') {
        const body = await readBody(req, matched.route.maxBody);
        const parsed = parseForm(body);
        request.form = parsed.form;
        request.formAll = parsed.formAll;
        if (!checkCsrf(req, request.form, csrf.token)) {
          studio.logger.warn('form rejected: stale or missing CSRF token', { path: url.pathname });
          send(res, staleFormPage(req));
          return;
        }
      }
      const result = await matched.route.handler(request);
      send(res, result, req.headers.range);
    } catch (err) {
      const e = toAppError(err);
      const status =
        e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : e.code === 'INTERNAL' ? 500 : 400;
      if (status === 500) studio.logger.error('request failed', { path: url.pathname, error: e.message });
      const detail = e.details.length
        ? ` (${e.details
            .map((d) => `${d.path || 'input'}: ${d.message}`)
            .slice(0, 8)
            .join('; ')})`
        : '';
      if (method === 'POST' && status !== 403 && matched) {
        // Back to the page the form came from, with the error shown.
        const ref = req.headers.referer;
        let back = '/';
        try {
          if (ref && new URL(ref).host === req.headers.host) back = new URL(ref).pathname;
        } catch {
          back = '/';
        }
        send(res, web.redirect(back, undefined, `${e.message}${detail}`));
        return;
      }
      send(res, {
        type: 'html',
        status,
        body: page(
          'Error',
          '',
          html`<p>${e.message}${detail}</p>
            <p><a href="/">Back to dashboard</a></p>`,
          {
            mock: studio.env.mockGeneration,
            cloudGpu: studio.env.enableCloudGpu,
          },
        ),
      });
    }
  }

  return { handle, web };
}

function send(res: ServerResponse, result: Result, range?: string): void {
  switch (result.type) {
    case 'html':
      res.writeHead(result.status ?? 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.body.value);
      return;
    case 'redirect':
      res.writeHead(303, { Location: result.location });
      res.end();
      return;
    case 'json': {
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
      if (result.filename)
        headers['Content-Disposition'] =
          `attachment; filename="${result.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
      res.writeHead(200, headers);
      res.end(JSON.stringify(result.body, null, 2));
      return;
    }
    case 'text':
      res.writeHead(result.status ?? 200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(result.body);
      return;
    case 'file': {
      const size = statSync(result.path).size;
      const headers = {
        'Content-Type': result.mime,
        'Content-Disposition': 'inline',
        'Accept-Ranges': 'bytes',
      };
      // Single byte ranges so browsers can seek in audio/video.
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': end - start + 1,
        });
        createReadStream(result.path, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': size });
      createReadStream(result.path).pipe(res);
      return;
    }
  }
}
