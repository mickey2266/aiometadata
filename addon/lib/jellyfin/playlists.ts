import consola from 'consola';
import { mapWithConcurrency } from '../../utils/concurrency';
import { envInt } from '../../utils/envNumber';
import { loadConfig, serverIdFor } from './context';
import { collectionFolder, EMPTY_USER_DATA, itemList } from './dto';
import {
  decodeJellyfinId,
  encodeJellyfinId,
  isPlaylistJellyfinId,
  newPlaylistId,
  normaliseJellyfinId,
  PLAYLISTS_FOLDER_ID,
} from './ids';
import { imageTag } from './imageTags';
import { buildEpisodes, fetchMeta, rememberImages, sortNameFor, type ItemImages } from './items';
import { boxSetMembers, collectionById, folderById } from './collections';
import { profileKey, profileUserId } from './profiles';
import type { PlaylistRecord } from '../database';

const database: any = require('../database');

const logger = consola.withTag('JellyfinPlaylists');

/*
 * Jellyfin's playlists, kept per user, as AIOStreams keeps them. An entry's
 * `PlaylistItemId` is its item's id, as in Jellyfin, so a title is in a
 * playlist once.
 */

/** Past these, creating a playlist or adding to one is refused. */
export const PLAYLIST_LIMITS = { perUser: 200, items: 1000 } as const;

const NAME_LENGTH = 200;
const FULL = `A playlist holds up to ${PLAYLIST_LIMITS.items} titles`;

export interface PlaylistDeps {
  /** The item an id names, as a listing builds it, watched state included; null if it no longer builds. */
  buildItem: (req: any, itemId: string) => Promise<any | null>;
  /** The artwork an item id resolves to. */
  imagesFor: (req: any, itemId: string) => Promise<ItemImages | undefined>;
}

interface Owner {
  userUUID: string;
  profile: string;
}

function concurrency(): number {
  return envInt('JELLYFIN_SHELF_META_CONCURRENCY', 4, 1);
}

// --- Request helpers: clients spell parameters in either case. ---

function pick(source: any, name: string): any {
  if (!source || typeof source !== 'object') return undefined;
  const key = Object.keys(source).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : source[key];
}

