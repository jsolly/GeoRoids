import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { wikiContentLoader } from './wiki/contentLoader';

export const collections = {
  wiki: defineCollection({
    loader: wikiContentLoader(),
    schema: z.object({
      id: z.string(),
      title: z.string(),
      category: z.string(),
      summary: z.string(),
      order: z.number(),
      html: z.string(),
      searchText: z.string(),
      sections: z.array(z.object({ heading: z.string(), paragraphs: z.array(z.string()) })),
      related: z.array(z.string()),
      sources: z.array(z.string()),
      media: z.array(z.string()),
    }),
  }),
};
