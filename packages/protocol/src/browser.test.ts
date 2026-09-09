import { describe, expect, it } from 'vitest';

import * as browser from './browser.js';

describe('browser protocol exports', () => {
  it('exports only redacted bridge, wake, and workflow views', () => {
    expect(browser).toMatchObject({
      bridgeSlotCollectionSchema: expect.anything(),
      wakeIntentCollectionSchema: expect.anything(),
      workflowCollectionSchema: expect.anything(),
    });
    expect(browser).not.toHaveProperty('hostWakeDeclarationSchema');
    expect(browser).not.toHaveProperty('nativeIdentityProvenanceSchema');
  });
});
