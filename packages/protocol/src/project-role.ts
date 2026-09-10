import { z } from 'zod';

export const humanGateRuleSchema = z
  .object({
    requireApproval: z.boolean().default(false),
    onBranches: z.array(z.string()).optional(),
    notifyUsers: z.array(z.string()).optional(),
  })
  .passthrough();

export const projectRoleSchema = z.object({
  provider: z
    .string()
    .describe(
      "The native agent provider, e.g., 'claude-code', 'codex', 'gemini-cli', 'kimi', 'other'",
    ),
  role: z
    .string()
    .describe("The assigned role for this provider within the project, e.g., 'lead', 'reviewer'"),
  writableBranch: z
    .string()
    .describe(
      "A branch pattern or name that this role is allowed to write to, e.g., 'feature/*', 'main'",
    ),
  worktreePath: z.string().describe('The relative path for the assigned worktree for this agent'),
  readOnlyReviewer: z
    .boolean()
    .describe('Whether this role is strictly restricted to read-only review actions'),
  eligibleWork: z
    .array(z.string())
    .describe(
      "Labels defining what types of work this role can pick up, e.g., ['feature', 'bugfix', 'refactor']",
    ),
  humanGate: humanGateRuleSchema.describe(
    'Rules for gating human approvals before applying changes',
  ),
});

export const projectRoleListSchema = z.array(projectRoleSchema);

export type HumanGateRule = z.infer<typeof humanGateRuleSchema>;
export type ProjectRole = z.infer<typeof projectRoleSchema>;
