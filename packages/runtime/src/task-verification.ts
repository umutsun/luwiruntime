import type { AgentMessage, Task, TaskCheck, TaskOutcome } from '@luwi/protocol';

/**
 * What the runtime checks about a finished task before anyone is asked an
 * opinion (ADR 0035). Every check is a fact about the worker's own answer and
 * the runtime's own observations; none of them is a judgment of quality.
 */

export type VerificationInput = {
  task: Pick<Task, 'evidenceRequirements'>;
  message: Pick<AgentMessage, 'state' | 'response'>;
  /** Whether a commit sha is known to the project's Git observation; absent means "cannot tell". */
  commitKnown?: (sha: string) => boolean;
};

export function outcomeFromMessage(message: Pick<AgentMessage, 'state' | 'response'>): TaskOutcome {
  const state = message.state;
  const messageState =
    state === 'responded' || state === 'rejected' || state === 'failed' || state === 'timed_out'
      ? state
      : 'failed';
  const response = message.response;
  return {
    messageState,
    ...(response === undefined ? {} : { status: response.status }),
    ...(response === undefined ? {} : { answer: response.answer.slice(0, 4096) }),
    ...(response?.confidence === undefined ? {} : { confidence: response.confidence }),
    evidenceCount: response?.evidence.length ?? 0,
    evidenceTypes: [...new Set((response?.evidence ?? []).map((item) => item.type))],
  };
}

export function verifyTaskOutcome(input: VerificationInput): TaskCheck[] {
  const checks: TaskCheck[] = [];
  const response = input.message.response;
  const answered =
    input.message.state === 'responded' &&
    (response?.status === 'answered' || response?.status === 'partially_answered');
  checks.push({
    check: 'answer_status',
    passed: answered,
    detail: answered
      ? `The worker answered (${response?.status ?? 'unknown'}).`
      : `The message ended ${input.message.state}${response === undefined ? '' : ` (${response.status})`}.`,
  });

  const present = new Set((response?.evidence ?? []).map((item) => item.type));
  const missing = input.task.evidenceRequirements.filter((type) => !present.has(type));
  if (input.task.evidenceRequirements.length > 0) {
    checks.push({
      check: 'evidence_required',
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? 'Every required evidence type is present.'
          : `Missing evidence: ${missing.join(', ')}.`,
    });
  }

  const commits = (response?.evidence ?? []).filter((item) => item.type === 'git_commit');
  if (commits.length > 0 && input.commitKnown !== undefined) {
    const unknown = commits.filter((item) => {
      const sha = item.gitHead ?? item.reference;
      return sha === undefined || !input.commitKnown?.(sha);
    });
    checks.push({
      check: 'commit_evidence',
      passed: unknown.length === 0,
      detail:
        unknown.length === 0
          ? `${String(commits.length)} commit(s) are known to the Git observation.`
          : `${String(unknown.length)} of ${String(commits.length)} claimed commits are not in the Git observation.`,
    });
  }

  if (input.task.evidenceRequirements.includes('test_result')) {
    const tests = (response?.evidence ?? []).filter((item) => item.type === 'test_result');
    const passed = tests.some((item) => item.metadata?.['outcome'] === 'passed');
    checks.push({
      check: 'test_claim',
      passed,
      detail: passed
        ? 'A test result with outcome "passed" was reported.'
        : 'No test result claims outcome "passed".',
    });
  }
  return checks;
}
