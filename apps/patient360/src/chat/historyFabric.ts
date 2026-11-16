/**
 * Ask's chat history in Fabric: the same operations as the local server's (chat/history.py), on the app's Rayfin
 * database (AskFolder, AskChat, AskTurn). Every row carries its owner and the entities' policies limit every action,
 * reading included, to the signed-in user's own rows. Ids are UUIDs in the database and 32 hex digits in the page, as
 * locally.
 */
import type { AskChat } from '../../rayfin/data/AskChat';
import type { AskFolder } from '../../rayfin/data/AskFolder';
import type { AskTurn } from '../../rayfin/data/AskTurn';
import type { ChatEvent, SavedChat, SavedFolder, SavedTurn } from '@/chat/transport';
import { getRayfinClient } from '@/services/rayfin/RayfinClientService';

const QUICK = 'Side panel';
const HEX = /^[0-9a-f]{32}$/;
const PATIENT = /^(Z\d{7}|TCGA-[A-Z0-9]{2}-[A-Z0-9]{4})$/;

const data = () => getRayfinClient().data;
// Rayfin returns only the fields a query selects.
const FOLDER = ['id', 'owner', 'parentId', 'name', 'kind', 'createdAt', 'updatedAt'] as const;
const CHAT = ['id', 'owner', 'folderId', 'title', 'origin', 'archived', 'archivedAt', 'sessionId', 'model', 'turns', 'patients', 'createdAt', 'updatedAt'] as const;
const TURN = ['id', 'owner', 'chatId', 'idx', 'question', 'context', 'about', 'preview', 'status', 'secs', 'events', 'createdAt'] as const;
const owner = () => {
  const id = getRayfinClient().auth.getSession().user?.id;
  if (!id) throw new Error('Sign in again to save chats.');
  return id;
};

const hex = (id: string) => id.replace(/-/g, '').toLowerCase();
const uuid = (id: string) => {
  const h = hex(id);
  if (!HEX.test(h)) throw new Error('Not a valid id.');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const newUuid = () => uuid(crypto.randomUUID());
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '');
const clip = (text: unknown, n: number) => {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

/** A chat's first title: its first question, up to about 60 characters at a word boundary (as title_for). */
function titleFor(question: string) {
  const q = question.replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
  if (q.length <= 60) return q || 'New chat';
  return `${q.slice(0, 60).replace(/\s+\S*$/, '').replace(/[,;:]+$/, '')}…`;
}

function patientsJson(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const keep = value
    .slice(0, 50)
    .filter((p): p is { id: string; name?: string } => !!p && typeof p === 'object' && PATIENT.test(String((p as { id?: unknown }).id ?? '')))
    .map((p) => ({ id: String(p.id).slice(0, 20), name: clip(p.name, 80) }));
  return JSON.stringify(keep);
}

const folderOut = (f: AskFolder): SavedFolder => ({
  id: hex(f.id),
  parent_id: f.parentId ? hex(f.parentId) : null,
  name: f.name,
  kind: f.kind === 'quick' ? 'quick' : 'user',
  created_at: iso(f.createdAt),
  updated_at: iso(f.updatedAt),
});

const chatOut = (c: AskChat): SavedChat => ({
  id: hex(c.id),
  folder_id: c.folderId ? hex(c.folderId) : null,
  title: c.title,
  origin: c.origin === 'panel' ? 'panel' : 'ask',
  archived: !!c.archived,
  session_id: c.sessionId ?? null,
  model: c.model ?? null,
  turns: Number(c.turns ?? 0),
  patients: c.patients ? (JSON.parse(c.patients) as SavedChat['patients']) : [],
  created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt),
});

async function folders(): Promise<AskFolder[]> {
  return (await data().AskFolder.select([...FOLDER]).where({ owner: { eq: owner() } }).first(-1).execute()) as AskFolder[];
}

async function folder(id: string | null | undefined): Promise<AskFolder | null> {
  if (id === null || id === undefined) return null;
  const [f] = (await data().AskFolder.select([...FOLDER]).where({ id: { eq: uuid(id) } }).first(1).execute()) as AskFolder[];
  if (!f) throw new Error('That folder no longer exists.');
  return f;
}

