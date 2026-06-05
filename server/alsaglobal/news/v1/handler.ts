import type { NewsServiceHandler } from '../../../../src/generated/server/alsaglobal/news/v1/service_server';

import { summarizeArticle } from './summarize-article';
import { getSummarizeArticleCache } from './get-summarize-article-cache';
import { listFeedDigest } from './list-feed-digest';

export const newsHandler: NewsServiceHandler = {
  summarizeArticle,
  getSummarizeArticleCache,
  listFeedDigest,
};
