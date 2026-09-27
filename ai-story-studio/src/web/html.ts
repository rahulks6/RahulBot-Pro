/**
 * Minimal HTML templating with automatic escaping. Every interpolated value is
 * escaped unless it is explicitly wrapped as trusted markup via `html`/`raw`.
 */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Part = SafeHtml | string | number | boolean | null | undefined | Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return '';
  if (Array.isArray(part)) return part.map(render).join('');
  if (part instanceof SafeHtml) return part.value;
  return escapeHtml(part);
}

export function html(strings: TemplateStringsArray, ...values: Part[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** Trusted markup produced by this codebase (never user input). */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

export function join(parts: Part[], sep: SafeHtml | string = ''): SafeHtml {
  return new SafeHtml(parts.map(render).join(sep instanceof SafeHtml ? sep.value : escapeHtml(sep)));
}
