// API Response Types
export interface FileMetadata {
  // File info
  fileName?: string;
  extension?: string;
  byteSize?: number;
  mimeType?: string;
  fileType?: string;

  // Filename parsing
  title?: string;
  titles?: string[];
  originaltitle?: string;
  showtitle?: string;
  season?: number;
  episode?: number;
  movieYear?: number;
  videoType?: string;

  // General media metadata
  year?: number;
  imdbid?: string;
  tmdbid?: string;
  anidbid?: string;
  premiered?: string;
  genre?: string[];
  releasedate?: string;
  plot?: string;
  director?: string;
  rating?: number;
  runtime?: number;
  studio?: string;
  art?: any;
  actor?: any[];
  aired?: string;
  customrating?: string;
  dateadded?: string;
  sorttitle?: string;
  mpaa?: string;
  aspectratio?: string;
  collectionnumber?: number;
  criticrating?: number;

  // Sibling CIDs are the bare-CID key-set `cids/<cid> = "true"` (dynamic
  // keys), not per-algorithm fields. Accessed via prefix-scan; the algorithm
  // is recovered from each CID's multicodec. See METADATA_KEYS.md §2/§14.13.
  [cidsKey: `cids/${string}`]: string | undefined;

  // Video info
  video?: {
    codec?: string;
    width?: number;
    height?: number;
    bitrate?: number;
    fps?: number;
  };

  // Audio info
  audio?: Array<{
    codec?: string;
    channels?: number;
    language?: string;
    bitrate?: number;
  }>;

  // Subtitles
  subtitles?: Array<{
    language?: string;
    codec?: string;
  }>;

  // Other
  extra?: any;
  anime?: any;
  fileinfo?: any;
  trackers?: string[];

  // Allow any additional properties
  [key: string]: any;
}

export interface SearchResult {
  hashId: string;
  metadata: FileMetadata;
  score?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  count: number;
  total?: number;
}

export interface UpdateResult {
  status: string;
  hashId: string;
  message?: string;
  error?: string;
}

export interface BatchUpdateResponse {
  status: string;
  total: number;
  success: number;
  errors: number;
  results: Array<{
    hashId: string;
    status: string;
    error?: string;
  }>;
}

// Plugin Schema Types
export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'text' | 'array' | 'json' | 'cid' | 'languageString';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SchemaField {
  label: string;
  type?: SchemaFieldType;
  readonly?: boolean;
  indexed?: boolean;
  options?: SelectOption[];
  hint?: string;
  link?: string;
  pattern?: string;
  min?: number;
  max?: number;
  placeholder?: string;
}

export interface PluginSchema {
  id: string;
  name: string;
  version: string;
  description?: string;
  priority?: number;
  color?: string;
  dependencies: string[];
  active: boolean;
  metadataSchema?: Record<string, SchemaField>;
}

export interface PluginsResponse {
  plugins: PluginSchema[];
  executionOrder: string[];
  activeCount: number;
  totalCount: number;
}
