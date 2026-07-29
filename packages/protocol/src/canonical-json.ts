export type CanonicalJsonValue =
  null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

function normalize(value: CanonicalJsonValue): CanonicalJsonValue {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key] as CanonicalJsonValue)]),
    );
  }
  return value;
}

export function canonicalJsonStringify(value: CanonicalJsonValue): string {
  return JSON.stringify(normalize(value));
}
