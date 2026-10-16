import { readFileSync } from 'node:fs';

import type { ApplicationMcpRequest, ToolCallContext } from '@privos_ai/app-server';
import { describe, expect, it } from 'vitest';

import { handleMcpRequest, toolHandlers } from '../src/tools';

const manifest = JSON.parse(readFileSync(new URL('../privos-app.json', import.meta.url), 'utf8')) as {
  tools: Array<{ name: string; ui?: unknown }>;
};
const create = 'calendar_events_create';

const verifiedContext: ToolCallContext = {
  transport: 'relay',
  identityState: 'verified',
  sessionScope: 'test',
  roomId: 'room-from-the-signed-dispatch',
  actor: { userId: 'user-1', username: 'ada', claims: {}, provenance: 'user-token' },
};
const anonymousContext: ToolCallContext = { transport: 'relay', identityState: 'missing', sessionScope: 'test' };

const call = (name: string, args: Record<string, unknown>, context: ToolCallContext) =>
  handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, context) as Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
    _meta?: { verifiedCaller?: { userId: string }; calendarEvent?: Record<string, string> };
  }>;

describe('tools', () => {
  it('has a handler for every tool the manifest declares', () => {
    for (const tool of manifest.tools) expect(toolHandlers[tool.name], tool.name).toBeTypeOf('function');
  });

  it('lists the manifest tools, with the UI under _meta', async () => {
    const request: ApplicationMcpRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const result = (await handleMcpRequest(request, verifiedContext)) as { tools: Array<{ name: string; ui?: unknown; _meta?: { ui?: unknown } }> };
    expect(result.tools.map((tool) => tool.name)).toEqual(manifest.tools.map((tool) => tool.name));
    for (const tool of result.tools) {
      expect(tool.ui).toBeUndefined();
      const declared = manifest.tools.find((candidate) => candidate.name === tool.name)!;
      expect(tool._meta?.ui).toEqual(declared.ui);
    }
  });

  it('takes the caller from the verified actor only and keeps it out of the text', async () => {
    const result = await call(create, { title: 'Sync', start: '2026-10-20T09:00:00+07:00', userId: 'someone-else' }, verifiedContext);
    expect(result.isError).toBeUndefined();
    expect(result._meta?.verifiedCaller?.userId).toBe('user-1');
    expect(result._meta?.calendarEvent).toEqual({ title: 'Sync', start: '2026-10-20T02:00:00.000Z' });
    expect(result.content[0]!.text).not.toMatch(/user-1|ada|someone-else/);
  });

  it('refuses without a verified actor', async () => {
    const result = await call(create, { title: 'Sync', start: '2026-10-20T09:00:00Z' }, anonymousContext);
    expect(result).toMatchObject({ isError: true, content: [{ text: 'requester identity unavailable' }] });
    expect(result._meta).toBeUndefined();
  });

  it('refuses bad times and a foreign roomId', async () => {
    for (const args of [
      { title: 'x', start: '2026-10-20T09:00:00' },
      { title: 'x', start: '2026-10-20T09:00:00Z', end: '2026-10-20T08:00:00Z' },
      { title: '', start: '2026-10-20T09:00:00Z' },
      { title: 'x', start: '2026-10-20T09:00:00Z', roomId: 'other-room' },
    ]) expect((await call(create, args, verifiedContext)).isError, JSON.stringify(args)).toBe(true);
  });

  it('rejects an unknown tool and an unknown method with JSON-RPC codes', async () => {
    await expect(call('no_such_tool', {}, verifiedContext)).rejects.toMatchObject({ code: -32602 });
    await expect(call('constructor', {}, verifiedContext)).rejects.toMatchObject({ code: -32602 });
    await expect(
      handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'prompts/list' }, verifiedContext),
    ).rejects.toMatchObject({ code: -32601 });
  });
});
