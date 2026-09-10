---
roles:
  - provider: claude-code
    role: runtime-architect
    writableBranch: 'feature/*'
    worktreePath: '.worktrees/claude-architect'
    readOnlyReviewer: false
    eligibleWork: ['architecture', 'protocol', 'redis-functions', 'refactor']
    humanGate:
      requireApproval: true
      onBranches: ['main', 'release/*']

  - provider: codex
    role: test-engineer
    writableBranch: 'test/*'
    worktreePath: '.worktrees/codex-tests'
    readOnlyReviewer: false
    eligibleWork: ['testing', 'coverage', 'vitest']
    humanGate:
      requireApproval: false

  - provider: gemini-cli
    role: security-auditor
    writableBranch: 'none'
    worktreePath: '.worktrees/gemini-auditor'
    readOnlyReviewer: true
    eligibleWork: ['audit', 'security', 'dependency-review']
    humanGate:
      requireApproval: false
---

# LUWI Runtime Agent Roles

This file specifies the dedicated AI agent roles for the `luwiruntime` project itself.
The configuration above is parsed by the runtime to restrict which agents are allowed to write to which branches, preventing collisions and enforcing human reviews on core architecture changes.
