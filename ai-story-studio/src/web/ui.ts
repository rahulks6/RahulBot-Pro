import type { Finding, GeneratedAsset } from '../domain/types.ts';
import { html, join, raw, type SafeHtml } from './html.ts';

/** Per-process CSRF token, set by the server at start-up. */
export const csrf = { token: '' };

export const NAV: Array<[string, string]> = [
  ['/', 'Dashboard'],
  ['/projects', 'Projects'],
  ['/stories', 'Stories'],
  ['/characters', 'Characters'],
  ['/locations', 'Locations'],
  ['/props', 'Props'],
  ['/styles', 'Styles'],
  ['/assets', 'Assets'],
  ['/queue', 'Generation Queue'],
  ['/editor', 'Editor'],
  ['/quality', 'Quality Check'],
  ['/exports', 'Exports'],
  ['/gpu', 'GPU & Costs'],
  ['/models', 'Model Manager'],
  ['/benchmarks', 'Model Benchmarks'],
  ['/cloud', 'Cloud GPU'],
  ['/settings', 'Settings'],
  ['/health', 'System Health'],
  ['/logs', 'Logs'],
];

export interface PageOpts {
  notice?: string | null;
  error?: string | null;
  mock: boolean;
  cloudGpu: boolean;
  /** Phase 5: current generation mode and live cloud GPU status (always shown). */
  mode?: {
    kind: 'MOCK' | 'LOCAL_WORKER' | 'REAL_CLOUD';
    label: string;
    gpu: { state: string; model: string; runtimeSec: number; spentInr: number } | null;
    /** Show the global EMERGENCY STOP GPU button. */
    emergency: boolean;
  };
}

function modeBanner(opts: PageOpts): SafeHtml {
  const m = opts.mode;
  const gpu = m?.gpu
    ? html`<span class="gpuchip"
        >GPU ${m.gpu.state} · ${m.gpu.model} · ${Math.floor(m.gpu.runtimeSec / 60)} min ·
        ₹${m.gpu.spentInr.toFixed(2)}</span
      >`
    : '';
  const stop = m?.emergency
    ? postForm(
        '/cloud/emergency-stop',
        html`<input type="hidden" name="confirm" value="STOP" /><button class="danger emergency">
            EMERGENCY STOP GPU
          </button>`,
        {
          cls: 'inline',
          confirm:
            'EMERGENCY STOP: terminate every cloud GPU this AI Story Studio created, right now? Running generations are lost.',
        },
      )
    : '';
  if (m?.kind === 'REAL_CLOUD')
    return html`<div class="banner danger mode">
      <strong>MODE: REAL CLOUD</strong> — generation rents a paid NVIDIA GPU (RunPod) and runs real AI models.
      ${gpu} ${stop}
    </div>`;
  if (opts.mock)
    return html`<div class="banner ok mode">
      <strong>MODE: MOCK</strong> — every image, clip and sound is a labelled placeholder. No GPU is rented
      and no paid API is called (₹0). ${gpu} ${stop}
    </div>`;
  return html`<div class="banner danger mode">
    <strong>MODE: ${m?.kind === 'LOCAL_WORKER' ? 'LOCAL WORKER' : 'MOCK PROVIDERS'}</strong> —
    MOCK_GENERATION=false. Real open-source models run only on a local worker (₹0). Paid cloud GPUs
    ${opts.cloudGpu ? 'are allowed by .env but real cloud generation is not switched on.' : 'stay disabled.'}
    ${gpu} ${stop}
  </div>`;
}

export function page(title: string, active: string, body: SafeHtml, opts: PageOpts): SafeHtml {
  const banner = modeBanner(opts);
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · AI Story Studio</title>
        <link rel="stylesheet" href="/static/app.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body>
        <nav class="sidebar">
          <div class="brand">AI Story Studio<span>v1.1.1 · Phase 5</span></div>
          ${NAV.map(
            ([href, label]) =>
              html`<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`,
          )}
        </nav>
        <main>
          ${banner} ${opts.notice ? html`<div class="flash notice">${opts.notice}</div>` : ''}
          ${opts.error ? html`<div class="flash error">${opts.error}</div>` : ''}
          <h1>${title}</h1>
          ${body}
        </main>
      </body>
    </html>`;
}

export function csrfField(): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${csrf.token}" />`;
}

