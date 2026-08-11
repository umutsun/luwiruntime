import { describe, expect, it } from 'vitest';

import {
  deriveNativeBindingId,
  deriveNativeKind,
  deriveNativeLinkId,
  deriveParentRef,
} from './native-session-identity.js';

const main = {
  adapterId: 'claude-code-native-v1',
  nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
};
const subagent = { ...main, nativeSubagentId: 'agent-a06de43343c462b9b' };

describe('native binding identity', () => {
  it('is deterministic, which is what makes a declaration idempotent', () => {
    expect(deriveNativeBindingId(main)).toBe(deriveNativeBindingId({ ...main }));
    expect(deriveNativeBindingId(main)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('namespaces by adapter, so two vendors cannot collide on one native id', () => {
    expect(deriveNativeBindingId(main)).not.toBe(
      deriveNativeBindingId({ ...main, adapterId: 'codex-native-v1' }),
    );
  });

  it('separates a subagent from its parent', () => {
    expect(deriveNativeBindingId(subagent)).not.toBe(deriveNativeBindingId(main));
  });

  /**
   * Without a separator, ('ab', 'c') and ('a', 'bc') hash identically. The NUL
   * byte cannot occur inside a validated native id, so it is unambiguous.
   */
  it('cannot be confused by concatenation across adjacent fields', () => {
    expect(
      deriveNativeBindingId({ adapterId: 'ab', nativeSessionId: 'cd', nativeSubagentId: 'ef' }),
    ).not.toBe(
      deriveNativeBindingId({ adapterId: 'a', nativeSessionId: 'bcd', nativeSubagentId: 'ef' }),
    );
    expect(deriveNativeBindingId({ adapterId: 'ab', nativeSessionId: 'cd' })).not.toBe(
      deriveNativeBindingId({ adapterId: 'abcd', nativeSessionId: 'x' }),
    );
  });
});

describe('native link identity', () => {
  it('is deterministic per binding and session', () => {
    const bindingId = deriveNativeBindingId(main);
    expect(deriveNativeLinkId(bindingId, 'session-1')).toBe(
      deriveNativeLinkId(bindingId, 'session-1'),
    );
    expect(deriveNativeLinkId(bindingId, 'session-1')).not.toBe(
      deriveNativeLinkId(bindingId, 'session-2'),
    );
  });
});

describe('derived reference fields', () => {
  it('derives kind rather than accepting it', () => {
    expect(deriveNativeKind(main)).toBe('main');
    expect(deriveNativeKind(subagent)).toBe('subagent');
  });

  it('derives a parent reference only for a subagent', () => {
    expect(deriveParentRef(main)).toBeUndefined();
    expect(deriveParentRef(subagent)).toEqual(main);
  });
});
