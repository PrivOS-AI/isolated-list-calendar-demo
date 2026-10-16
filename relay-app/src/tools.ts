/**
 * Tool handlers and the MCP dispatch around them. `tools/list` is the
 * manifest's own tool list and `tools/call` dispatches by name, so a tool
 * exists in exactly one place in the manifest and one place here.
 *
 * A handler is a function of `(arguments, context)`. Take the caller and the
 * room only from `context`: `context.actor` is the user the Hub signed for and
 * `context.roomId` the room its dispatch was authorized for. Never read a user
 * or room id from the arguments, from request metadata or from a header: those
 * are not proof of anything.
 */
import type { ApplicationMcpRequest, ToolCallContext } from '@privos_ai/app-server';

import { loadManifest } from './manifest.js';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export type ToolHandler = (args: Record<string, unknown>, context: ToolCallContext) => ToolResult | Promise<ToolResult>;

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function textResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export interface CalendarEvent {
  title: string;
  start: string;
  end?: string;
  notes?: string;
}

/** ISO 8601 with an explicit offset or Z, returned as UTC; anything else is refused. */
function isoUtc(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(value.trim()) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be ISO 8601 with a timezone, e.g. 2026-10-20T09:00:00+07:00`);
  }
  return new Date(value).toISOString();
}

export function parseCalendarEvent(args: Record<string, unknown>): CalendarEvent {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) throw new Error('title is required');
  const start = isoUtc(args.start, 'start');
  const end = args.end === undefined || args.end === '' ? undefined : isoUtc(args.end, 'end');
  if (end && end < start) throw new Error('end is before start');
  if (args.notes !== undefined && typeof args.notes !== 'string') throw new Error('notes must be a string');
  return { title, start, ...(end ? { end } : {}), ...(args.notes ? { notes: args.notes as string } : {}) };
}

export const toolHandlers: Record<string, ToolHandler> = {
  calendar: () => textResult('Calendar opened.'),

  /**
   * Checks the event and the caller. The caller comes only from `context.actor`
   * (the Hub-signed user token); nothing in the arguments can name a user.
   * Fails closed without one. The caller id goes to the Calendar tab in `_meta`
   * only, never in the text the model reads.
   *
   * ponytail: no server-side save. A paired relay app has no Hub REST credential
   * (the relayed user token is not accepted by Hub REST), so the Calendar tab saves
   * the event as the signed-in user. Server-side save needs an installation agent
   * bot declared in the manifest, which means pairing again.
   */
  calendar_events_create: (args, context) => {
    const { actor } = context;
    if (!actor) return textResult('requester identity unavailable', true);
    const roomId = context.roomId ?? actor.roomId;
    if (typeof args.roomId === 'string' && args.roomId && roomId && args.roomId !== roomId) {
      return textResult('roomId does not match the room this call comes from', true);
    }
    let event: CalendarEvent;
    try {
      event = parseCalendarEvent(args);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
    return {
      ...textResult(
        `Event "${event.title}" (${event.start}${event.end ? ` to ${event.end}` : ''}) is valid but NOT saved yet: ` +
          'open the Calendar tab in this room to save it to your calendar.',
      ),
      _meta: { calendarEvent: event, verifiedCaller: { userId: actor.userId, username: actor.username ?? '' }, roomId: roomId ?? null },
    };
  },
};

export async function handleMcpRequest(request: ApplicationMcpRequest, context: ToolCallContext): Promise<unknown> {
  if (request.method === 'tools/list') {
    return {
      tools: loadManifest().tools.map(({ ui, ...tool }) => (ui ? { ...tool, _meta: { ui } } : tool)),
    };
  }

  if (request.method === 'tools/call') {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === 'string' ? params.name : '';
    const handler = Object.hasOwn(toolHandlers, name) ? toolHandlers[name] : undefined;
    if (!handler) throw rpcError(INVALID_PARAMS, `Unknown tool: ${name || '<missing>'}`);
    const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    return handler(args, context);
  }

  throw rpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`);
}
