import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { mapWithConcurrency } from '../../utils/concurrency';
import { loadConfig, serverIdFor } from './context';
import { EMPTY_USER_DATA, collectionFolder, itemList } from './dto';
import { decodeJellyfinId, encodeJellyfinId } from './ids';
import type { Descriptor } from './ids';
import { imageTag } from './imageTags';
import { rememberImages } from './items';
import { normaliseStreamBase, streamUserAgent } from './streams';

/**
 * Live TV for the Jellyfin front-end, read from the stream addon the user already
 * delegates playback to (an AIOStreams install with an Xtream addon, say). That
 * addon lists channels as a `tv` catalog and, when it can, answers the `date`
 * extra with each channel's programmes, so nothing is fetched from a provider here
 * and no login is held. Playback is the same stream addon asked for the channel or
 * programme, and the server only redirects to what it returns.
 *
 * Modelled on AIOStreams' own Jellyfin Live TV (core/jellyfin/livetv.ts and
 * server/routes/jellyfin/livetv.ts): the same lazy lineups, numbering, guide reads,
 * catch-up rule and Programs filters.
 */

const logger = consola.withTag('JellyfinLiveTv');

const TICKS_PER_MS = 10000;
const DAY_MS = 86_400_000;
const GUIDE_DAYS = 7;
const MAX_DAYS_BACK = 14;
/** A guide window is read a UTC day at a time; this bounds a request asking for years. */
const MAX_GUIDE_DAYS = MAX_DAYS_BACK + GUIDE_DAYS + 2;
/** Channels asked for at once from a guide that takes ids. */
const IDS_PER_REQUEST = 50;
/** How far a search reads the channel list, which it holds an hour. */
const SEARCHED = 5_000;
/** Channels read for a Programs request that names none, such as what is on now. */
const UNNAMED_CHANNELS = 100;
const MAX_LIMIT = 500;

const maxPages = (): number => envInt('JELLYFIN_LIVETV_MAX_PAGES', 40, 1);
const lineupTtl = (): number => envInt('JELLYFIN_LIVETV_LINEUP_TTL', 60 * 60, 60) * 1000;
const guideTtl = (): number => envInt('JELLYFIN_LIVETV_GUIDE_TTL', 5 * 60, 30) * 1000;
const guideConcurrency = (): number => envInt('JELLYFIN_LIVETV_CONCURRENCY', 4, 1);
const requestTimeout = (): number => envInt('JELLYFIN_STREAM_TIMEOUT_MS', 15000, 1000);

export interface LiveCatalog {
  base: string;
  type: string;
  id: string;
  name: string;
  groups: string[];
  /** Pages by `skip`; without it the first page is the whole list. */
  skip: boolean;
  /** Answers `ids`, so a page of channels can be given their programmes in one request. */
  ids: boolean;
  /** Answers `search`, which finds channels past what the list reads. */
  search: boolean;
  /** Answers `date`, which is what makes a catalog a guide. */
  guide: boolean;
}

export interface LiveSource {
  base: string;
  catchupDays: number;
  catalogs: LiveCatalog[];
}

export interface Channel {
  id: string;
  type: string;
  name: string;
  logo?: string;
  /** The number the addon gives it, if any. */
  channelNumber?: string;
  group?: string;
  catchupDays: number;
}

export interface ListedChannel {
  channel: Channel;
  number?: string;
}

export interface Programme {
  /** The guide's own id for it, which is what its catch-up is asked for by. */
  id: string;
  title: string;
  start: number;
  end: number;
  overview?: string;
  image?: string;
  background?: string;
  genres: string[];
  cast: string[];
  directors: string[];
  season?: number;
  episode?: number;
  imdbId?: string;
}

export interface ChannelGuide {
  meta?: any;
  programmes: Programme[];
}

const catalogKey = (catalog: { type: string; id: string }): string => `${catalog.type}/${catalog.id}`;
const keyOf = (c: { type: string; id: string }): string => `${c.type}|${c.id}`;
const scopedKey = (base: string, c: { type: string; id: string }): string => `${base}|${c.type}|${c.id}`;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
const whole = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

// --- Reading the stream addon ---

