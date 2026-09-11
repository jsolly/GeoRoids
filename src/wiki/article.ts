/** Compiled at build time from the CMS collection and authoritative game values. */
export interface WikiArticle {
  id: string;
  title: string;
  category: string;
  summary: string;
  order: number;
  html: string;
  searchText: string;
  sections: { heading: string; paragraphs: string[] }[];
  related: string[];
  sources: string[];
  media: string[];
}
