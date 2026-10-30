import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

/** Hash the supplied semantic value; callers choose original JSON or normalized source content. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
