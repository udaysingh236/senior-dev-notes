import { getCollection, type CollectionEntry } from 'astro:content';
import { getCurriculum, type CurriculumTopic, type CurriculumTrack } from './curriculum.mjs';

export type DocEntry = CollectionEntry<'docs'>;

export interface ResolvedTopic {
  slug: string;
  title: string;
  track: string;
  trackTitle: string;
  /** Page URL when the page exists on disk; undefined for topics that are not written yet. */
  href?: string;
  published: boolean;
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  tagline?: string;
}

/** Drafts are visible in `npm run dev` only, matching Starlight's own behaviour. */
const showDrafts = import.meta.env.DEV;

let pagesPromise: Promise<Map<string, DocEntry>> | undefined;

/** Every docs page, keyed by id (`<track>/<slug>`). Cached for the build, fresh in dev. */
export function getPages(): Promise<Map<string, DocEntry>> {
  if (!pagesPromise || import.meta.env.DEV) {
    pagesPromise = getCollection('docs', (e) => showDrafts || !e.data.draft).then(
      (entries) => new Map(entries.map((e) => [e.id, e])),
    );
  }
  return pagesPromise;
}

/** URL of a docs entry. The site lives at the domain root, so there is no base path. */
export function pageHref(entry: DocEntry): string {
  return entry.id === 'index' ? '/' : `/${entry.id}/`;
}

/** Finds the topic page for a slug, whether or not the slug is in CURRICULUM.md. */
function findPage(pages: Map<string, DocEntry>, slug: string, track?: string): DocEntry | undefined {
  if (track) return pages.get(`${track}/${slug}`);
  for (const [id, entry] of pages) {
    if (entry.data.track && id === `${entry.data.track}/${slug}`) return entry;
  }
  return undefined;
}

export function getTrack(folder: string): CurriculumTrack | undefined {
  return getCurriculum().tracks.find((t) => t.folder === folder);
}

export function findCurriculumTopic(slug: string): CurriculumTopic | undefined {
  for (const track of getCurriculum().tracks) {
    const topic = track.topics.find((t) => t.slug === slug);
    if (topic) return topic;
  }
  return undefined;
}

/**
 * Resolves a topic slug to its title and URL. Unwritten topics come back without an href so
 * callers can show "coming soon" instead of a broken link. An unknown slug fails the build,
 * because it is almost always a typo.
 */
export async function resolveTopic(slug: string, usedOn?: string): Promise<ResolvedTopic> {
  const pages = await getPages();
  const topic = findCurriculumTopic(slug);
  const page = findPage(pages, slug, topic?.track);

  if (!topic && !page) {
    throw new Error(
      `Unknown topic slug "${slug}"${usedOn ? ` used on ${usedOn}` : ''}. ` +
        'Add it to CURRICULUM.md or fix the spelling.',
    );
  }

  const track = topic?.track ?? page!.id.split('/')[0];
  return {
    slug,
    title: page?.data.title ?? topic!.title,
    track,
    trackTitle: getTrack(track)?.title ?? track,
    href: page ? pageHref(page) : undefined,
    published: Boolean(page),
    difficulty: page?.data.difficulty,
    tagline: page?.data.tagline,
  };
}

export interface TrackSummary {
  track: CurriculumTrack;
  topics: ResolvedTopic[];
  publishedCount: number;
  plannedCount: number;
}

/** Every track with its topics resolved, in CURRICULUM.md order. */
export async function getTrackSummaries(): Promise<TrackSummary[]> {
  const { tracks } = getCurriculum();
  return Promise.all(
    tracks.map(async (track) => {
      const topics = await Promise.all(
        track.topics.filter((t) => t.status !== 'merged').map((t) => resolveTopic(t.slug)),
      );
      const publishedCount = topics.filter((t) => t.published).length;
      return { track, topics, publishedCount, plannedCount: topics.length - publishedCount };
    }),
  );
}

/** Estimated reading time in minutes for an MDX body, ignoring code, imports and markup. */
export function readingMinutes(body: string | undefined): number {
  if (!body) return 1;
  const prose = body
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ') // MDX comments
    .replace(/^\s*(import|export)\s.*$/gm, ' ') // ESM lines
    .replace(/<[^>]+>/g, ' ') // JSX and HTML tags
    .replace(/[#>*_`|[\]()-]/g, ' ');
  const words = prose.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const codeLines = (body.match(/```[\s\S]*?```/g) ?? []).reduce(
    (n, block) => n + block.split('\n').length - 2,
    0,
  );
  // About 220 words a minute for technical prose, and about 20 lines of code a minute.
  return Math.max(1, Math.round(words / 220 + codeLines / 20));
}
