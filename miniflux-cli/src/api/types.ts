/**
 * Types for the Miniflux v2 API.
 *
 * Only fields the CLI cares about are modelled; the server may return more.
 */

export const ENTRY_STATUSES = ["read", "unread", "removed"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const ENTRY_ORDER_FIELDS = [
  "id",
  "status",
  "published_at",
  "category_title",
  "category_id",
  "author",
  "title",
] as const;
export type EntryOrderField = (typeof ENTRY_ORDER_FIELDS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export interface MinifluxUser {
  id: number;
  username: string;
  is_admin: boolean;
  theme: string;
  language: string;
  timezone: string;
}

export interface MinifluxCategory {
  id: number;
  user_id: number;
  title: string;
}

export interface FeedIcon {
  feed_id: number;
  icon_id: number;
  mime_type: string;
  data: string;
}

export interface MinifluxFeed {
  id: number;
  user_id: number;
  feed_url: string;
  site_url: string;
  title: string;
  checked_at?: string;
  next_check_at?: string;
  parsing_error_count?: number;
  parsing_error_message?: string;
  disabled?: boolean;
  category?: MinifluxCategory;
}

export interface MinifluxEntry {
  id: number;
  user_id: number;
  feed_id: number;
  title: string;
  url: string;
  comments_url?: string;
  published_at: string;
  created_at: string;
  content: string;
  author?: string;
  reading_time: number;
  status: EntryStatus;
  starred: boolean;
  feed?: MinifluxFeed;
  tags?: string[];
}

export interface EntryListResponse {
  total: number;
  entries: MinifluxEntry[];
}

export interface DiscoverResult {
  url: string;
  title: string;
  type: string;
}

/** Query filters accepted by the entry listing endpoints. */
export interface EntryFilters {
  status?: EntryStatus;
  offset?: number;
  limit?: number;
  order?: EntryOrderField;
  direction?: SortDirection;
  before?: number;
  after?: number;
  beforeEntryId?: number;
  afterEntryId?: number;
  starred?: boolean;
}

/** Mutable fields of a feed (used by update-feed). */
export interface UpdateFeedFields {
  title?: string;
  categoryId?: number;
  feedUrl?: string;
  siteUrl?: string;
  userAgent?: string;
}