async function getJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout());
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': streamUserAgent() },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      logger.debug(`${url} returned ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error: any) {
    logger.debug(`${url} failed: ${error?.message || error}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extraNames(catalog: any): Set<string> {
  const names = new Set<string>();
  for (const extra of Array.isArray(catalog?.extra) ? catalog.extra : []) {
    if (typeof extra?.name === 'string') names.add(extra.name);
  }
  for (const name of Array.isArray(catalog?.extraSupported) ? catalog.extraSupported : []) {
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

function liveCatalogOf(base: string, catalog: any): LiveCatalog | null {
  if (!catalog || typeof catalog.id !== 'string' || typeof catalog.type !== 'string') return null;
  const names = extraNames(catalog);
  const guide = names.has('date');
  if (catalog.type !== 'tv' && catalog.type !== 'channel' && !guide) return null;
  // A catalog that cannot be listed without being told what to list is not a channel list.
  const required = (Array.isArray(catalog.extra) ? catalog.extra : []).filter((e: any) => e?.isRequired && e?.name !== 'genre');
  if (required.length > 0) return null;

  const genre = (Array.isArray(catalog.extra) ? catalog.extra : []).find((e: any) => e?.name === 'genre');
  const groups = Array.isArray(genre?.options) ? genre.options.filter((g: any) => typeof g === 'string' && g) : [];
  return {
    base,
    type: catalog.type,
    id: catalog.id,
    name: typeof catalog.name === 'string' && catalog.name ? catalog.name : catalog.id,
    groups,
    skip: names.has('skip'),
    ids: names.has('ids'),
    search: names.has('search'),
    guide,
  };
}

const sources = new LRUCache<string, LiveSource>({ max: 200, ttl: 5 * 60 * 1000 });
const sourcesInFlight = new Map<string, Promise<LiveSource | null>>();

export async function sourceFor(config: any): Promise<LiveSource | null> {
  const base = normaliseStreamBase(config?.jellyfinStreamUrl || '');
  if (!base) return null;
  const held = sources.get(base);
  if (held) return held.catalogs.length ? held : null;

  const running = sourcesInFlight.get(base);
  if (running) return running;
  const work = (async () => {
    const manifest = await getJson(`${base}/manifest.json`);
    if (!manifest) {
      // An addon that did not answer is asked again soon, not in five minutes.
      sources.set(base, { base, catchupDays: 0, catalogs: [] }, { ttl: 60 * 1000 });
      return null;
    }
    const catalogs = (Array.isArray(manifest.catalogs) ? manifest.catalogs : [])
      .map((c: any) => liveCatalogOf(base, c))
      .filter((c: LiveCatalog | null): c is LiveCatalog => c !== null);
    const catchupDays = Math.max(0, Number(manifest.behaviorHints?.catchupDays) || 0);
    const source = { base, catchupDays, catalogs };
    sources.set(base, source);
    return catalogs.length ? source : null;
  })().finally(() => sourcesInFlight.delete(base));
  sourcesInFlight.set(base, work);
  return work;
}

function buildExtras(catalog: LiveCatalog, extras: { genre?: string; skip?: number; date?: string; ids?: string[]; search?: string }): string {
  const parts: string[] = [];
  if (extras.genre) parts.push(`genre=${encodeURIComponent(extras.genre)}`);
  if (extras.skip && catalog.skip) parts.push(`skip=${extras.skip}`);
  if (extras.date) parts.push(`date=${encodeURIComponent(extras.date)}`);
  if (extras.ids?.length) parts.push(`ids=${encodeURIComponent(extras.ids.join(','))}`);
  if (extras.search) parts.push(`search=${encodeURIComponent(extras.search)}`);
  return parts.join('&');
}

function catalogUrl(catalog: LiveCatalog, extras: Parameters<typeof buildExtras>[1]): string {
  const query = buildExtras(catalog, extras);
  return `${catalog.base}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}${query ? `/${query}` : ''}.json`;
}

const metasOf = (body: any): any[] =>
  Array.isArray(body?.metasDetailed) ? body.metasDetailed : Array.isArray(body?.metas) ? body.metas : [];

/** A page of a catalog, or null when the addon did not answer. */
async function readPage(catalog: LiveCatalog, extras: Parameters<typeof buildExtras>[1]): Promise<any[] | null> {
  const body = await getJson(catalogUrl(catalog, extras));
  return body ? metasOf(body) : null;
}

// Guide pages and metas are asked for again by every client opening the guide, so they are held briefly.
const guideReads = new LRUCache<string, any[]>({ max: 2000 });

async function readGuidePage(catalog: LiveCatalog, extras: Parameters<typeof buildExtras>[1]): Promise<any[]> {
  const url = catalogUrl(catalog, extras);
  const held = guideReads.get(url);
  if (held) return held;
  const metas = await readPage(catalog, extras);
  if (metas) guideReads.set(url, metas, { ttl: guideTtl() });
  return metas ?? [];
}

async function readMeta(base: string, type: string, id: string): Promise<any | null> {
  const url = `${base}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const held = guideReads.get(url);
  if (held) return held[0] ?? null;
  const body = await getJson(url);
  const meta = body?.meta && typeof body.meta === 'object' ? body.meta : null;
  if (body) guideReads.set(url, meta ? [meta] : [], { ttl: guideTtl() });
  return meta;
}

// --- Channels ---

function channelFrom(meta: any, fallbackType: string): Channel | null {
  if (!meta || typeof meta.id !== 'string' || !meta.id) return null;
  const days = Number(meta.behaviorHints?.catchupDays);
  const logo = text(meta.logo) ?? text(meta.poster);
  const number = text(String(meta.channelNumber ?? ''));
  return {
    id: meta.id,
    type: text(meta.type) ?? fallbackType,
    name: text(meta.name) ?? meta.id,
    ...(logo ? { logo } : {}),
    ...(number ? { channelNumber: number } : {}),
    ...(texts(meta.genres)[0] ? { group: texts(meta.genres)[0] } : {}),
    catchupDays: days > 0 ? days : 0,
  };
}

