---
roles:
  - provider: codex
    role: frontend-developer
    writableBranch: 'ui/*'
    worktreePath: '.worktrees/albanoosh-ui'
    readOnlyReviewer: false
    eligibleWork: ['frontend', 'react', 'styling', 'components']
    humanGate:
      requireApproval: true
      onBranches: ['main', 'staging']

  - provider: claude-code
    role: backend-engineer
    writableBranch: 'backend/*'
    worktreePath: '.worktrees/albanoosh-api'
    readOnlyReviewer: false
    eligibleWork: ['api', 'database', 'redis', 'fastify']
    humanGate:
      requireApproval: true
      onBranches: ['main']

  - provider: kimi
    role: content-reviewer
    writableBranch: 'none'
    worktreePath: '.worktrees/albanoosh-content'
    readOnlyReviewer: true
    eligibleWork: ['copywriting', 'i18n', 'localization']
    humanGate:
      requireApproval: false
---

# Albanoosh Agent Roles

This file specifies the dedicated AI agent roles for the `Albanoosh` project.
It defines strict branch isolation between frontend (UI) and backend (API) agent tasks, ensuring that agents do not override each other's work while iterating.
