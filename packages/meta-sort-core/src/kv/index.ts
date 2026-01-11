/**
 * KV Module - Unified key-value storage with leader election
 *
 * This module provides:
 * - IKVClient interface for KV storage abstraction
 * - RedisKVClient for Redis-based storage
 * - LeaderElection for distributed leader election via flock
 * - ServiceDiscovery for service registration and discovery
 * - KVManager for unified management of all components
 * - MetadataUtils for flattening/reconstructing nested metadata
 */

export * from './IKVClient.js';
export * from './RedisClient.js';
export * from './LeaderElection.js';
export * from './ServiceDiscovery.js';
export * from './KVManager.js';
export * from './MetadataUtils.js';