function qs(req: any, name: string): string | undefined {
  const value = pick(req.query, name);
  if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function qi(req: any, name: string, fallback: number): number {
  const parsed = parseInt(qs(req, name) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listOf(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

function qlist(req: any, name: string): string[] {
  return listOf(pick(req.query, name));
}

function bodyField(req: any, name: string): any {
  return pick(req.body, name);
}

function nameOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, NAME_LENGTH) : '';
}

/** Ids from the query, else from the body, which takes an array or a comma list. */
function idsOf(req: any, name: string): string[] {
  const fromQuery = qlist(req, name);
  return (fromQuery.length ? fromQuery : listOf(bodyField(req, name))).map(normaliseJellyfinId);
}

function withoutRepeats(ids: string[], taken: Iterable<string> = []): string[] {
  const seen = new Set(taken);
  return ids.filter((id) => !seen.has(id) && !!seen.add(id));
}

async function ownerOf(req: any): Promise<{ owner: Owner; config: any } | null> {
  const config = await loadConfig(req);
  if (!config) return null;
  return { owner: { userUUID: req.params.userUUID, profile: profileKey(config) }, config };
}

// --- What gets added ---

function aired(episode: any, now: number): boolean {
  if (episode?.LocationType === 'Virtual') return false;
  const premiere = episode?.PremiereDate ? Date.parse(episode.PremiereDate) : NaN;
  return !(Number.isFinite(premiere) && premiere > now);
}

/**
 * The titles that play, in order. As in Jellyfin, a show or a season adds its
 * aired episodes and a collection its films.
 */
async function titlesOf(req: any, config: any, raw: string): Promise<string[]> {
  const userUUID = req.params.userUUID;
  const serverId = serverIdFor(userUUID);
  let itemId = normaliseJellyfinId(raw);
  let d: any = await decodeJellyfinId(itemId);
  if (d?.k === 'marker') {
    itemId = normaliseJellyfinId(d.i);
    d = await decodeJellyfinId(itemId);
  }
  if (!d) return [];

  if (d.k === 'episode') return [itemId];

  if (d.k === 'movie') {
    // A TVDB collection is a film whose meta lists the films in it.
    if (!String(d.i).startsWith('tvdbc:')) return [itemId];
    const set = await fetchMeta(userUUID, 'movie', d.i);
    const members = (Array.isArray(set?.videos) ? set.videos : []).map((v: any) => String(v?.id || '')).filter(Boolean);
    return members.map((id: string) => encodeJellyfinId({ k: 'movie', t: 'movie', i: id }));
  }

  if (d.k === 'boxset') {
    const collection = collectionById(config, d.c);
    const folder = folderById(collection, d.f);
    if (!collection || !folder) return [];
    const page = await boxSetMembers(userUUID, config, serverId, collection, folder, 0, PLAYLIST_LIMITS.items, 'Movie');
    return page.items.filter((item: any) => item?.Type === 'Movie').map((item: any) => normaliseJellyfinId(String(item.Id)));
  }

  if (d.k === 'series' || d.k === 'season') {
    const meta = await fetchMeta(userUUID, 'series', d.i);
    if (!meta) return [];
    const seriesId = encodeJellyfinId({ k: 'series', t: d.t, i: d.i });
    const now = Date.now();
    return buildEpisodes(meta, d.t, seriesId, serverId, d.k === 'season' ? d.s : null)
      .filter((episode: any) => aired(episode, now))
      .map((episode: any) => normaliseJellyfinId(String(episode.Id)));
  }

  return [];
}

async function playableIds(req: any, config: any, ids: string[]): Promise<string[]> {
  const found = await mapWithConcurrency(ids.slice(0, PLAYLIST_LIMITS.items), concurrency(), (raw) =>
    titlesOf(req, config, raw).catch((error: any) => {
      logger.debug(`Could not expand ${raw} for a playlist: ${error?.message || error}`);
      return [] as string[];
    })
  );
  return found.flat().slice(0, PLAYLIST_LIMITS.items);
}

// --- Items a client is shown ---

export function playlistsFolder(serverId: string, count: number | null = null): any {
  return {
    ...collectionFolder(PLAYLISTS_FOLDER_ID, serverId, 'Playlists', 'playlists', count),
    Type: 'ManualPlaylistsFolder',
    Path: '/playlists',
  };
}

function playlistDto(serverId: string, playlist: PlaylistRecord, images: ItemImages): any {
  const id = playlist.id;
  const imageTags: Record<string, string> = {};
  if (images.primary) imageTags.Primary = imageTag(images.primary);
  if (images.logo) imageTags.Logo = imageTag(images.logo);
  if (images.thumb) imageTags.Thumb = imageTag(images.thumb);
  return {
    Name: playlist.name,
    SortName: sortNameFor(playlist.name),
    Id: id,
    ServerId: serverId,
    Etag: `${id}${playlist.updatedAt}`,
    Type: 'Playlist',
    MediaType: 'Video',
    IsFolder: true,
    ParentId: PLAYLISTS_FOLDER_ID,
    DisplayPreferencesId: id,
    Path: `/playlists/${id}`,
    DateCreated: new Date(playlist.createdAt).toISOString(),
    DateLastMediaAdded: new Date(playlist.updatedAt).toISOString(),
    ChildCount: playlist.items.length,
    RecursiveItemCount: playlist.items.length,
    CanDelete: true,
    CanDownload: false,
    PlayAccess: 'Full',
    ProviderIds: {},
    ExternalUrls: [],
    Genres: [],
    GenreItems: [],
    People: [],
    Studios: [],
    Tags: [],
    Taglines: [],
    RemoteTrailers: [],
    ImageTags: imageTags,
    BackdropImageTags: images.backdrop ? [imageTag(images.backdrop)] : [],
    ImageBlurHashes: {},
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    LocationType: 'FileSystem',
    PrimaryImageAspectRatio: 0.6666666666666666,
    LockedFields: [],
    LockData: false,
  };
}

/** A playlist's artwork: its first title's, or that episode's show. */
async function playlistImages(req: any, deps: PlaylistDeps, playlist: PlaylistRecord): Promise<ItemImages> {
  const first = playlist.items[0];
  if (!first) return {};
  const built = await deps.buildItem(req, first).catch(() => null);
  const pictured = built?.Type === 'Episode' && built.SeriesId ? String(built.SeriesId) : built?.Id ? String(built.Id) : first;
  const images = (await deps.imagesFor(req, normaliseJellyfinId(pictured)).catch(() => undefined)) ?? {};
  rememberImages(serverIdFor(req.params.userUUID), playlist.id, images);
  return images;
}

async function playlistItem(req: any, deps: PlaylistDeps, playlist: PlaylistRecord): Promise<any> {
  return playlistDto(serverIdFor(req.params.userUUID), playlist, await playlistImages(req, deps, playlist));
}

/**
 * Its entries as list rows, each with `PlaylistItemId`; one that no longer
 * builds is left out, but the count stays the stored one.
 */
async function entries(req: any, deps: PlaylistDeps, playlist: PlaylistRecord): Promise<any> {
  const startIndex = Math.max(0, qi(req, 'StartIndex', 0));
  const limit = qs(req, 'Limit') !== undefined ? Math.max(0, qi(req, 'Limit', 0)) : playlist.items.length;
  const ids = playlist.items.slice(startIndex, startIndex + limit);
  const built = await mapWithConcurrency(ids, concurrency(), (id) => deps.buildItem(req, id).catch(() => null));
  const items = built.flatMap((item, i) => (item?.Id ? [{ ...item, PlaylistItemId: ids[i] }] : []));
  return itemList(items, playlist.items.length, startIndex);
}

/** Sorted by name or date added when asked, else in the order they were made. */
function sortPlaylists(req: any, items: any[]): any[] {
  const by = qlist(req, 'SortBy')[0]?.toLowerCase();
  const key =
    by === 'sortname' || by === 'name'
      ? (i: any) => String(i.SortName)
      : by === 'datecreated'
        ? (i: any) => String(i.DateCreated)
        : by === 'datelastcontentadded'
          ? (i: any) => String(i.DateLastMediaAdded)
          : null;
  if (!key) return items;
  const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b)));
  return qs(req, 'SortOrder')?.toLowerCase().startsWith('desc') ? sorted.reverse() : sorted;
}

