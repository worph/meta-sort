/**
 * KV Module - Unified key-value storage with leader client
 *
 * This module provides:
 * - IKVClient interface for KV storage abstraction
 * - RedisKVClient for Redis-based storage
 * - LeaderClient for reading leader info from meta-core
 * - ServiceRegistration for service registration (discovery is centralized in meta-core)
 * - KVManager for unified management of all components
 * - MetadataUtils for flattening/reconstructing nested metadata
 */

export * from './IKVClient.js';
export * from './RedisClient.js';
export * from './LeaderClient.js';
export * from './ServiceRegistration.js';
export * from './KVManager.js';
export * from './MetadataUtils.js';