/** A live catalog's channels in order, read a page at a time as clients go further. */
interface Lineup {
  channels: Channel[];
  /** The skip each channel was listed at, so its programmes come from the same page. */
  skips: number[];
  next: number;
  done: boolean;
  /** How many of the channels have had their place recorded. */
  placed: number;
}

/** Where a channel was listed, so its programmes come from the same page on any day. */
interface Placement {
  catalog: string;
  genre?: string;
  skip: number;
  number?: string;
  /** Found by id rather than listed; a listing replaces it. */
  byId?: boolean;
}

const lineups = new LRUCache<string, Lineup>({ max: 2000 });
const lineupLocks = new Map<string, Promise<Lineup>>();
const placements = new LRUCache<string, Placement>({ max: 200_000 });
const channelsById = new LRUCache<string, Channel>({ max: 200_000 });

function remember(base: string, channel: Channel): void {
  channelsById.set(scopedKey(base, channel), channel, { ttl: lineupTtl() });
}

async function growLineup(catalog: LiveCatalog, genre: string | undefined, want: number, key: string, cached: Lineup | undefined): Promise<Lineup> {
  const lineup: Lineup = cached
    ? { ...cached, channels: [...cached.channels], skips: [...cached.skips] }
    : { channels: [], skips: [], next: 0, done: false, placed: 0 };
  const seen = new Set(lineup.channels.map(keyOf));
  let pages = 0;
  while (!lineup.done && lineup.channels.length < want && pages < maxPages()) {
    const page = await readPage(catalog, { genre, skip: lineup.next });
    // An addon that did not answer leaves the list as far as it got, to be read on from there next time.
    if (!page) break;
    pages++;
    let fresh = 0;
    for (const meta of page) {
      const channel = channelFrom(meta, catalog.type);
      if (!channel || seen.has(keyOf(channel))) continue;
      seen.add(keyOf(channel));
      lineup.channels.push(channel);
      lineup.skips.push(lineup.next);
      remember(catalog.base, channel);
      fresh++;
    }
    lineup.next += page.length;
    if (!fresh || !catalog.skip) lineup.done = true;
  }
  if (pages) lineups.set(key, lineup, { ttl: lineupTtl() });
  return lineup;
}

async function lineupOf(catalog: LiveCatalog, genre: string | undefined, want: number): Promise<Lineup> {
  const key = `${catalog.base}|${catalogKey(catalog)}|${genre ?? ''}`;
  for (let running = lineupLocks.get(key); running; running = lineupLocks.get(key)) {
    await running.catch(() => undefined);
  }
  const cached = lineups.get(key);
  if (cached && (cached.done || cached.channels.length >= want)) return cached;
  const work = growLineup(catalog, genre, want, key, cached).finally(() => lineupLocks.delete(key));
  lineupLocks.set(key, work);
  return work;
}

/**
 * Channels across the live catalogs in the addon's order, numbered by their place
 * in that whole list unless the addon numbers them. A group lists a genre, and
 * keeps the numbers the whole list gave its channels.
 */
export async function listChannels(
  source: LiveSource,
  opts: { startIndex: number; limit: number; genre?: string }
): Promise<{ channels: ListedChannel[]; total: number }> {
  const end = opts.startIndex + opts.limit;
  const channels: ListedChannel[] = [];
  let offset = 0;
  let complete = true;
  for (const catalog of source.catalogs) {
    if (opts.genre && !catalog.groups.includes(opts.genre)) continue;
    const lineup = await lineupOf(catalog, opts.genre, end - offset);
    const place = (i: number): string | undefined => {
      const channel = lineup.channels[i];
      const key = scopedKey(source.base, channel);
      const placed = placements.get(key);
      const number = channel.channelNumber ?? (opts.genre ? placed?.number : String(offset + i + 1));
      if (!placed || placed.byId || (!opts.genre && placed.genre !== undefined)) {
        placements.set(key, { catalog: catalogKey(catalog), genre: opts.genre, skip: lineup.skips[i], number }, { ttl: lineupTtl() });
      }
      return number;
    };
    // New channels are placed once; the page's own are checked again, as a place can expire before its lineup.
    for (let i = lineup.placed; i < lineup.channels.length; i++) place(i);
    lineup.placed = lineup.channels.length;
    const last = Math.min(lineup.channels.length, end - offset);
    for (let i = Math.max(0, opts.startIndex - offset); i < last; i++) {
      channels.push({ channel: lineup.channels[i], number: place(i) });
    }
    offset += lineup.channels.length;
    if (!lineup.done) {
      complete = false;
      break;
    }
  }
  return { channels, total: complete ? offset : Math.max(offset, end) + 1 };
}

export function groupsOf(source: LiveSource): string[] {
  return [...new Set(source.catalogs.flatMap((c) => c.groups))];
}

function numberOf(base: string, channel: Channel): string | undefined {
  return channel.channelNumber ?? placements.get(scopedKey(base, channel))?.number;
}