export function postForm(
  action: string,
  content: SafeHtml | SafeHtml[],
  opts: { confirm?: string; cls?: string; id?: string } = {},
): SafeHtml {
  return html`<form
    method="post"
    action="${action}"
    class="${opts.cls ?? 'stack'}"
    ${opts.id ? raw(` id="${opts.id.replace(/[^a-z0-9-]/gi, '')}"`) : ''}${opts.confirm
      ? html` data-confirm="${opts.confirm}"`
      : ''}
  >
    ${csrfField()}${content}
  </form>`;
}

/** A one-button form. */
export function button(
  action: string,
  label: string,
  hidden: Record<string, string | number> = {},
  opts: { confirm?: string; kind?: 'primary' | 'danger' | 'ghost' } = {},
): SafeHtml {
  return postForm(
    action,
    html`${Object.entries(hidden).map(
        ([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`,
      )}<button class="${opts.kind ?? ''}">${label}</button>`,
    { cls: 'inline', ...(opts.confirm ? { confirm: opts.confirm } : {}) },
  );
}

interface FieldOpts {
  type?: string;
  textarea?: boolean;
  rows?: number;
  help?: string;
  required?: boolean;
  step?: string;
  placeholder?: string;
  readonly?: boolean;
}

export function field(label: string, name: string, value: unknown, opts: FieldOpts = {}): SafeHtml {
  const v = value === null || value === undefined ? '' : String(value);
  const input = opts.textarea
    ? html`<textarea
        name="${name}"
        rows="${opts.rows ?? 3}"
        ${opts.required ? raw(' required') : ''}${opts.readonly ? raw(' readonly') : ''}
        placeholder="${opts.placeholder ?? ''}"
      >
${v}</textarea
      >`
    : html`<input
        type="${opts.type ?? 'text'}"
        name="${name}"
        value="${v}"
        ${opts.required ? raw(' required') : ''}${opts.readonly ? raw(' readonly') : ''}${opts.step
          ? html` step="${opts.step}"`
          : ''}
        placeholder="${opts.placeholder ?? ''}"
      />`;
  return html`<label class="field"
    ><span>${label}</span>${input}${opts.help ? html`<small>${opts.help}</small>` : ''}</label
  >`;
}

export function select(
  label: string,
  name: string,
  options: Array<[string, string]>,
  selected: unknown,
  opts: { help?: string; multiple?: boolean } = {},
): SafeHtml {
  const sel = Array.isArray(selected) ? selected.map(String) : [String(selected ?? '')];
  return html`<label class="field"
    ><span>${label}</span
    ><select name="${name}" ${opts.multiple ? raw(' multiple size="5"') : ''}>
      ${options.map(
        ([v, l]) => html`<option value="${v}" ${sel.includes(v) ? raw(' selected') : ''}>${l}</option>`,
      )}</select
    >${opts.help ? html`<small>${opts.help}</small>` : ''}</label
  >`;
}

export function checkbox(label: string, name: string, checked: boolean | number, help?: string): SafeHtml {
  return html`<label class="check"
    ><input type="hidden" name="${name}" value="false" /><input
      type="checkbox"
      name="${name}"
      value="true"
      ${checked ? raw(' checked') : ''}
    />
    ${label}${help ? html` <small>${help}</small>` : ''}</label
  >`;
}

export function badge(text: string, kind?: string): SafeHtml {
  const k = kind ?? badgeKind(text);
  return html`<span class="badge ${k}">${text.replace(/_/g, ' ')}</span>`;
}

function badgeKind(text: string): string {
  if (['approved', 'complete', 'pass', 'ok', 'succeeded', 'running', 'imported'].includes(text))
    return 'good';
  if (['rejected', 'failed', 'fail', 'blocked', 'cancelled'].includes(text)) return 'bad';
  if (['warn', 'pending', 'waiting', 'image_review', 'video_review', 'terminating', 'draft'].includes(text))
    return 'warn';
  return 'neutral';
}

export function table(
  headers: string[],
  rows: Array<Array<SafeHtml | string | number | null | undefined>>,
  empty = 'Nothing here yet.',
): SafeHtml {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          ${headers.map((h) => html`<th>${h}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) =>
            html`<tr>
              ${r.map((c) => html`<td>${c ?? ''}</td>`)}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export function card(title: string, body: SafeHtml | SafeHtml[], extra: SafeHtml | string = ''): SafeHtml {
  return html`<section class="card">
    <header>
      <h2>${title}</h2>
      <div>${extra}</div>
    </header>
    ${body}
  </section>`;
}

export function grid(items: SafeHtml[]): SafeHtml {
  return html`<div class="grid">${items}</div>`;
}

export function inr(n: number | null | undefined): string {
  return `₹${(n ?? 0).toFixed(2)}`;
}

export function when(date: string | null | undefined): string {
  if (!date) return '—';
  return date.replace('T', ' ').slice(0, 19);
}

export function mediaUrl(key: string): string {
  return `/media/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Inline preview for an asset. Mock clips render their source still with a simulated camera move. */
