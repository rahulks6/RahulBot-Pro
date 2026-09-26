import type { Server } from 'node:http';

/**
 * A tiny "browser without JavaScript" for workflow tests. It loads real pages from the running
 * web app, reads the actual <form> elements in the HTML (action, method, fields, defaults, the
 * CSRF token), submits them the way a browser would (urlencoded, Origin/Referer headers) and
 * follows redirects. Tests therefore exercise the real routes AND the real form markup, so a
 * wrong action or field name fails a test instead of only failing in the browser.
 */
export interface Page {
  url: string;
  status: number;
  html: string;
  /** Visible text (tags stripped, entities decoded, whitespace collapsed). */
  text: string;
  notice: string | null;
  error: string | null;
}

export interface FormField {
  name: string;
  kind: 'input' | 'textarea' | 'select';
  type: string;
  value: string;
  options: string[];
  multiple: boolean;
  /** Every selected option of a select (a multiple select can have none, or several). */
  selected: string[];
}

export interface Form {
  action: string;
  method: string;
  fields: FormField[];
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? decode(m[1]!) : null;
};

export function textOf(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseForms(html: string): Form[] {
  const forms: Form[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)) {
    const open = m[1]!;
    const body = m[2]!;
    const fields: FormField[] = [];
    for (const f of body.matchAll(
      /<select\b([^>]*)>([\s\S]*?)<\/select\s*>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea\s*>|<input\b([^>]*)>/gi,
    )) {
      const kind: FormField['kind'] =
        f[1] !== undefined ? 'select' : f[3] !== undefined ? 'textarea' : 'input';
      const tag = ` ${f[1] ?? f[3] ?? f[5] ?? ''}`;
      const inner = f[2] ?? f[4] ?? '';
      const name = attr(tag, 'name');
      if (!name) continue;
      const type = (attr(tag, 'type') ?? (kind === 'input' ? 'text' : kind)).toLowerCase();
      let value = attr(tag, 'value') ?? '';
      const options: string[] = [];
      let selected: string[] = [];
      const multiple = /\smultiple\b/i.test(tag);
      if (kind === 'textarea') value = decode(inner.replace(/^\s*\n/, '')).trim();
      if (kind === 'select') {
        const opts = [...inner.matchAll(/<option\b([^>]*)>/gi)];
        for (const o of opts) options.push(attr(` ${o[1]}`, 'value') ?? '');
        selected = opts
          .filter((o) => /\sselected\b/i.test(` ${o[1]}`))
          .map((o) => attr(` ${o[1]}`, 'value') ?? '');
        // Like a browser: a single select defaults to its first option, a multiple one to nothing.
        if (!selected.length && !multiple && options.length) selected = [options[0]!];
        value = selected[0] ?? '';
      }
      if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/i.test(tag)) value = '';
      fields.push({ name, kind, type, value, options, multiple, selected });
    }
    // Named submit buttons (e.g. TEST CONNECTION / SAVE): sent only when chosen in `submit` values.
    for (const b of body.matchAll(/<button\b([^>]*)>/gi)) {
      const name = attr(` ${b[1]}`, 'name');
      if (name)
        fields.push({
          name,
          kind: 'input',
          type: 'submit',
          value: attr(` ${b[1]}`, 'value') ?? '',
          options: [],
          multiple: false,
          selected: [],
        });
    }
    forms.push({
      action: attr(` ${open}`, 'action') ?? '',
      method: (attr(` ${open}`, 'method') ?? 'get').toLowerCase(),
      fields,
    });
  }
  return forms;
}

