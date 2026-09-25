# ADR 0038: Read-only listing of a session's native subagents

Status: Accepted
Date: 2026-09-25

## Context

On 2026-09-24 the owner moved Albanoosh to a hybrid mode: interactive Claude Code sessions do the
work, LUWI observes and coordinates, and codex reviews asynchronously. The next morning an
orchestrating session was running seven background subagents, each in its own worktree, and the
dashboard showed nothing. The cockpit renders autopilot goals and tasks only. The subagents are not
LUWI sessions: they register nothing, heartbeat nothing and send no message. The only trace LUWI
held was the leases the parent session took on their behalf.

The evidence was already on disk. For a native session `<nsid>`, Claude Code appends each subagent's
transcript to `<projectsRoot>/<encoded-cwd>/<nsid>/subagents/agent-<id>.jsonl` beside an
`agent-<id>.meta.json` that carries the agent type and the task description. Workflow subagents use
`subagents/workflows/<wfId>/agent-<id>.jsonl`. This machine held 292 flat and 1865 nested subagent
transcripts. ADR 0023's reader already walks these files, but only for usage and changed-file
counters, which are attributed to the parent session.

ADR 0023 approved transcript ingestion "and nothing else", and it stores only counters and
identifiers. A listing that names what each subagent is doing needs its own decision.

## Decision

### An on-demand read, never persisted

`GET /api/v1/sessions/:sessionId/subagents` lists the subagents of one session.
`GET /api/v1/projects/:projectId/subagents` lists them for the project's live sessions. It also
lists them for a session whose presence ended in the last 24 hours if that session has a Claude Code
binding. A GUI session's LUWI presence can break while the conversation keeps writing its
transcript, and the orchestrating session of 2026-09-25 read `disconnected` while it ran subagents.
The state comes from those files, not from presence. A native session is listed once, however many
LUWI sessions it re-attached as. The newest heartbeat comes first. At most 100 sessions are
considered and 20 listed, and `truncated` is set when either bound cuts. Both routes read the
filesystem per request and write nothing: no Redis key, no event, no `luwi_v1` change. This follows
the knowledge-graph route
(ADR 0029), which reads `graphify-out/graph.json` on each request and keeps no Redis copy. A listing
feeds no projection, so §2's rebuildability rule has nothing to rebuild.

The reader is `listNativeSubagents` in `@luwi/adapters`. It works over the existing
`TranscriptFileSystem` seam, which gains one method, `readTail`, because a subagent's state is
decided by its last record and its transcript can be megabytes long. Ingest still re-reads whole
files; the tail read exists only for this listing.

### What is read, and what is returned

- **Identity comes from the binding, never from a path.** The session's native reference
  (ADR 0022) supplies `nativeSessionId`. Only an `adapterId` of `claude-code` is read. The id must be
  a UUID before it becomes a path component, which also rules out `:` and the NTFS alternate data
  stream it would open. The projects root is enumerated, never derived from a project path, and
  case-variant directories are merged.
- **Only listed names are opened.** A file must match `agent-<alnum>.jsonl`, and a workflow
  directory must match a safe id pattern. No path is built from record content.
- **Per subagent the response carries the following.** Every string is untrusted, type-checked and
  length-capped.
  - `agentId`, and `workflowId` when the agent is nested;
  - `agentType` and `description` from `meta.json`;
  - `state`;
  - `lastActivityAt`, the file's modification time;
  - `lastToolName`, the tool's name only;
  - `workingDirectory`, from the meta's worktree path or else the last record's `cwd`;
  - `gitBranch`.
- **State is inferred, and the words say so.** The rule was measured over the last records of
  2182 real subagent transcripts.
  - `finished` covers the endings measured there:
    - an assistant turn that stopped with `end_turn` or `stop_sequence`;
    - a clean (non-error) tool result answering the agent's final `StructuredOutput` call, which
      is how a workflow subagent ends; a rejected call is retried, so it is not an ending;
    - an assistant record made only of text blocks with no stop reason, once the file has been
      quiet for three minutes. A thinking block is its own record and more of the turn follows it.
      A text block can precede a tool call whose input streams for minutes (p99.9 185 s measured),
      so a shorter settle reads a working agent as finished; the cost is that a text-only ending
      reads `running` for those three minutes.
  - `running` means none of those, and the file was written in the last ten minutes.
  - `quiet` covers everything else.
  - When the final record is larger than the tail window (up to 88 KB was measured), the reader
    retries once with a larger window before falling back to the time-based states.
- **`description` is the one carve-out from ADR 0023's no-content rule.** It is the short task
  label the model wrote into the Agent tool call, such as "A0 admin prep refactor". It is returned
  to the loopback dashboard on request. It is never stored, and never logged. No other text is read
  out of a transcript: no prompt, response, thinking, tool input or tool result. The owner approved
  this field by name on 2026-09-25.
- **Unbound or unsupported sessions get an honest answer, not an estimate.** A session without a
  native binding answers `status: 'unbound'`, and a non-Claude-Code binding answers
  `status: 'unsupported'`, each with an empty list.

### Where it is shown

The overview's session drill-down gains a read-only **Sub-agents** section, read on the same seam
as session usage. The LuwiBot cockpit shows the focused project's active subagents beside its live
activity strip, polled with the rest of the cockpit every five seconds. The dashboard stays
vendor-neutral and gains no write.

## Consequences

The hybrid mode becomes observable: the owner can see which subagent is doing what, where, and
whether it is still running.

- **Only a session that declared its native identity can be listed.** An attached Claude Code
  session declares it; one that never does stays `unbound`.
- **State is a heuristic over the transcript, not a report from the agent.** A subagent blocked on
  a tool call longer than ten minutes reads `quiet`. One the parent resumes with a new message goes
  back to `running` when its file grows.
- **LUWI controls nothing here.** There is no stop, kill or resume (§3, and the ADR 0023 spec's "no
  control of any agent process").
- **Each request touches the disk.** The listing reads at most 500 project directories, 500
  workflow directories, 50 subagents per session by recency, and 20 sessions per project. Cutting
  any of these sets `truncated`. Each returned file is read for 32 KiB of tail, retried once at
  256 KiB. Nothing is cached, so each drill-down refresh costs a directory walk; measured on this
  machine it took 24–55 ms per session. The cockpit lists only running subagents and summarises the
  rest as counts.
- **Other vendors are not covered.** No claim is made about Codex, Gemini CLI or Kimi subagent
  layouts, which were not measured.
