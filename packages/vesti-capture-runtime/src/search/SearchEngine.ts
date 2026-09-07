/**
 * Search Engine
 * FTS5 full-text search across conversations and messages
 */

import type { DatabaseManager } from '../storage/DatabaseManager.js';
import type { SearchResult, SearchQuery } from '../types/index.js';

export class SearchEngine {
  constructor(private db: DatabaseManager) {}

  search(query: SearchQuery): SearchResult[] {
    const results: SearchResult[] = [];

    // Search conversations
    const convResults = this.db.searchConversations(query.text, query.limit || 10);
    results.push(...convResults);

    // Search messages
    const msgResults = this.db.searchMessages(query.text, query.limit || 20);
    results.push(...msgResults);

    // Sort by score descending, then by timestamp descending
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

    // Apply limit
    const limit = query.limit || 20;
    return results.slice(0, limit);
  }
}