export class WebDriver {
  readonly base: string;
  page: Page | null = null;
  history: string[] = [];

  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }

  static fromServer(server: Server): WebDriver {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server not listening');
    return new WebDriver(`http://127.0.0.1:${addr.port}`);
  }

  private async load(res: Response, url: string): Promise<Page> {
    const html = await res.text();
    const u = new URL(url, this.base);
    this.page = {
      url: u.pathname + u.search,
      status: res.status,
      html,
      text: textOf(html),
      notice: u.searchParams.get('notice'),
      error: u.searchParams.get('error'),
    };
    this.history.push(this.page.url);
    return this.page;
  }

  async get(path: string, referer?: string): Promise<Page> {
    let url = path;
    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(this.base + url, {
        redirect: 'manual',
        headers: referer ? { referer: this.base + referer } : {},
      });
      if (res.status >= 300 && res.status < 400) {
        await res.arrayBuffer();
        url =
          new URL(res.headers.get('location')!, this.base + url).pathname +
          new URL(res.headers.get('location')!, this.base + url).search;
        continue;
      }
      return this.load(res, url);
    }
    throw new Error(`too many redirects from ${path}`);
  }

  forms(): Form[] {
    if (!this.page) throw new Error('no page loaded');
    return parseForms(this.page.html);
  }

  /** The form on the current page whose action matches (exact path, or a RegExp). */
  form(action: string | RegExp): Form {
    const all = this.forms();
    const matching = all.filter((x) =>
      typeof action === 'string' ? x.action === action : action.test(x.action),
    );
    // A GET filter form and a POST create form can share an action (e.g. /locations): prefer POST.
    const f = matching.find((x) => x.method === 'post') ?? matching[0];
    if (!f)
      throw new Error(
        `no form with action ${String(action)} on ${this.page?.url}; forms: ${all.map((x) => x.action).join(', ')}`,
      );
    return f;
  }

  /**
   * Fill and submit a form like a browser: defaults for untouched fields, `values` override
   * (unknown names are an error, so a renamed field breaks the test), Origin + Referer set.
   */
  async submit(action: string | RegExp, values: Record<string, string | string[]> = {}): Promise<Page> {
    const f = this.form(action);
    const known = new Set(f.fields.map((x) => x.name));
    for (const k of Object.keys(values))
      if (!known.has(k))
        throw new Error(`form ${f.action} has no field "${k}" (has: ${[...known].join(', ')})`);
    const body = new URLSearchParams();
    const seen = new Set<string>();
    for (const fld of f.fields) {
      if (fld.name in values) {
        if (seen.has(fld.name)) continue; // hidden+checkbox pairs: the override replaces both
        seen.add(fld.name);
        const v = values[fld.name]!;
        for (const one of Array.isArray(v) ? v : [v]) body.append(fld.name, one);
        continue;
      }
      if ((fld.type === 'checkbox' || fld.type === 'radio') && fld.value === '') continue;
      if (fld.type === 'file' || fld.type === 'submit') continue;
      if (fld.kind === 'select') {
        for (const v of fld.selected) body.append(fld.name, v);
        continue;
      }
      body.append(fld.name, fld.value);
    }
    const from = this.page!.url;
    const res = await fetch(this.base + f.action, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: this.base,
        referer: this.base + from,
      },
      body,
    });
    if (res.status >= 300 && res.status < 400) {
      await res.arrayBuffer();
      return this.get(res.headers.get('location')!, from);
    }
    return this.load(res, f.action);
  }

  /** POST arbitrary fields (plus the page's CSRF token) to any path, like a hand-edited form. */
  async post(action: string, values: Record<string, string>): Promise<Page> {
    const token =
      this.forms()
        .flatMap((f) => f.fields)
        .find((x) => x.name === '_csrf')?.value ?? '';
    const from = this.page!.url;
    const res = await fetch(this.base + action, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: this.base,
        referer: this.base + from,
      },
      body: new URLSearchParams({ _csrf: token, ...values }),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.arrayBuffer();
      return this.get(res.headers.get('location')!, from);
    }
    return this.load(res, action);
  }

  /** Links on the current page whose text matches. */
  links(text: string | RegExp): string[] {
    const out: string[] = [];
    for (const m of (this.page?.html ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const t = textOf(m[2]!);
      if (typeof text === 'string' ? t === text : text.test(t)) {
        const href = attr(` ${m[1]}`, 'href');
        if (href) out.push(href);
      }
    }
    return out;
  }
}
