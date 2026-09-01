import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';

class ScriptedAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessionId = 'scripted-deepseek-session';
    this.cancelled = false;
  }

  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    return { sessionId: this.sessionId };
  }

  async prompt(params) {
    const prompt = params.prompt
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (prompt === 'HANG') return await new Promise(() => undefined);
    if (prompt === 'EXIT') process.exit(0);
    if (prompt === 'MALFORMED') {
      process.stdout.write(`${'x'.repeat(2_000)}\n`);
      return await new Promise(() => undefined);
    }
    if (prompt === 'INVALID') {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ['SENSITIVE_INVALID_FRAME'] },
            },
          },
        })}\n`,
      );
      return await new Promise(() => undefined);
    }
    const decision = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: 'scripted-call',
        title: 'Scripted workspace change',
        kind: 'edit',
        status: 'pending',
      },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      ],
    });
    const permission =
      decision.outcome.outcome === 'selected' ? decision.outcome.optionId : 'cancelled';
    const answer =
      prompt === 'LARGE'
        ? 'x'.repeat(70_000)
        : `${prompt}|luwi=${process.env.LUWI_SESSION_ID}|permission=${permission}`;
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: answer,
        },
      },
    });
    return { stopReason: this.cancelled ? 'cancelled' : 'end_turn' };
  }

  async cancel() {
    this.cancelled = true;
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => new ScriptedAgent(connection), stream);