async function chat(id: string): Promise<AskChat> {
  const [c] = (await data().AskChat.select([...CHAT]).where({ id: { eq: uuid(id) } }).first(1).execute()) as AskChat[];
  if (!c) throw new Error('That chat no longer exists.');
  return c;
}

async function turnsOf(chatId: string): Promise<AskTurn[]> {
  return (await data()
    .AskTurn.select([...TURN])
    .where({ chatId: { eq: uuid(chatId) } })
    .orderBy({ idx: 'asc' })
    .first(-1)
    .execute()) as AskTurn[];
}

function descendants(all: AskFolder[], id: string): Set<string> {
  const out = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const cur = todo.pop()!;
    for (const f of all) if (f.parentId && hex(f.parentId) === hex(cur) && !out.has(hex(f.id))) (out.add(hex(f.id)), todo.push(f.id));
  }
  return out;
}

async function quickFolder(): Promise<string> {
  const found = (await folders()).filter((f) => f.kind === 'quick').sort((a, b) => iso(a.createdAt).localeCompare(iso(b.createdAt)))[0];
  if (found) return found.id;
  const now = new Date();
  const f = (await data().AskFolder.create({ id: newUuid(), owner: owner(), name: QUICK, kind: 'quick', createdAt: now, updatedAt: now })) as AskFolder;
  return f.id;
}

