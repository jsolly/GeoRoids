import type { WikiArticle } from './content';

/** Match every query word, including words in rule details and linked topics. */
export function searchArticles(articles: WikiArticle[], query: string): WikiArticle[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return articles;
  }
  return articles
    .map((article) => {
      const title = `${article.title} ${article.category}`.toLocaleLowerCase();
      const body = [
        article.summary,
        ...article.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
      ]
        .join(' ')
        .toLocaleLowerCase();
      return {
        article,
        matches: terms.every((term) => `${title} ${body}`.includes(term)),
        rank: terms.reduce((score, term) => score + (title.includes(term) ? 1 : 0), 0),
      };
    })
    .filter((result) => result.matches)
    .sort((a, b) => b.rank - a.rank)
    .map((result) => result.article);
}