// --- Exports for the item, view and image routes ---

/** Whether this profile has a playlist, which is when Jellyfin shows the folder. */
export async function hasPlaylists(req: any, config: any): Promise<boolean> {
  try {
    return await database.hasPlaylists(req.params.userUUID, profileKey(config));
  } catch (error: any) {
    logger.debug(`Could not read playlists for ${req.params.userUUID}: ${error?.message || error}`);
    return false;
  }
}

/** `GET /Items/{id}` for a playlist or the folder; null if it is not this profile's. */
export async function playlistItemById(req: any, deps: PlaylistDeps, descriptor: any): Promise<any | null> {
  const found = await ownerOf(req);
  if (!found) return null;
  const serverId = serverIdFor(req.params.userUUID);
  if (descriptor.k === 'playlists') {
    const playlists = await database.listPlaylists(found.owner.userUUID, found.owner.profile);
    return playlistsFolder(serverId, playlists.length);
  }
  const playlist = await database.getPlaylist(found.owner.userUUID, found.owner.profile, descriptor.p);
  return playlist ? playlistItem(req, deps, playlist) : null;
}

/** A playlist's artwork, when a client asks for it before it was listed. */
export async function playlistImagesById(req: any, deps: PlaylistDeps, playlistId: string): Promise<ItemImages | undefined> {
  const found = await ownerOf(req);
  if (!found) return undefined;
  const playlist = await database.getPlaylist(found.owner.userUUID, found.owner.profile, normaliseJellyfinId(playlistId));
  return playlist ? playlistImages(req, deps, playlist) : undefined;
}

// --- Routes ---

const wrap = (handler: (req: any, res: any, next: any) => Promise<void>) => (req: any, res: any, next: any) => {
  handler(req, res, next).catch((error: any) => {
    logger.warn(`${req.method} ${req.path} failed: ${error?.message || error}`);
    if (!res.headersSent) res.status(500).json({ Message: 'Playlist request failed' });
  });
};

/** `/Items` asking for playlists, or for what one holds; anything else goes on to the library. */
async function playlistParent(req: any): Promise<any | null> {
  const parentId = qs(req, 'ParentId');
  if (parentId) {
    if (!isPlaylistJellyfinId(parentId)) return null;
    const parent = await decodeJellyfinId(parentId);
    return parent?.k === 'playlist' || parent?.k === 'playlists' ? parent : null;
  }
  const types = qlist(req, 'IncludeItemTypes').map((t) => t.toLowerCase());
  return types.length === 1 && types[0] === 'playlist' && !qlist(req, 'Ids').length && !qs(req, 'SearchTerm')
    ? { k: 'playlists' }
    : null;
}