export function assetPreview(a: GeneratedAsset, posterKey?: string): SafeHtml {
  const mockTag = a.is_mock ? html`<span class="mock-tag">MOCK</span>` : '';
  if (a.mime.startsWith('image/'))
    return html`<figure class="preview">
      ${mockTag}<img src="${mediaUrl(a.storage_key)}" alt="${a.label}" loading="lazy" />
    </figure>`;
  if (a.mime.startsWith('audio/'))
    return html`<audio controls preload="none" src="${mediaUrl(a.storage_key)}"></audio>`;
  if (a.mime === 'video/mp4') {
    return html`<figure class="preview">
      ${mockTag}<video controls muted preload="metadata" src="${mediaUrl(a.storage_key)}"></video>
      <figcaption class="muted">
        ${a.duration_sec ?? '?'}s · ${a.width}×${a.height}${a.is_native_resolution ? '' : ' · upscaled'}
      </figcaption>
    </figure>`;
  }
  if (a.mime.includes('mock-video')) {
    return html`<figure class="preview clip">
      ${mockTag}${posterKey
        ? html`<img class="kenburns" src="${mediaUrl(posterKey)}" alt="mock clip" />`
        : html`<div class="noposter">clip</div>`}
      <figcaption>
        MOCK CLIP · ${a.duration_sec ?? '?'}s ·
        ${a.width}×${a.height}${a.is_native_resolution ? '' : ' · upscaled'}
      </figcaption>
    </figure>`;
  }
  return html`<a href="${mediaUrl(a.storage_key)}">${a.label || a.id}</a>`;
}

export function findings(list: Finding[]): SafeHtml {
  if (list.length === 0) return html`<p class="muted">No findings.</p>`;
  return html`<ul class="findings">
    ${list.map((f) => html`<li class="${f.severity}">${badge(f.severity)} ${f.message}</li>`)}
  </ul>`;
}

export function kv(pairs: Array<[string, SafeHtml | string | number | null | undefined]>): SafeHtml {
  return html`<dl class="kv">
    ${pairs.map(
      ([k, v]) =>
        html`<dt>${k}</dt>
          <dd>${v ?? '—'}</dd>`,
    )}
  </dl>`;
}

export function options<T extends { id: string }>(
  rows: T[],
  labelOf: (r: T) => string,
  empty = '— none —',
): Array<[string, string]> {
  return [['', empty], ...rows.map((r) => [r.id, labelOf(r)] as [string, string])];
}

export { html, join, raw };
export type { SafeHtml } from './html.ts';
