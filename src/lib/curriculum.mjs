// Reads CURRICULUM.md at build time. Plain JS (with JSDoc types) so that both
// astro.config.mjs and the site's components can import it.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {'planned' | 'pilot' | 'published' | 'merged'} TopicStatus
 *
 * @typedef {object} CurriculumTopic
 * @property {number} order      position within the track
 * @property {string} title
 * @property {string} slug
 * @property {string} post       item number(s) from the original list, or "new"
 * @property {TopicStatus} status
 * @property {string} statusText the raw status cell, e.g. "published (2026-10-17)"
 * @property {string} track      folder name of the track
 *
 * @typedef {object} CurriculumTrack
 * @property {number} order
 * @property {string} title
 * @property {string} folder
 * @property {string} [intro]    paragraph under the track heading, if any
 * @property {CurriculumTopic[]} topics
 *
 * @typedef {object} Curriculum
 * @property {CurriculumTrack[]} tracks
 * @property {string[]} starterPath  slugs, in reading order
 */

/** The project root. Builds and the dev server both run from it (Netlify included). */
const ROOT = process.cwd();
const CURRICULUM_PATH = path.join(ROOT, 'CURRICULUM.md');
export const DOCS_DIR = path.join(ROOT, 'src', 'content', 'docs');

const TRACK_HEADING = /^##\s+(\d+)\.\s+(.+?)\s+—\s+`([a-z0-9-]+)`\s*$/;
const TOPIC_ROW = /^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*([a-z0-9-]+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/;

/** @param {string} text @returns {TopicStatus} */
function parseStatus(text) {
  const s = text.trim().toLowerCase();
  if (s.startsWith('published')) return 'published';
  if (s.startsWith('pilot')) return 'pilot';
  if (s.startsWith('merged')) return 'merged';
  return 'planned';
}

/** @param {string} markdown @returns {Curriculum} */
export function parseCurriculum(markdown) {
  const lines = markdown.split(/\r?\n/);
  /** @type {CurriculumTrack[]} */
  const tracks = [];
  /** @type {string[]} */
  let starterPath = [];
  /** @type {CurriculumTrack | null} */
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^##\s+Suggested starter path/i.test(line)) {
      // The path is the first paragraph after the heading: slugs joined by arrows.
      let text = '';
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      while (j < lines.length && lines[j].trim() !== '') text += ' ' + lines[j++];
      starterPath = text.split('→').map((s) => s.trim()).filter(Boolean);
      current = null;
      continue;
    }

    const heading = line.match(TRACK_HEADING);
    if (heading) {
      current = { order: Number(heading[1]), title: heading[2], folder: heading[3], topics: [] };
      tracks.push(current);
      continue;
    }
    if (/^##\s/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;

    const row = line.match(TOPIC_ROW);
    if (row) {
      current.topics.push({
        order: Number(row[1]),
        title: row[2],
        slug: row[3],
        post: row[4],
        status: parseStatus(row[5]),
        statusText: row[5],
        track: current.folder,
      });
    } else if (current.topics.length === 0 && line.trim() && !line.startsWith('|')) {
      current.intro = current.intro ? `${current.intro} ${line.trim()}` : line.trim();
    }
  }

  return { tracks, starterPath };
}

/** @type {Curriculum | undefined} */
let cached;

/** @returns {Curriculum} */
export function getCurriculum() {
  if (!cached || process.env.NODE_ENV !== 'production') {
    cached = parseCurriculum(fs.readFileSync(CURRICULUM_PATH, 'utf8'));
  }
  return cached;
}

/** True when a track folder holds at least one page. Used to hide empty sidebar groups. */
export function trackHasPages(/** @type {string} */ folder) {
  const dir = path.join(DOCS_DIR, folder);
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => /\.mdx?$/.test(f));
}
