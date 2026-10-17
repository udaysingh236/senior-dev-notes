import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// Topic-page fields on top of Starlight's own frontmatter. They are optional so that
// non-topic pages (home, roadmap, about) validate too; TopicHeader checks topic pages.
const topicFields = z.object({
  /** One line under the title: the problem this page solves. */
  tagline: z.string().optional(),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  /** Track folder from CURRICULUM.md. Must match the folder the page lives in. */
  track: z.string().optional(),
  /** Slugs of topics to read first. Planned topics are fine. */
  prerequisites: z.array(z.string()).default([]),
  /**
   * Slugs of topics to read after this one. This replaces Starlight's `next` pagination
   * field; Starlight only reads `.link` and `.label` from it, so an array leaves the
   * default "Next" link in the footer untouched.
   */
  next: z.array(z.string()).optional(),
  /** Date a human last reviewed the page for accuracy. */
  lastReviewed: z.coerce.date().optional(),
});

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema({ extend: topicFields }) }),
};
