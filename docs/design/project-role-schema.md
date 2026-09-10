# Project Roles Configuration Schema

LUWI Runtime allows declaring project-specific agent roles and branch policies via Markdown files (e.g., `.luwi/roles.md` or similar, depending on the project structure).

The configuration uses YAML frontmatter (or a YAML code block) to define an array of `roles`. The runtime parses this structured data to apply policies without executing any code.

## Schema

```yaml
roles:
  - provider: string # The agent provider (e.g., 'claude-code', 'codex')
    role: string # The assigned role (e.g., 'lead', 'reviewer')
    writableBranch: string # Branch pattern/name allowed to write (e.g., 'feature/*', 'main')
    worktreePath: string # Relative path to the assigned worktree
    readOnlyReviewer: boolean # Strictly restricted to read-only review actions
    eligibleWork: string[] # Array of labels defining what type of work this role picks up
    humanGate: # Optional human approval gate rules
      requireApproval: boolean # If true, changes require human approval
      onBranches: string[] # Branches that specifically trigger the approval gate
      notifyUsers: string[] # Optional list of users to notify
```

## Description

- **provider**: Associates a role with a specific underlying native agent integration.
- **role**: The logical role identity in the context of the project.
- **writableBranch**: Defines branch constraints. Agents using this role are only permitted to mutate files on branches matching this string.
- **worktreePath**: To prevent file collisions between multiple concurrent agents, LUWI forces each agent role into an isolated Git worktree specified here.
- **readOnlyReviewer**: When `true`, completely disables write permissions across all tools for the agent in this role.
- **eligibleWork**: A set of string tags used to route incoming tasks or tickets to the right agent role.
- **humanGate**: Before proposing or applying a change to protected branches, the runtime will pause the agent session and request an approval from the configured users.
