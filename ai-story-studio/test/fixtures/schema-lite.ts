/**
 * A small JSON-Schema checker for tests: validates a request body against Runpod's published
 * schema (test/fixtures/runpod-pods-openapi.json). Supports what that schema uses: allOf, type
 * (incl. ["string","null"]), enum, required, properties, additionalProperties: false (across
 * allOf siblings), items, pattern, minimum and maxItems.
 */
type Schema = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Properties declared by a schema and all of its allOf parts. */
function declared(s: Schema): { props: Record<string, Schema>; required: string[]; closed: boolean } {
  const props: Record<string, Schema> = { ...((s['properties'] as Record<string, Schema>) ?? {}) };
  const required = [...((s['required'] as string[]) ?? [])];
  let closed = s['additionalProperties'] === false;
  for (const part of (s['allOf'] as Schema[]) ?? []) {
    const d = declared(part);
    Object.assign(props, d.props);
    required.push(...d.required);
    closed ||= d.closed;
  }
  return { props, required, closed };
}

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case 'null':
      return v === null;
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isObj(v);
    default:
      return true;
  }
}

export function validate(value: unknown, schema: Schema, path = '$'): string[] {
  const errors: string[] = [];
  const types = schema['type'] === undefined ? [] : ([] as unknown[]).concat(schema['type']);
  if (types.length && !types.some((t) => typeOk(value, String(t))))
    errors.push(`${path}: expected ${types.join(' or ')}`);
  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).includes(value))
    errors.push(`${path}: not one of ${(schema['enum'] as unknown[]).join(', ')}`);
  if (
    typeof value === 'string' &&
    typeof schema['pattern'] === 'string' &&
    !new RegExp(schema['pattern']).test(value)
  )
    errors.push(`${path}: does not match ${schema['pattern']}`);
  if (typeof value === 'number' && typeof schema['minimum'] === 'number' && value < schema['minimum'])
    errors.push(`${path}: below minimum ${schema['minimum']}`);
  if (Array.isArray(value)) {
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems'])
      errors.push(`${path}: more than ${schema['maxItems']} items`);
    if (isObj(schema['items']))
      value.forEach((v, i) => errors.push(...validate(v, schema['items'] as Schema, `${path}[${i}]`)));
  }
  for (const part of (schema['allOf'] as Schema[]) ?? [])
    errors.push(
      ...validate(
        value,
        {
          ...part,
          properties: undefined,
          required: undefined,
          additionalProperties: undefined,
          allOf: part['allOf'] ? [] : undefined,
        },
        path,
      ),
    );
  if (isObj(value)) {
    const d = declared(schema);
    for (const r of d.required) if (!(r in value)) errors.push(`${path}: missing required "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (d.props[k]) errors.push(...validate(v, d.props[k]!, `${path}.${k}`));
      else if (d.closed || Object.keys(d.props).length)
        errors.push(`${path}: additional property "${k}" is not declared`);
    }
  }
  return errors;
}
