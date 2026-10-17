/**
 * Calendar tab: the signed-in user's events in the isolated list, and a form to add one.
 *
 * Every Hub call goes through `app.rest`, i.e. as the signed-in user, so the Hub's
 * isolated-list filter decides what shows: a member sees their own events, a room
 * owner sees all. The assignee is the verified caller the server tool returns in
 * `_meta` (from the Hub-signed user token), never the host context or a form field.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PrivosAppProvider, usePrivosApp, usePrivosContext, type McpApp } from '@privos_ai/app-react';

const LIST_NAME = 'Calendar Events (demo)';
const FIELDS = [
  { name: 'Assignee', type: 'ASSIGNEE' },
  { name: 'Start', type: 'DATE_TIME' },
  { name: 'End', type: 'DATE_TIME' },
  { name: 'Notes', type: 'TEXTAREA' },
];

interface Field { _id: string; name: string; type: string }
interface List { _id: string; name: string; isolatedList?: boolean; defaultStageId?: string; fieldDefinitions?: Field[] }
interface Item { _id: string; name: string; customFields?: Array<{ fieldId: string; value: unknown }> }

async function rest<T>(app: McpApp, method: 'GET' | 'POST', path: string, data?: Record<string, unknown>): Promise<T> {
  const res = await app.rest(method === 'GET' ? { method, path, query: data as Record<string, string> } : { method, path, body: data });
  // The Hub bridge resolves the downstream API.v1 payload itself, not the SDK's typed
  // `{ statusCode, body }`; accept both. HTTP errors arrive as a rejected promise.
  const body = (res?.body ?? res ?? {}) as { success?: boolean; error?: string; message?: string };
  if (res?.statusCode >= 400 || body.success === false) throw new Error(body.error || body.message || `${path} failed (${res.statusCode})`);
  return body as T;
}

async function findList(app: McpApp, roomId: string): Promise<List | undefined> {
  // The Hub matches `text` as a raw regex; escape it so "(demo)" is literal.
  const text = LIST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { lists } = await rest<{ lists: List[] }>(app, 'GET', 'lists.listByRoomId', { roomId, text });
  return lists.find((l) => l.name === LIST_NAME);
}

/** Creating an isolated list needs a room owner/admin; the Hub refuses everyone else. */
async function ensureList(app: McpApp, roomId: string): Promise<List> {
  const existing = await findList(app, roomId);
  if (existing) {
    if (!existing.isolatedList) throw new Error(`"${LIST_NAME}" exists but is not isolated; refusing to write to it.`);
    return existing;
  }
  try {
    const { list } = await rest<{ list: List }>(app, 'POST', 'lists.create', {
      name: LIST_NAME, roomId, isolatedList: true, fieldDefinitions: FIELDS,
    });
    return list;
  } catch (error) {
    throw new Error(`The calendar list does not exist yet and could not be created (${(error as Error).message}). A room owner opens this tab once to create it.`);
  }
}

async function stageId(app: McpApp, list: List): Promise<string> {
  if (list.defaultStageId) return list.defaultStageId;
  const { stages } = await rest<{ stages: Array<{ _id: string }> }>(app, 'GET', 'lists.info', { listId: list._id });
  if (!stages?.[0]) throw new Error('The calendar list has no stage.');
  return stages[0]._id;
}

const fieldId = (list: List, name: string) => list.fieldDefinitions?.find((f) => f.name === name)?._id;
const fieldValue = (list: List, item: Item, name: string) => item.customFields?.find((c) => c.fieldId === fieldId(list, name))?.value;

async function addEvent(app: McpApp, roomId: string, form: Record<string, string>): Promise<void> {
  // Same validation and caller check as the AI tool; the verified caller comes back in _meta.
  const result = await app.callServerTool({ name: 'calendar_events_create', arguments: { ...form, roomId } });
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'The event was refused.');
  const meta = result?._meta as { calendarEvent?: Record<string, string>; verifiedCaller?: { userId: string; username: string } } | undefined;
  const caller = meta?.verifiedCaller;
  const event = meta?.calendarEvent;
  if (!caller?.userId || !event) throw new Error('requester identity unavailable');

  const list = await ensureList(app, roomId);
  const assigneeField = fieldId(list, 'Assignee');
  if (!assigneeField) throw new Error('The calendar list has no Assignee field.');
  const customFields = [{ fieldId: assigneeField, value: [{ _id: caller.userId, username: caller.username }] }];
  for (const [name, value] of [['Start', event.start], ['End', event.end], ['Notes', event.notes]]) {
    const id = fieldId(list, name!);
    if (id && value) customFields.push({ fieldId: id, value: value as never });
  }
  const { item } = await rest<{ item: Item }>(app, 'POST', 'items.create', {
    listId: list._id, stageId: await stageId(app, list), name: event.title, customFields,
  });

  // Read back: the stored assignee must be exactly the verified caller.
  const back = await rest<{ item: Item }>(app, 'GET', 'items.info', { itemId: item._id });
  const stored = (fieldValue(list, back.item, 'Assignee') as Array<{ _id: string }> | undefined) ?? [];
  if (stored.length !== 1 || stored[0]!._id !== caller.userId) throw new Error('Saved, but the stored assignee is not you. Check the item.');
}

function Calendar() {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const [list, setList] = useState<List>();
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState('Loading...');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await findList(app, roomId);
      setList(found);
      setItems(found ? (await rest<{ items: Item[] }>(app, 'GET', 'items.listByListId', { listId: found._id })).items : []);
      setStatus(found ? '' : 'No events yet.');
    } catch (error) {
      setStatus(`Could not load events: ${(error as Error).message}`);
    }
  }, [app, roomId]);

  useEffect(() => {
    if (roomId) void load();
  }, [roomId, load]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const data = Object.fromEntries(new FormData(formEl)) as Record<string, string>;
    // datetime-local has no zone: attach the browser's.
    for (const key of ['start', 'end']) if (data[key]) data[key] = new Date(data[key]!).toISOString(); else delete data[key];
    if (!data.notes) delete data.notes;
    setBusy(true);
    try {
      await addEvent(app, roomId, data);
      formEl.reset();
      setStatus('Event added.');
      await load();
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const when = (item: Item, name: string) => {
    const v = list && fieldValue(list, item, name);
    return typeof v === 'string' ? new Date(v).toLocaleString() : '';
  };

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui' }}>
      <h2>Calendar Events (demo)</h2>
      <ul>
        {items.map((item) => (
          <li key={item._id}>
            <strong>{item.name}</strong> {when(item, 'Start')}
            {when(item, 'End') && ` to ${when(item, 'End')}`}
          </li>
        ))}
      </ul>
      <form onSubmit={submit} style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
        <label>Title <input name="title" required /></label>
        <label>Start <input name="start" type="datetime-local" required /></label>
        <label>End <input name="end" type="datetime-local" /></label>
        <label>Notes <textarea name="notes" /></label>
        <button type="submit" disabled={busy}>Add event</button>
      </form>
      {status && <p role="status">{status}</p>}
    </div>
  );
}

export default function App() {
  return (
    <PrivosAppProvider>
      <Calendar />
    </PrivosAppProvider>
  );
}
