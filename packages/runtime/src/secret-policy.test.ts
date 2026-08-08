import { describe, expect, it } from 'vitest';

import { assertSecretFreeConfiguration } from './secret-policy.js';

describe('canonical configuration secret policy', () => {
  it('accepts environment variable names and secret references without values', () => {
    expect(() =>
      assertSecretFreeConfiguration({
        envNames: ['OPENAI_API_KEY'],
        credentialReference: { source: 'environment', name: 'ANTHROPIC_API_KEY' },
      }),
    ).not.toThrow();
  });

  it.each([
    { apiKey: 'sk-secret' },
    { nested: { access_token: 'token' } },
    { password: 'password' },
    { env: { OPENAI_API_KEY: 'secret' } },
  ])('rejects secret-bearing canonical values', (value) => {
    expect(() => assertSecretFreeConfiguration(value)).toThrowError(
      expect.objectContaining({ code: 'SECRET_VALUE_FORBIDDEN' }),
    );
  });
});