/** One channel by id: from a list already read, else asked of its catalogs by id, else its meta. */
export async function channelById(source: LiveSource, type: string, id: string): Promise<Channel | null> {
  const held = channelsById.get(scopedKey(source.base, { type, id }));
  if (held) return held;
  for (const catalog of source.catalogs.filter((c) => c.type === type && c.ids)) {
    const metas = await readGuidePage(catalog, { ids: [id] });
    const channel = channelFrom(metas.find((m) => m?.id === id), type);
    if (channel) {
      remember(source.base, channel);
      const key = scopedKey(source.base, channel);
      if (!placements.get(key)) {
        placements.set(key, { catalog: catalogKey(catalog), skip: 0, number: channel.channelNumber, byId: true }, { ttl: lineupTtl() });
      }
      return channel;
    }
  }
  const channel = channelFrom(await readMeta(source.base, type, id), type);
  if (channel) remember(source.base, channel);
  return channel;
}

/** A catalog's own search, for channels past what the list reads. */
async function searchCatalog(source: LiveSource, catalog: LiveCatalog, term: string): Promise<ListedChannel[]> {
  const metas = (await readPage(catalog, { search: term })) ?? [];
  const found: ListedChannel[] = [];
  for (const meta of metas) {
    const channel = channelFrom(meta, catalog.type);
    if (!channel) continue;
    remember(source.base, channel);
    found.push({ channel, number: numberOf(source.base, channel) });
  }
  return found;
}

/** Channels whose names hold every word of the term, in list order, with the one numbered it first. */
export async function searchChannels(source: LiveSource, term: string, limit: number): Promise<ListedChannel[]> {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const [{ channels }, ...searched] = await Promise.all([
    listChannels(source, { startIndex: 0, limit: SEARCHED }),
    ...source.catalogs.filter((c) => c.search).map((c) => searchCatalog(source, c, term)),
  ]);
  const named = channels.filter(({ channel }) => words.every((w) => channel.name.toLowerCase().includes(w)));
  const seen = new Set(named.map(({ channel }) => keyOf(channel)));
  for (const found of searched.flat()) {
    const key = keyOf(found.channel);
    if (!seen.has(key)) named.push(found);
    seen.add(key);
  }
  const wanted = term.trim();
  const numbered = channels.find(({ number }) => number === wanted) ?? named.find(({ number }) => number === wanted);
  return (numbered ? [numbered, ...named.filter((c) => c !== numbered)] : named).slice(0, limit);
}

// --- Programmes ---

