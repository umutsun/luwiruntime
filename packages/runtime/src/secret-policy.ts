import { ApplicationError } from './application-error.js';

const secretNamePattern =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|credential)(?:$|[_-])/i;
const camelSecretPattern = /(?:apiKey|accessToken|refreshToken|clientSecret|password)$/;

function visit(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, [...path, String(index)]));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...path, key];
    const isReferenceDescriptor =
      path.at(-1) === 'credentialReference' && (key === 'source' || key === 'name');
    if (
      !isReferenceDescriptor &&
      (secretNamePattern.test(key) ||
        camelSecretPattern.test(key) ||
        (path.at(-1) === 'env' && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)))
    ) {
      throw new ApplicationError(
        'SECRET_VALUE_FORBIDDEN',
        'Canonical LUWI configuration may reference secrets but cannot store secret values.',
        400,
        { path: nextPath.join('.') },
      );
    }
    visit(item, nextPath);
  }
}

export function assertSecretFreeConfiguration(value: unknown): void {
  visit(value, []);
}