/** Registered ahead of the library's `/Items` route, which it hands everything else to. */
export function registerPlaylists(router: any, deps: PlaylistDeps): void {
  const playlistFor = async (req: any, res: any): Promise<{ owner: Owner; config: any; playlist: PlaylistRecord } | null> => {
    const found = await ownerOf(req);
    const playlist = found
      ? await database.getPlaylist(found.owner.userUUID, found.owner.profile, normaliseJellyfinId(req.params.playlistId))
      : null;
    if (!found || !playlist) {
      res.status(404).json({ Message: 'Playlist not found' });
      return null;
    }
    return { ...found, playlist };
  };

  router.post('/Playlists', wrap(async (req, res) => {
    const found = await ownerOf(req);
    if (!found) {
      res.status(401).json({ Message: 'Not signed in' });
      return;
    }
    const name = nameOf(qs(req, 'Name') ?? bodyField(req, 'Name'));
    if (!name) {
      res.status(400).json({ Message: 'A playlist needs a name' });
      return;
    }
    const items = withoutRepeats(await playableIds(req, found.config, idsOf(req, 'Ids')));
    const playlist = await database.createPlaylist(found.owner.userUUID, found.owner.profile, { id: newPlaylistId(), name, items }, PLAYLIST_LIMITS.perUser);
    if (!playlist) {
      res.status(400).json({ Message: `You can have up to ${PLAYLIST_LIMITS.perUser} playlists` });
      return;
    }
    res.json({ Id: playlist.id });
  }));

  router.get('/Playlists/:playlistId', wrap(async (req, res) => {
    const found = await playlistFor(req, res);
    if (!found) return;
    res.json({ OpenAccess: false, Shares: [], ItemIds: found.playlist.items });
  }));

  router.post('/Playlists/:playlistId', wrap(async (req, res) => {
    const found = await ownerOf(req);
    if (!found) {
      res.status(404).json({ Message: 'Playlist not found' });
      return;
    }
    const name = nameOf(bodyField(req, 'Name'));
    const replacing = bodyField(req, 'Ids') != null;
    const items = replacing ? withoutRepeats(await playableIds(req, found.config, idsOf(req, 'Ids'))) : null;
    const updated = await database.updatePlaylist(found.owner.userUUID, found.owner.profile, normaliseJellyfinId(req.params.playlistId), () =>
      name || items ? { ...(name ? { name } : {}), ...(items ? { items } : {}) } : null
    );
    if (!updated) res.status(404).json({ Message: 'Playlist not found' });
    else res.status(204).end();
  }));

  router.get('/Playlists/:playlistId/Items', wrap(async (req, res) => {
    const found = await playlistFor(req, res);
    if (!found) return;
    res.json(await entries(req, deps, found.playlist));
  }));

  router.post('/Playlists/:playlistId/Items', wrap(async (req, res) => {
    const found = await ownerOf(req);
    if (!found) {
      res.status(404).json({ Message: 'Playlist not found' });
      return;
    }
    const added = await playableIds(req, found.config, idsOf(req, 'Ids'));
    const position = qs(req, 'Position') !== undefined ? qi(req, 'Position', 0) : null;
    let full = false;
    const updated = await database.updatePlaylist(found.owner.userUUID, found.owner.profile, normaliseJellyfinId(req.params.playlistId), (playlist: PlaylistRecord) => {
      const fresh = withoutRepeats(added, playlist.items);
      if (!fresh.length) return null;
      if (playlist.items.length + fresh.length > PLAYLIST_LIMITS.items) {
        full = true;
        return null;
      }
      const at = position === null ? playlist.items.length : Math.min(Math.max(0, position), playlist.items.length);
      const items = [...playlist.items];
      items.splice(at, 0, ...fresh);
      return { items };
    });
    if (!updated) res.status(404).json({ Message: 'Playlist not found' });
    else if (full) res.status(400).json({ Message: FULL });
    else res.status(204).end();
  }));

  router.delete('/Playlists/:playlistId/Items', wrap(async (req, res) => {
    const found = await ownerOf(req);
    if (!found) {
      res.status(404).json({ Message: 'Playlist not found' });
      return;
    }
    const removed = new Set(idsOf(req, 'EntryIds'));
    const updated = await database.updatePlaylist(found.owner.userUUID, found.owner.profile, normaliseJellyfinId(req.params.playlistId), (playlist: PlaylistRecord) => {
      const items = playlist.items.filter((id) => !removed.has(id));
      return items.length === playlist.items.length ? null : { items };
    });
    if (!updated) res.status(404).json({ Message: 'Playlist not found' });
    else res.status(204).end();
  }));

  router.post('/Playlists/:playlistId/Items/:entryId/Move/:newIndex', wrap(async (req, res) => {
    const found = await ownerOf(req);
    if (!found) {
      res.status(404).json({ Message: 'Playlist not found' });
      return;
    }
    const entry = normaliseJellyfinId(req.params.entryId);
    const to = Number(req.params.newIndex);
    const updated = await database.updatePlaylist(found.owner.userUUID, found.owner.profile, normaliseJellyfinId(req.params.playlistId), (playlist: PlaylistRecord) => {
      if (!playlist.items.includes(entry) || !Number.isInteger(to)) return null;
      const items = playlist.items.filter((id) => id !== entry);
      items.splice(Math.min(Math.max(0, to), items.length), 0, entry);
      return { items };
    });
    if (!updated) res.status(404).json({ Message: 'Playlist not found' });
    else res.status(204).end();
  }));

  // Playlists aren't shared between users here, so the owner is the only one.
  router.get('/Playlists/:playlistId/Users', wrap(async (req, res) => {
    if (await playlistFor(req, res)) res.json([]);
  }));
  router.get('/Playlists/:playlistId/Users/:userId', wrap(async (req, res) => {
    if (!(await playlistFor(req, res))) return;
    const own = profileUserId(req.params.userUUID, req.jellyfin?.profileId ?? null);
    if (normaliseJellyfinId(req.params.userId) !== own) res.status(404).json({ Message: 'User permissions not found' });
    else res.json({ UserId: own, CanEdit: true });
  }));
  router.all('/Playlists/:playlistId/Users/:userId', (_req: any, res: any) => {
    res.status(403).json({ Message: 'Playlists are not shared here' });
  });

  const removePlaylists = async (req: any, res: any, ids: string[]): Promise<void> => {
    const found = await ownerOf(req);
    let removed = 0;
    if (found) {
      for (const id of ids) if (await database.removePlaylist(found.owner.userUUID, found.owner.profile, id)) removed++;
    }
    if (removed) res.status(204).end();
    else res.status(404).json({ Message: 'Item not found' });
  };

  // Only playlists can be deleted; anything else carries on to a 404.
  router.delete('/Items/:itemId', wrap(async (req, res, next) => {
    const id = normaliseJellyfinId(req.params.itemId);
    if ((await decodeJellyfinId(id))?.k !== 'playlist') return next();
    await removePlaylists(req, res, [id]);
  }));
  router.delete('/Items', wrap(async (req, res, next) => {
    const ids = qlist(req, 'Ids').map(normaliseJellyfinId);
    const kinds = await Promise.all(ids.map((id) => decodeJellyfinId(id)));
    if (!ids.length || kinds.some((k) => k?.k !== 'playlist')) return next();
    await removePlaylists(req, res, ids);
  }));

  router.get(['/Items', '/Users/:userId/Items'], wrap(async (req, res, next) => {
    const parent = await playlistParent(req).catch(() => null);
    if (!parent) return next();
    const found = await ownerOf(req);
    if (!found) {
      res.json(itemList([], 0, 0));
      return;
    }

    if (parent.k === 'playlist') {
      const playlist = await database.getPlaylist(found.owner.userUUID, found.owner.profile, parent.p);
      res.json(playlist ? await entries(req, deps, playlist) : itemList([], 0, 0));
      return;
    }

    const playlists: PlaylistRecord[] = await database.listPlaylists(found.owner.userUUID, found.owner.profile);
    const built = await mapWithConcurrency(playlists, concurrency(), (p) => playlistItem(req, deps, p));
    const sorted = sortPlaylists(req, built);
    const startIndex = Math.max(0, qi(req, 'StartIndex', 0));
    const end = qs(req, 'Limit') !== undefined ? startIndex + Math.max(0, qi(req, 'Limit', 0)) : sorted.length;
    const page = sorted.slice(startIndex, end);
    const countAll = qs(req, 'EnableTotalRecordCount')?.toLowerCase() !== 'false';
    res.json(itemList(page, countAll ? sorted.length : page.length, startIndex));
  }));
}