/** A channel's schedule: in a guide, its videos carry `startTime` and `endTime`. */
export function programmesOf(entry: any): Programme[] {
  const videos = entry?.videos;
  if (!Array.isArray(videos)) return [];
  const out: Programme[] = [];
  for (const v of videos) {
    const id = text(v?.id);
    const start = Date.parse(String(v?.startTime ?? ''));
    const end = Date.parse(String(v?.endTime ?? ''));
    if (!id || !(end > start)) continue;
    out.push({
      id,
      title: text(v.title) ?? text(v.name) ?? '',
      start,
      end,
      overview: text(v.overview),
      image: text(v.thumbnail),
      background: text(v.background),
      genres: texts(v.genres),
      cast: texts(v.cast),
      directors: texts(v.directors),
      season: whole(v.season),
      episode: whole(v.episode),
      imdbId: text(v.imdbId),
    });
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  // Merged guides overlap: a programme ends where the next one starts, and of two starting together the longer is kept.
  const kept: Programme[] = [];
  for (const p of out) {
    const last = kept[kept.length - 1];
    if (last && p.start <= last.start) continue;
    if (last && last.end > p.start) last.end = p.start;
    kept.push(p);
  }
  return kept;
}

export function airingAt(programmes: Programme[] | undefined, at: number): Programme | undefined {
  return programmes?.find((p) => p.start <= at && at < p.end);
}

/** The UTC days a window touches, as the guide's `date` extra names them. */
function utcDays(from: number, to: number): string[] {
  const days: string[] = [];
  for (let at = Math.floor(from / DAY_MS) * DAY_MS; at < to && days.length < MAX_GUIDE_DAYS; at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

interface GuideRead {
  catalog: LiveCatalog;
  day: string;
  wanted: Set<string>;
  skip: number;
  genre?: string;
  ids?: Set<string>;
}

/**
 * Each channel's programmes overlapping a window, keyed `type|id`, read once per
 * UTC day: by id from a guide that takes ids, else from the guide page it was
 * listed on, else from its own meta.
 */
export async function programmesFor(
  source: LiveSource,
  channels: Array<{ type: string; id: string }>,
  from: number,
  to: number
): Promise<Map<string, ChannelGuide>> {
  const catalogs = new Map(source.catalogs.map((c) => [catalogKey(c), c]));
  const reads = new Map<string, GuideRead>();
  const unplaced: Array<{ type: string; id: string }> = [];
  for (const channel of channels) {
    const placement = placements.get(scopedKey(source.base, channel));
    const catalog = placement ? catalogs.get(placement.catalog) : undefined;
    if (!placement || !catalog || !catalog.guide) {
      unplaced.push(channel);
      continue;
    }
    const byId = catalog.ids;
    for (const day of utcDays(from, to)) {
      const key = byId ? `${placement.catalog}|${day}` : `${placement.catalog}|${placement.genre ?? ''}|${placement.skip}|${day}`;
      const read: GuideRead = reads.get(key) ?? {
        catalog,
        day,
        wanted: new Set<string>(),
        ...(byId ? { skip: 0, ids: new Set<string>() } : { skip: placement.skip, genre: placement.genre }),
      };
      read.wanted.add(keyOf(channel));
      read.ids?.add(channel.id);
      reads.set(key, read);
    }
  }

  const requests = [...reads.values()].flatMap((read) => {
    if (!read.ids) return [{ read, ids: undefined as string[] | undefined }];
    const ids = [...read.ids].sort();
    const chunks: Array<{ read: GuideRead; ids?: string[] }> = [];
    for (let at = 0; at < ids.length; at += IDS_PER_REQUEST) chunks.push({ read, ids: ids.slice(at, at + IDS_PER_REQUEST) });
    return chunks;
  });

  const found = new Map<string, ChannelGuide>();
  const add = (key: string, meta: any) => {
    const held = found.get(key);
    found.set(key, { meta: held?.meta ?? meta ?? undefined, programmes: [...(held?.programmes ?? []), ...programmesOf(meta)] });
  };

  const tasks: Array<() => Promise<void>> = [
    ...requests.map(({ read, ids }) => async () => {
      const metas = await readGuidePage(read.catalog, { genre: read.genre, skip: read.skip, date: read.day, ids });
      for (const meta of metas) {
        if (typeof meta?.id !== 'string') continue;
        const key = keyOf({ type: text(meta.type) ?? read.catalog.type, id: meta.id });
        if (read.wanted.has(key)) add(key, meta);
      }
    }),
    ...unplaced.map((channel) => async () => {
      add(keyOf(channel), await readMeta(source.base, channel.type, channel.id));
    }),
  ];
  await mapWithConcurrency(tasks, guideConcurrency(), (task) => task());

  for (const guide of found.values()) {
    const byStart = new Map(guide.programmes.map((p) => [p.start, p]));
    guide.programmes = [...byStart.values()].filter((p) => p.end > from && p.start < to).sort((a, b) => a.start - b.start);
  }
  return found;
}

// --- Catch-up and playback ---

function catchupDaysOf(meta: any, channel?: Channel | null): number {
  const days = Number(meta?.behaviorHints?.catchupDays);
  return days > 0 ? days : channel?.catchupDays ?? 0;
}

/** Whether a programme that has begun is still within its channel's catch-up. */
function caughtUp(days: number, start: number, now = Date.now()): boolean {
  return days > 0 && start <= now && start >= now - days * DAY_MS;
}

/** How far back the guide goes: the longest catch-up the addon declares. */
function guideDaysBack(source: LiveSource | null): number {
  return Math.min(MAX_DAYS_BACK, source?.catchupDays ?? 0);
}

export interface StreamRequest {
  type: string;
  id: string;
  /** Plays as it airs: no length, and no end to seek to. */
  live: boolean;
  runtimeMs?: number;
  /** Tells this item's sources from another channel's. */
  scope: string;
}

/**
 * What to ask the stream addon for a channel or programme, or null for anything
 * else. A programme that has begun and is still within its channel's catch-up
 * plays from its start; anything else plays the channel as it is.
 */
export async function streamRequestFor(config: any, descriptor: Descriptor | null): Promise<StreamRequest | null> {
  if (!descriptor || (descriptor.k !== 'channel' && descriptor.k !== 'program')) return null;
  const type = descriptor.t;
  const scope = `livetv|${type}|${descriptor.i}`;
  const live = { type, id: descriptor.i, live: true, scope };
  if (descriptor.k === 'channel' || descriptor.at > Date.now()) return live;

  const source = await sourceFor(config);
  if (!source) return live;
  const guide = (await programmesFor(source, [{ type, id: descriptor.i }], descriptor.at, descriptor.at + 1)).get(keyOf({ type, id: descriptor.i }));
  const programme = guide?.programmes.find((p) => p.start === descriptor.at);
  if (!programme) return live;
  const channel = guide?.meta ? null : await channelById(source, type, descriptor.i);
  if (!caughtUp(catchupDaysOf(guide?.meta, channel), programme.start)) return live;
  return { type, id: programme.id, live: false, runtimeMs: programme.end - programme.start, scope: `${scope}|${programme.start}` };
}

// --- Jellyfin items ---

export function liveTvViewId(): string {
  return encodeJellyfinId({ k: 'livetv' });
}

/** The one view that stands for every live catalog, as Jellyfin's Live TV does. Its genres are the channels' groups. */
export async function liveTvView(config: any, serverId: string): Promise<any | null> {
  const source = await sourceFor(config);
  if (!source) return null;
  const id = liveTvViewId();
  return {
    ...collectionFolder(id, serverId, 'Live TV', 'livetv', null),
    aiostreams: { groups: true, ...(source.catalogs.some((c) => c.guide) ? { guide: true } : {}) },
  };
}

const FLAG_GENRES: Array<[string, RegExp]> = [
  ['IsMovie', /\b(movie|film)s?\b/i],
  ['IsNews', /\bnews\b/i],
  ['IsKids', /\b(kids|children|animation|cartoon)s?\b/i],
  ['IsSports', /\bsports?\b/i],
];
const FLAGS = ['IsMovie', 'IsSeries', 'IsNews', 'IsKids', 'IsSports'];

function channelItemId(channel: { type: string; id: string }): string {
  return encodeJellyfinId({ k: 'channel', t: channel.type, i: channel.id });
}

function programItem(programme: Programme, channel: Channel, number: string | undefined, catchupDays: number, serverId: string, now: number): any {
  const id = encodeJellyfinId({ k: 'program', t: channel.type, i: channel.id, at: programme.start, to: programme.end });
  const images = { primary: programme.image, backdrop: programme.background };
  rememberImages(serverId, id, images);
  const genre = programme.genres.join(' ');
  return {
    Name: programme.title || channel.name,
    ServerId: serverId,
    Id: id,
    Etag: id,
    Type: 'Program',
    MediaType: 'Video',
    IsFolder: false,
    ChannelId: channelItemId(channel),
    ChannelName: channel.name,
    ...(number ? { ChannelNumber: number } : {}),
    ...(channel.logo ? { ChannelPrimaryImageTag: imageTag(channel.logo) } : {}),
    ChannelType: 'TV',
    StartDate: new Date(programme.start).toISOString(),
    EndDate: new Date(programme.end).toISOString(),
    DateCreated: new Date(programme.start).toISOString(),
    RunTimeTicks: (programme.end - programme.start) * TICKS_PER_MS,
    Overview: programme.overview ?? null,
    IsSeries: programme.season !== undefined || programme.episode !== undefined,
    ...(programme.season !== undefined ? { ParentIndexNumber: programme.season } : {}),
    ...(programme.episode !== undefined ? { IndexNumber: programme.episode } : {}),
    Genres: programme.genres,
    GenreItems: [],
    People: [
      ...programme.cast.map((name) => ({ Name: name, Type: 'Actor' })),
      ...programme.directors.map((name) => ({ Name: name, Type: 'Director' })),
    ].map((person) => ({ ...person, Id: encodeJellyfinId({ k: 'person', n: person.Name }) })),
    ProviderIds: programme.imdbId ? { Imdb: programme.imdbId } : {},
    Tags: [],
    Studios: [],
    ExternalUrls: [],
    RemoteTrailers: [],
    Taglines: [],
    ImageTags: programme.image ? { Primary: imageTag(programme.image) } : {},
    BackdropImageTags: programme.background ? [imageTag(programme.background)] : [],
    ImageBlurHashes: {},
    LocationType: 'Remote',
    PlayAccess: 'Full',
    CanDelete: false,
    CanDownload: false,
    IsLive: programme.start <= now && now < programme.end,
    ...Object.fromEntries(FLAG_GENRES.map(([flag, re]) => [flag, re.test(genre)])),
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    ...(caughtUp(catchupDays, programme.start, now) ? { aiostreams: { catchup: true } } : {}),
  };
}

function channelItem(channel: Channel, number: string | undefined, serverId: string, current?: { programme: Programme; catchupDays: number }, now = Date.now()): any {
  const id = channelItemId(channel);
  if (channel.logo) rememberImages(serverId, id, { primary: channel.logo });
  return {
    Name: channel.name,
    SortName: channel.name,
    ServerId: serverId,
    Id: id,
    Etag: id,
    Type: 'TvChannel',
    MediaType: 'Video',
    ChannelType: 'TV',
    ...(number ? { ChannelNumber: number, Number: number } : {}),
    IsFolder: false,
    ImageTags: channel.logo ? { Primary: imageTag(channel.logo) } : {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    PrimaryImageAspectRatio: 1,
    DateCreated: new Date(0).toISOString(),
    LocationType: 'Remote',
    PlayAccess: 'Full',
    CanDelete: false,
    CanDownload: false,
    Genres: channel.group ? [channel.group] : [],
    GenreItems: [],
    Tags: [],
    People: [],
    Studios: [],
    ProviderIds: {},
    ExternalUrls: [],
    RemoteTrailers: [],
    Taglines: [],
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    ...(current ? { CurrentProgram: programItem(current.programme, channel, number, current.catchupDays, serverId, now) } : {}),
  };
}

/** Channel items with what each has on now, from one guide read for the page. */
async function channelListItems(source: LiveSource, listed: ListedChannel[], serverId: string, addCurrent: boolean): Promise<any[]> {
  const now = Date.now();
  const guide = addCurrent && listed.length
    ? await programmesFor(source, listed.map((l) => l.channel), now, now + 1)
    : new Map<string, ChannelGuide>();
  return listed.map(({ channel, number }) => {
    const found = guide.get(keyOf(channel));
    const airing = airingAt(found?.programmes, now);
    return channelItem(channel, number, serverId, airing ? { programme: airing, catchupDays: catchupDaysOf(found?.meta, channel) } : undefined, now);
  });
}

// --- Request parsing ---

/** A query field, or the same field of a POST body as Jellyfin's clients send it. */
function field(req: any, name: string): string | undefined {
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  for (const raw of [req.body?.[name], req.body?.[lower], req.query?.[name], req.query?.[lower]]) {
    if (Array.isArray(raw)) return raw.join(',');
    if (raw !== undefined && raw !== null && raw !== '') return String(raw);
  }
  return undefined;
}

function list(req: any, name: string): string[] {
  return (field(req, name) ?? '').split(/[,|]/).map((v) => v.trim()).filter(Boolean);
}

/** True, false, or undefined when not asked. */
function flagOf(req: any, name: string): boolean | undefined {
  const value = field(req, name)?.toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function timeOf(req: any, name: string): number | undefined {
  const at = Date.parse(field(req, name) ?? '');
  return Number.isFinite(at) ? at : undefined;
}

function intOf(req: any, name: string, fallback: number): number {
  const value = Math.floor(Number(field(req, name)));
  return Number.isFinite(value) ? value : fallback;
}

/** A group: a genre named outright, or by a genre item's id. */
async function groupOf(req: any): Promise<string | undefined> {
  const named = list(req, 'Genres')[0];
  if (named) return named;
  for (const raw of list(req, 'GenreIds')) {
    const descriptor = await decodeJellyfinId(raw);
    if (descriptor?.k === 'genre') return descriptor.g;
  }
  return undefined;
}

export const LIVE_GENRE_CATALOG = 'livetv';

// --- Responses ---

async function channelsResponse(req: any, config: any): Promise<any> {
  const startIndex = Math.max(0, intOf(req, 'StartIndex', 0));
  const limit = Math.min(Math.max(1, intOf(req, 'Limit', 100)), MAX_LIMIT);
  const source = await sourceFor(config);
  if (!source || flagOf(req, 'IsFavorite') === true) return itemList([], 0, startIndex);

  const serverId = serverIdFor(req.params.userUUID);
  const addCurrent = flagOf(req, 'AddCurrentProgram') !== false;
  const term = field(req, 'SearchTerm')?.trim();
  if (term) {
    const found = await searchChannels(source, term, startIndex + limit);
    const page = found.slice(startIndex, startIndex + limit);
    return itemList(await channelListItems(source, page, serverId, addCurrent), found.length, startIndex);
  }
  const { channels, total } = await listChannels(source, { startIndex, limit, genre: await groupOf(req) });
  return itemList(await channelListItems(source, channels, serverId, addCurrent), total, startIndex);
}

async function programmesResponse(req: any, config: any, recommended = false): Promise<any> {
  const startIndex = Math.max(0, intOf(req, 'StartIndex', 0));
  const source = await sourceFor(config);
  if (!source) return itemList([], 0, startIndex);

  const now = Date.now();
  const airing = recommended ? (flagOf(req, 'IsAiring') ?? true) : flagOf(req, 'IsAiring');
  const aired = flagOf(req, 'HasAired');
  const minStart = timeOf(req, 'MinStartDate');
  const maxStart = timeOf(req, 'MaxStartDate');
  const minEnd = timeOf(req, 'MinEndDate');
  const maxEnd = timeOf(req, 'MaxEndDate');
  const from = airing ? now : (minEnd ?? minStart ?? now);
  const to = airing ? now + 1 : (maxStart ?? maxEnd ?? from + DAY_MS);

  const channels: ListedChannel[] = [];
  const named = list(req, 'ChannelIds');
  if (named.length) {
    for (const raw of named) {
      const descriptor = await decodeJellyfinId(raw);
      if (descriptor?.k !== 'channel') continue;
      const channel = (await channelById(source, descriptor.t, descriptor.i)) ?? { id: descriptor.i, type: descriptor.t, name: descriptor.i, catchupDays: 0 };
      channels.push({ channel, number: numberOf(source.base, channel) });
    }
  } else {
    const listed = await listChannels(source, { startIndex: 0, limit: UNNAMED_CHANNELS, genre: await groupOf(req) });
    channels.push(...listed.channels);
  }

  const guide = await programmesFor(source, channels.map((c) => c.channel), from, to);
  const serverId = serverIdFor(req.params.userUUID);
  const flags = FLAGS.filter((f) => flagOf(req, f) !== undefined);
  const genres = new Set(list(req, 'Genres').map((g) => g.toLowerCase()));
  let items: any[] = [];
  for (const { channel, number } of channels) {
    const found = guide.get(keyOf(channel));
    const days = catchupDaysOf(found?.meta, channel);
    for (const p of found?.programmes ?? []) {
      if (minStart !== undefined && p.start < minStart) continue;
      if (maxStart !== undefined && p.start > maxStart) continue;
      if (minEnd !== undefined && p.end < minEnd) continue;
      if (maxEnd !== undefined && p.end > maxEnd) continue;
      if (airing !== undefined && (p.start <= now && now < p.end) !== airing) continue;
      if (aired !== undefined && (p.end <= now) !== aired) continue;
      if (genres.size && !p.genres.some((g) => genres.has(g.toLowerCase()))) continue;
      const item = programItem(p, channel, number, days, serverId, now);
      if (flags.some((f) => item[f] !== flagOf(req, f))) continue;
      items.push(item);
    }
  }

  const sortBy = list(req, 'SortBy').map((s) => s.toLowerCase());
  if (!sortBy.includes('sortname') && !sortBy.includes('name')) {
    items.sort((a, b) => Date.parse(String(a.StartDate)) - Date.parse(String(b.StartDate)));
  } else {
    items.sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
  }
  if (list(req, 'SortOrder')[0]?.toLowerCase() === 'descending') items = items.reverse();

  // Without a limit a guide gets every programme in its window, as AIOStreams answers it.
  const limit = Math.min(Math.max(1, intOf(req, 'Limit', items.length || 1)), MAX_LIMIT * 4);
  return itemList(items.slice(startIndex, startIndex + limit), items.length, startIndex);
}

/**
 * Answers a /Items listing that is about Live TV: the Live TV library's own
 * children, or a request for channels or programmes by type.
 */
export async function answerLiveTvListing(req: any, res: any, config: any): Promise<boolean> {
  const types = list(req, 'IncludeItemTypes');
  const parent = field(req, 'ParentId');
  const inLibrary = parent ? (await decodeJellyfinId(parent))?.k === 'livetv' : false;
  const byType = types.length > 0 && types.every((t) => t === 'TvChannel' || t === 'Program');
  if (!inLibrary && !byType) return false;

  res.json(types.includes('Program') ? await programmesResponse(req, config) : await channelsResponse(req, config));
  return true;
}

/** A Live TV item opened by id: the library itself, a channel or one programme. */
export async function liveTvAsItem(req: any, config: any, descriptor: Descriptor): Promise<any | null> {
  const serverId = serverIdFor(req.params.userUUID);
  if (descriptor.k === 'livetv') return liveTvView(config, serverId);

  const source = await sourceFor(config);
  if (!source) return null;

  if (descriptor.k === 'channel') {
    const channel = await channelById(source, descriptor.t, descriptor.i);
    if (!channel) return null;
    const [item] = await channelListItems(source, [{ channel, number: numberOf(source.base, channel) }], serverId, true);
    return item;
  }

  if (descriptor.k === 'program') {
    const channel = await channelById(source, descriptor.t, descriptor.i);
    if (!channel) return null;
    const found = (await programmesFor(source, [channel], descriptor.at, descriptor.at + 1)).get(keyOf(channel));
    const programme = found?.programmes.find((p) => p.start === descriptor.at);
    return programme ? programItem(programme, channel, numberOf(source.base, channel), catchupDaysOf(found?.meta, channel), serverId, Date.now()) : null;
  }
  return null;
}

/** A channel's logo as its stream addon lists it, for an image asked for after the list was let go. */
export async function channelLogo(config: any, type: string, id: string): Promise<string | undefined> {
  const source = await sourceFor(config);
  if (!source) return undefined;
  return (await channelById(source, type, id))?.logo;
}

/** The channel groups the Live TV library offers as genres. */
export async function liveGroups(config: any): Promise<string[]> {
  const source = await sourceFor(config);
  return source ? groupsOf(source) : [];
}

// --- Routes ---

export function registerLiveTvRoutes(router: any): void {
  const guarded = (handler: (req: any, res: any, config: any) => Promise<void>) => async (req: any, res: any) => {
    try {
      await handler(req, res, await loadConfig(req));
    } catch (error: any) {
      logger.warn(`${req.path} failed: ${error?.message || error}`);
      res.status(500).json({ Message: 'Live TV request failed' });
    }
  };

  router.get('/LiveTv/Info', guarded(async (req, res, config) => {
    const source = config ? await sourceFor(config) : null;
    const profile = req.jellyfin?.userId ?? req.params.userId;
    res.json({
      Services: source ? [{ Name: 'AIOStreams', Status: 'Ok', IsVisible: true, HasUpdateAvailable: false, Tuners: [] }] : [],
      IsEnabled: source !== null,
      EnabledUsers: source && profile ? [String(profile)] : [],
    });
  }));

  router.get('/LiveTv/GuideInfo', guarded(async (_req, res, config) => {
    const source = config ? await sourceFor(config) : null;
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    res.json({
      StartDate: new Date(today - guideDaysBack(source) * DAY_MS).toISOString(),
      EndDate: new Date(today + GUIDE_DAYS * DAY_MS).toISOString(),
    });
  }));

  router.get('/LiveTv/Channels', guarded(async (req, res, config) => {
    res.json(config ? await channelsResponse(req, config) : itemList([], 0, 0));
  }));

  router.get('/LiveTv/Channels/:channelId', guarded(async (req, res, config) => {
    const descriptor = await decodeJellyfinId(String(req.params.channelId));
    const item = config && descriptor?.k === 'channel' ? await liveTvAsItem(req, config, descriptor) : null;
    if (item) res.json(item);
    else res.status(404).json({ Message: 'Channel not found' });
  }));

  router.get('/LiveTv/Programs/Recommended', guarded(async (req, res, config) => {
    res.json(config ? await programmesResponse(req, config, true) : itemList([], 0, 0));
  }));

  router.all('/LiveTv/Programs', guarded(async (req, res, config) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).end();
      return;
    }
    res.json(config ? await programmesResponse(req, config) : itemList([], 0, 0));
  }));

  router.get('/LiveTv/Programs/:programId', guarded(async (req, res, config) => {
    const descriptor = await decodeJellyfinId(String(req.params.programId));
    const item = config && descriptor?.k === 'program' ? await liveTvAsItem(req, config, descriptor) : null;
    if (item) res.json(item);
    else res.status(404).json({ Message: 'Program not found' });
  }));
}
