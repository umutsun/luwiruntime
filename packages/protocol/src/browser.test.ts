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
    expect(browser).not.toHaveProperty('wakeDispatchTargetSchema');
    expect(browser).not.toHaveProperty('wakeIntentClaimBatchResponseSchema');
    expect(browser).not.toHaveProperty('wakeIntentClaimRequestSchema');
    expect(browser).not.toHaveProperty('wakeIntentClaimResponseSchema');
    expect(browser).not.toHaveProperty('wakeIntentDispatchingRequestSchema');
    expect(browser).not.toHaveProperty('wakeIntentDispatchingResponseSchema');
    expect(browser).not.toHaveProperty('wakeIntentCompleteRequestSchema');
    expect(browser).not.toHaveProperty('wakeIntentCompleteResponseSchema');
    expect(browser).not.toHaveProperty('wakeIntentRecoverRequestSchema');
    expect(browser).not.toHaveProperty('wakeIntentRecoverResponseSchema');
    expect(browser).not.toHaveProperty('wakeIntentReclaimResponseSchema');
  });
});