export const fabricHistory = {
  async list() {
    const me = owner();
    const [fs, cs] = await Promise.all([
      folders(),
      data().AskChat.select([...CHAT]).where({ owner: { eq: me } }).orderBy({ updatedAt: 'desc' }).first(-1).execute() as Promise<AskChat[]>,
    ]);
    return {
      folders: fs.map(folderOut).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
      chats: cs.map(chatOut),
    };
  },

  async createFolder(name: string, parentId: string | null): Promise<SavedFolder> {
    const n = clip(name, 120);
    if (!n) throw new Error('Give the folder a name.');
    const parent = await folder(parentId);
    const now = new Date();
    const f = (await data().AskFolder.create({
      id: newUuid(),
      owner: owner(),
      ...(parent ? { parentId: parent.id } : {}),
      name: n,
      kind: 'user',
      createdAt: now,
      updatedAt: now,
    })) as AskFolder;
    return folderOut(f);
  },

  /** Rename, move (parent_id null = the top level; absent = leave it), or archive / restore every chat inside it. */
  async updateFolder(id: string, patch: { name?: string; parent_id?: string | null; archived?: boolean }): Promise<SavedFolder> {
    const f = (await folder(id))!;
    const now = new Date();
    if (patch.name !== undefined) {
      const n = clip(patch.name, 120);
      if (!n) throw new Error('Give the folder a name.');
      await data().AskFolder.update({ id: f.id }, { name: n, updatedAt: now });
    }
    if (patch.parent_id !== undefined) {
      if (patch.parent_id !== null) {
        await folder(patch.parent_id);
        if (hex(patch.parent_id) === hex(f.id) || descendants(await folders(), f.id).has(hex(patch.parent_id))) {
          throw new Error("A folder can't go inside itself.");
        }
      }
      await data().AskFolder.update({ id: f.id }, { parentId: patch.parent_id === null ? null : uuid(patch.parent_id), updatedAt: now } as never);
    }
    if (patch.archived !== undefined) {
      const ids = new Set([hex(f.id), ...descendants(await folders(), f.id)]);
      const chats = (await data().AskChat.select([...CHAT]).where({ owner: { eq: owner() } }).first(-1).execute()) as AskChat[];
      await Promise.all(
        chats
          .filter((c) => c.folderId && ids.has(hex(c.folderId)))
          .map((c) => data().AskChat.update({ id: c.id }, { archived: patch.archived!, archivedAt: patch.archived ? now : null } as never))
      );
    }
    return folderOut((await folder(id))!);
  },

  /** Removes the folder; its chats and folders move up to its parent, so nothing is lost. */
  async deleteFolder(id: string) {
    const f = (await folder(id))!;
    const parent = f.parentId ?? null;
    const [fs, cs] = await Promise.all([folders(), data().AskChat.select([...CHAT]).where({ folderId: { eq: f.id } }).first(-1).execute() as Promise<AskChat[]>]);
    await Promise.all([
      ...cs.map((c) => data().AskChat.update({ id: c.id }, { folderId: parent } as never)),
      ...fs.filter((x) => x.parentId && hex(x.parentId) === hex(f.id)).map((x) => data().AskFolder.update({ id: x.id }, { parentId: parent } as never)),
    ]);
    await data().AskFolder.delete({ id: f.id });
    return { ok: true };
  },

  async getChat(id: string): Promise<{ chat: SavedChat; turns: SavedTurn[] }> {
    const [c, ts] = await Promise.all([chat(id), turnsOf(id)]);
    return {
      chat: chatOut(c),
      turns: ts.map((t) => ({
        idx: Number(t.idx),
        question: t.question,
        context: t.context ?? null,
        about: t.about ?? null,
        preview: t.preview ?? null,
        status: t.status,
        secs: Number(t.secs),
        created_at: iso(t.createdAt),
        events: JSON.parse(t.events || '[]') as ChatEvent[],
      })),
    };
  },

  async updateChat(id: string, patch: { title?: string; folder_id?: string | null; archived?: boolean }): Promise<SavedChat> {
    const c = await chat(id);
    const change: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const t = clip(patch.title, 200);
      if (!t) throw new Error('Give the chat a title.');
      change.title = t;
    }
    if (patch.folder_id !== undefined) change.folderId = patch.folder_id === null ? null : (await folder(patch.folder_id))!.id;
    if (patch.archived !== undefined) Object.assign(change, { archived: patch.archived, archivedAt: patch.archived ? new Date() : null });
    if (Object.keys(change).length) await data().AskChat.update({ id: c.id }, change as never);
    return chatOut(await chat(id));
  },

  async deleteChat(id: string) {
    const c = await chat(id);
    await Promise.all((await turnsOf(id)).map((t) => data().AskTurn.delete({ id: t.id })));
    await data().AskChat.delete({ id: c.id });
    return { ok: true };
  },

  /** Saves one answered question; the first creates the chat (side panel chats go to the Side panel folder). A new
   * answer moves the chat to the top and restores it if it was archived. */
  async saveTurn(id: string, info: Record<string, unknown>, turn: Record<string, unknown>): Promise<SavedChat> {
    const me = owner();
    const chatId = uuid(id);
    const idx = Math.max(0, Math.floor(Number(turn.idx ?? 0)));
    const question = String(turn.question ?? '').trim();
    if (!question) throw new Error('The turn has no question.');
    const now = new Date();
    const [existing] = (await data().AskChat.select(['id']).where({ id: { eq: chatId } }).first(1).execute()) as AskChat[];
    const patients = patientsJson(info.patients);
    if (!existing) {
      const folderId = info.folder_id ? (await folder(String(info.folder_id)))!.id : info.origin === 'panel' ? await quickFolder() : undefined;
      await data().AskChat.create({
        id: chatId,
        owner: me,
        ...(folderId ? { folderId } : {}),
        title: clip(info.title || titleFor(question), 200),
        origin: info.origin === 'panel' ? 'panel' : 'ask',
        archived: false,
        ...(info.session_id ? { sessionId: String(info.session_id).slice(0, 200) } : {}),
        ...(info.model ? { model: String(info.model).slice(0, 100) } : {}),
        turns: 0,
        ...(patients ? { patients } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    const row = {
      question: clip(question, 4000),
      context: String(turn.context ?? '').slice(0, 6000) || null,
      about: clip(turn.about, 300) || null,
      preview: clip(turn.preview, 600) || null,
      status: String(turn.status || 'done').slice(0, 16),
      secs: Math.round(Number(turn.secs || 0) * 10) / 10,
      events: JSON.stringify(turn.events ?? []),
    };
    const turns = await turnsOf(id);
    const same = turns.find((t) => Number(t.idx) === idx);
    if (same) await data().AskTurn.update({ id: same.id }, row as never);
    else await data().AskTurn.create({ id: newUuid(), owner: me, chatId, idx, createdAt: now, ...row } as never);
    await data().AskChat.update({ id: chatId }, {
      turns: turns.length + (same ? 0 : 1),
      updatedAt: now,
      archived: false,
      archivedAt: null,
      ...(info.session_id ? { sessionId: String(info.session_id).slice(0, 200) } : {}),
      ...(info.model ? { model: String(info.model).slice(0, 100) } : {}),
      ...(patients ? { patients } : {}),
    } as never);
    return chatOut(await chat(id));
  },
};
