/**
 * KV Module - Unified key-value storage with leader client
 *
 * This module provides:
 * - IKVClient interface for KV storage abstraction
 * - RedisKVClient for Redis-based storage
 * - LeaderClient for reading leader info from meta-core
 * Services announce and discover over UDP (meta-discovery v1); there is no
 * separate registration step, so no ServiceRegistration export.
 * - KVManager for unified management of all components
 * - MetadataUtils for flattening/reconstructing nested metadata
 */

export * from './IKVClient.js';
export * from './RedisClient.js';
export * from './LeaderClient.js';
export * from './KVManager.js';
export * from './MetadataUtils.js';
