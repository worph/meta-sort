import { useState, useEffect, useCallback } from 'react';
import {
    PluginsResponse,
    PluginTiming,
    PluginTimingsResponse
} from '../types';
import { formatMs, formatNumber } from '../utils/format';

function Plugins() {
    const [pluginsData, setPluginsData] = useState<PluginsResponse | null>(null);
    const [timings, setTimings] = useState<PluginTiming[]>([]);
    const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null);
    const [configEditing, setConfigEditing] = useState<Record<string, unknown> | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [scanStatus, setScanStatus] = useState<string | null>(null);

    const fetchPlugins = useCallback(async () => {
        try {
            const res = await fetch('/api/plugins');
            if (res.ok) {
                const data = await res.json();
                setPluginsData(data);
                setError(null);
            } else if (res.status === 503) {
                setError('Plugin manager not yet initialized. Process a file to initialize plugins.');
            }
        } catch (err) {
            console.error('Failed to fetch plugins:', err);
            setError('Failed to fetch plugins');
        }
    }, []);

    const fetchTimings = useCallback(async () => {
        try {
            const res = await fetch('/api/plugins/timings');
            if (res.ok) {
                const data: PluginTimingsResponse = await res.json();
                setTimings(data.timings || []);
            }
        } catch (err) {
            console.error('Failed to fetch plugin timings:', err);
        }
    }, []);

    useEffect(() => {
        fetchPlugins();
        fetchTimings();

        const interval = setInterval(() => {
            fetchPlugins();
            fetchTimings();
        }, 5000);

        return () => clearInterval(interval);
    }, [fetchPlugins, fetchTimings]);

    const togglePlugin = async (pluginId: string, active: boolean) => {
        setLoading(true);
        try {
            const endpoint = active
                ? `/api/plugins/${pluginId}/deactivate`
                : `/api/plugins/${pluginId}/activate`;
            const res = await fetch(endpoint, { method: 'POST' });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.details || data.error || 'Failed to toggle plugin');
            }
            await fetchPlugins();
        } catch (err: any) {
            alert(err.message);
        } finally {
            setLoading(false);
        }
    };

    const updateConfig = async (pluginId: string, config: Record<string, unknown>) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/plugins/${pluginId}/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.details || 'Failed to update config');
            }
            await fetchPlugins();
            setConfigEditing(null);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setLoading(false);
        }
    };

    const triggerScan = async () => {
        setScanStatus('Scanning...');
        try {
            await fetch('/api/scan/trigger', { method: 'POST' });
            setScanStatus('Scan triggered');
            setTimeout(() => setScanStatus(null), 3000);
        } catch (err) {
            console.error('Failed to trigger scan:', err);
            setScanStatus('Scan failed');
        }
    };

    const rescanPlugins = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/plugins/rescan', { method: 'POST' });
            if (res.ok) {
                await fetchPlugins();
            }
        } catch (err) {
            console.error('Failed to rescan plugins:', err);
        } finally {
            setLoading(false);
        }
    };

    const clearCache = async (pluginId: string) => {
        setLoading(true);
        try {
            await fetch(`/api/plugins/${pluginId}/clear-cache`, { method: 'POST' });
        } catch (err) {
            console.error('Failed to clear cache:', err);
        } finally {
            setLoading(false);
        }
    };

    const [recomputeStatus, setRecomputeStatus] = useState<string | null>(null);

    const triggerRecompute = async (pluginId: string) => {
        if (!confirm(`This will re-run the ${pluginId} plugin on all files. Continue?`)) {
            return;
        }

        setLoading(true);
        setRecomputeStatus('Queuing...');
        try {
            const res = await fetch(`/api/plugins/${pluginId}/recompute`, { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                setRecomputeStatus(`Queued ${data.filesQueued} files`);
                setTimeout(() => setRecomputeStatus(null), 5000);
            } else {
                const data = await res.json();
                throw new Error(data.details || data.error || 'Failed to trigger recompute');
            }
        } catch (err: any) {
            setRecomputeStatus('Failed');
            alert(err.message);
            setTimeout(() => setRecomputeStatus(null), 3000);
        } finally {
            setLoading(false);
        }
    };

    const getTimingForPlugin = (pluginId: string): PluginTiming | undefined => {
        return timings.find(t => t.pluginId === pluginId);
    };

    const selectedPluginData = pluginsData?.plugins.find(p => p.id === selectedPlugin);

    // Group plugins by queue assignment
    const getQueueAssignment = () => {
        if (!pluginsData) return { metadata: [], hashing: [] };

        const metadata: Array<{ plugin: typeof pluginsData.plugins[0]; timing?: PluginTiming }> = [];
        const hashing: Array<{ plugin: typeof pluginsData.plugins[0]; timing?: PluginTiming }> = [];

        pluginsData.plugins.forEach(plugin => {
            if (!plugin.active) return;

            const timing = getTimingForPlugin(plugin.id);
            const avgTime = timing?.avgTime || 0;

            // Determine queue based on:
            // 1. Plugin's defaultQueue from manifest
            // 2. Or inferred from average execution time (>= 1000ms = background/hashing)
            const isBackground = plugin.defaultQueue === 'background' ||
                (!plugin.defaultQueue && avgTime >= 1000);

            if (isBackground) {
                hashing.push({ plugin, timing });
            } else {
                metadata.push({ plugin, timing });
            }
        });

        return { metadata, hashing };
    };

    const queueAssignment = getQueueAssignment();

    return (
        <div className="plugins-page">
            <div className="plugins-header">
                <h1>Plugins</h1>
                <div className="header-actions">
                    <button
                        className="btn btn-secondary"
                        onClick={rescanPlugins}
                        disabled={loading}
                    >
                        Rescan Plugins
                    </button>
                    <button
                        className="btn btn-primary"
                        onClick={triggerScan}
                        disabled={loading}
                    >
                        {scanStatus || 'Trigger File Scan'}
                    </button>
                </div>
            </div>

            {error && (
                <div className="error-banner">
                    {error}
                </div>
            )}

            <div className="plugins-layout">
                {/* Plugin List */}
                <div className="card plugin-list-card">
                    <h2>
                        Loaded Plugins
                        {pluginsData && (
                            <span className="plugin-count">
                                {pluginsData.activeCount}/{pluginsData.totalCount} active
                            </span>
                        )}
                    </h2>

                    {pluginsData?.plugins.length === 0 ? (
                        <div className="empty-state">No plugins found</div>
                    ) : (
                        <div className="plugin-list">
                            {pluginsData?.plugins.map((plugin) => {
                                const timing = getTimingForPlugin(plugin.id);
                                const isSelected = selectedPlugin === plugin.id;

                                return (
                                    <div
                                        key={plugin.id}
                                        className={`plugin-item ${isSelected ? 'selected' : ''} ${plugin.status === 'error' ? 'error' : ''}`}
                                        onClick={() => setSelectedPlugin(plugin.id)}
                                    >
                                        <div className="plugin-header">
                                            <div className="plugin-info">
                                                <span className="plugin-name">{plugin.name}</span>
                                                <span className="plugin-version">v{plugin.version}</span>
                                            </div>
                                            <label className="toggle" onClick={(e) => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    checked={plugin.active}
                                                    onChange={() => togglePlugin(plugin.id, plugin.active)}
                                                    disabled={loading || plugin.status === 'error'}
                                                />
                                                <span className="slider"></span>
                                            </label>
                                        </div>

                                        {plugin.description && (
                                            <div className="plugin-description">{plugin.description}</div>
                                        )}

                                        {plugin.status === 'error' && (
                                            <div className="plugin-error">{plugin.error}</div>
                                        )}

                                        {timing && timing.totalCalls > 0 && (
                                            <div className="plugin-timing">
                                                <span>{formatNumber(timing.totalCalls)} calls</span>
                                                <span>avg: {formatMs(timing.avgTime)}</span>
                                            </div>
                                        )}

                                        {plugin.dependencies.length > 0 && (
                                            <div className="plugin-deps">
                                                Depends: {plugin.dependencies.join(', ')}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {pluginsData && pluginsData.executionOrder.length > 0 && (
                        <div className="execution-order">
                            <h3>Execution Order</h3>
                            <div className="order-list">
                                {pluginsData.executionOrder.map((id, idx) => (
                                    <span key={id} className="order-item">
                                        {idx + 1}. {id}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Plugin Details */}
                <div className="card plugin-details-card">
                    {selectedPluginData ? (
                        <>
                            <div className="details-header">
                                <h2>{selectedPluginData.name}</h2>
                                <span className={`status-badge status-${selectedPluginData.active ? 'success' : 'secondary'}`}>
                                    {selectedPluginData.active ? 'Active' : 'Inactive'}
                                </span>
                            </div>

                            <div className="details-section">
                                <h3>Info</h3>
                                <div className="info-grid">
                                    <div className="info-item">
                                        <span className="info-label">ID</span>
                                        <span className="info-value">{selectedPluginData.id}</span>
                                    </div>
                                    <div className="info-item">
                                        <span className="info-label">Version</span>
                                        <span className="info-value">{selectedPluginData.version}</span>
                                    </div>
                                    <div className="info-item">
                                        <span className="info-label">Status</span>
                                        <span className="info-value">{selectedPluginData.status}</span>
                                    </div>
                                </div>
                                {selectedPluginData.description && (
                                    <p className="description-text">{selectedPluginData.description}</p>
                                )}
                            </div>

                            {/* Timing Stats */}
                            {(() => {
                                const timing = getTimingForPlugin(selectedPluginData.id);
                                if (!timing || timing.totalCalls === 0) return null;
                                return (
                                    <div className="details-section">
                                        <h3>Performance</h3>
                                        <div className="timing-grid">
                                            <div className="timing-stat">
                                                <div className="timing-value">{formatNumber(timing.totalCalls)}</div>
                                                <div className="timing-label">Total Calls</div>
                                            </div>
                                            <div className="timing-stat">
                                                <div className="timing-value">{formatMs(timing.avgTime)}</div>
                                                <div className="timing-label">Avg Time</div>
                                            </div>
                                            <div className="timing-stat">
                                                <div className="timing-value">{formatMs(timing.minTime)}</div>
                                                <div className="timing-label">Min Time</div>
                                            </div>
                                            <div className="timing-stat">
                                                <div className="timing-value">{formatMs(timing.maxTime)}</div>
                                                <div className="timing-label">Max Time</div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* Configuration */}
                            {selectedPluginData.configSchema && Object.keys(selectedPluginData.configSchema).length > 0 && (
                                <div className="details-section">
                                    <div className="section-header">
                                        <h3>Configuration</h3>
                                        {!configEditing ? (
                                            <button
                                                className="btn btn-small btn-secondary"
                                                onClick={() => setConfigEditing({ ...selectedPluginData.config })}
                                            >
                                                Edit
                                            </button>
                                        ) : (
                                            <div className="config-actions">
                                                <button
                                                    className="btn btn-small btn-primary"
                                                    onClick={() => updateConfig(selectedPluginData.id, configEditing)}
                                                    disabled={loading}
                                                >
                                                    Save
                                                </button>
                                                <button
                                                    className="btn btn-small btn-secondary"
                                                    onClick={() => setConfigEditing(null)}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <div className="config-grid">
                                        {Object.entries(selectedPluginData.configSchema).map(([key, schema]) => {
                                            const value = configEditing
                                                ? configEditing[key]
                                                : selectedPluginData.config[key];

                                            return (
                                                <div key={key} className="config-item">
                                                    <label className="config-label">
                                                        {key}
                                                        {schema.required && <span className="required">*</span>}
                                                    </label>
                                                    {schema.description && (
                                                        <span className="config-description">{schema.description}</span>
                                                    )}
                                                    {configEditing ? (
                                                        schema.type === 'boolean' ? (
                                                            <label className="toggle small">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={Boolean(value)}
                                                                    onChange={(e) => setConfigEditing({
                                                                        ...configEditing,
                                                                        [key]: e.target.checked
                                                                    })}
                                                                />
                                                                <span className="slider"></span>
                                                            </label>
                                                        ) : schema.type === 'number' ? (
                                                            <input
                                                                type="number"
                                                                className="config-input"
                                                                value={value as number || ''}
                                                                onChange={(e) => setConfigEditing({
                                                                    ...configEditing,
                                                                    [key]: e.target.value ? Number(e.target.value) : undefined
                                                                })}
                                                            />
                                                        ) : (
                                                            <input
                                                                type="text"
                                                                className="config-input"
                                                                value={String(value || '')}
                                                                onChange={(e) => setConfigEditing({
                                                                    ...configEditing,
                                                                    [key]: e.target.value || undefined
                                                                })}
                                                                placeholder={schema.default !== undefined ? String(schema.default) : ''}
                                                            />
                                                        )
                                                    ) : (
                                                        <span className="config-value">
                                                            {value !== undefined ? String(value) : <em>not set</em>}
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Metadata Schema */}
                            {selectedPluginData.metadataSchema && Object.keys(selectedPluginData.metadataSchema).length > 0 && (
                                <div className="details-section">
                                    <h3>Metadata Schema</h3>
                                    <p className="section-description">Fields this plugin can set on files</p>
                                    <div className="schema-grid">
                                        {Object.entries(selectedPluginData.metadataSchema).map(([key, field]) => (
                                            <div key={key} className="schema-item">
                                                <span className="schema-key">{key}</span>
                                                <span className="schema-type">{field.type}</span>
                                                {field.description && (
                                                    <span className="schema-description">{field.description}</span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Actions */}
                            <div className="details-section">
                                <h3>Actions</h3>
                                <div className="action-buttons">
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => clearCache(selectedPluginData.id)}
                                        disabled={loading}
                                    >
                                        Clear Cache
                                    </button>
                                    <button
                                        className="btn btn-primary"
                                        onClick={() => triggerRecompute(selectedPluginData.id)}
                                        disabled={loading || !selectedPluginData.active}
                                        title={!selectedPluginData.active ? 'Plugin must be active to recompute' : 'Re-run this plugin on all files'}
                                    >
                                        {recomputeStatus || 'Recompute All Files'}
                                    </button>
                                </div>
                                <p className="action-hint">
                                    Recompute will re-run this plugin on all files, bypassing cache checks.
                                </p>
                            </div>
                        </>
                    ) : (
                        <div className="empty-state">
                            Select a plugin to view details
                        </div>
                    )}
                </div>
            </div>

            {/* Performance Overview */}
            {timings.length > 0 && (
                <div className="card performance-overview-card">
                    <h2>Plugin Performance Overview</h2>
                    <p className="card-description">Processing time for each metadata extraction plugin during light processing phase</p>
                    <div className="performance-grid">
                        {timings
                            .filter(t => t.totalCalls > 0)
                            .sort((a, b) => b.avgTime - a.avgTime)
                            .map((timing) => {
                                const plugin = pluginsData?.plugins.find(p => p.id === timing.pluginId);
                                const isQuick = timing.avgTime < 1000;

                                return (
                                    <div
                                        key={timing.pluginId}
                                        className={`performance-card ${isQuick ? 'quick' : 'slow'}`}
                                        onClick={() => setSelectedPlugin(timing.pluginId)}
                                    >
                                        <h3>{plugin?.name || timing.pluginId}</h3>
                                        <div className="perf-value">{formatMs(timing.avgTime)}</div>
                                        <div className="perf-label">Average Time</div>
                                        <div className="perf-details">
                                            {formatNumber(timing.totalCalls)} runs |
                                            min: {formatMs(timing.minTime)} |
                                            max: {formatMs(timing.maxTime)}
                                        </div>
                                    </div>
                                );
                            })}
                    </div>
                </div>
            )}

            {/* Queue Assignment Section */}
            {pluginsData && pluginsData.activeCount > 0 && (
                <div className="card queue-assignment-card">
                    <h2>Pipeline Queue Assignment</h2>
                    <p className="card-description">
                        Active plugins are assigned to pipeline stages based on their execution characteristics.
                        Plugins with avg time &lt; 1s run in Metadata stage, others in Hashing stage.
                    </p>

                    <div className="queue-assignment-grid">
                        {/* Metadata Queue */}
                        <div className="queue-column metadata-queue">
                            <div className="queue-header">
                                <span className="queue-icon">📝</span>
                                <h3>Metadata Stage</h3>
                                <span className="queue-count">{queueAssignment.metadata.length} plugins</span>
                            </div>
                            <p className="queue-description">Fast plugins (&lt;1s avg) - runs during light processing</p>
                            <div className="queue-plugins">
                                {queueAssignment.metadata.length === 0 ? (
                                    <div className="no-plugins">No plugins assigned</div>
                                ) : (
                                    queueAssignment.metadata.map(({ plugin, timing }) => (
                                        <div
                                            key={plugin.id}
                                            className="queue-plugin-item"
                                            onClick={() => setSelectedPlugin(plugin.id)}
                                        >
                                            <span className="plugin-name">{plugin.name}</span>
                                            {timing && timing.totalCalls > 0 && (
                                                <span className="plugin-avg-time">
                                                    {formatMs(timing.avgTime)}
                                                </span>
                                            )}
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        {/* Arrow */}
                        <div className="queue-arrow">→</div>

                        {/* Hashing Queue */}
                        <div className="queue-column hashing-queue">
                            <div className="queue-header">
                                <span className="queue-icon">#</span>
                                <h3>Hashing Stage</h3>
                                <span className="queue-count">{queueAssignment.hashing.length} plugins</span>
                            </div>
                            <p className="queue-description">Slow plugins (≥1s avg) - runs during hash processing</p>
                            <div className="queue-plugins">
                                {queueAssignment.hashing.length === 0 ? (
                                    <div className="no-plugins">No plugins assigned</div>
                                ) : (
                                    queueAssignment.hashing.map(({ plugin, timing }) => (
                                        <div
                                            key={plugin.id}
                                            className="queue-plugin-item"
                                            onClick={() => setSelectedPlugin(plugin.id)}
                                        >
                                            <span className="plugin-name">{plugin.name}</span>
                                            {timing && timing.totalCalls > 0 && (
                                                <span className="plugin-avg-time slow">
                                                    {formatMs(timing.avgTime)}
                                                </span>
                                            )}
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
                .plugins-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }

                .plugins-header h1 {
                    font-size: 1.8rem;
                }

                .header-actions {
                    display: flex;
                    gap: 12px;
                }

                .error-banner {
                    background: rgba(255, 107, 107, 0.1);
                    border: 1px solid var(--error);
                    color: var(--error);
                    padding: 12px 16px;
                    border-radius: 8px;
                    margin-bottom: 20px;
                }

                .plugins-layout {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 20px;
                }

                @media (max-width: 1000px) {
                    .plugins-layout {
                        grid-template-columns: 1fr;
                    }
                }

                .plugin-list-card h2 {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .plugin-count {
                    font-size: 0.9rem;
                    font-weight: normal;
                    color: var(--text-secondary);
                }

                .plugin-list {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    max-height: 500px;
                    overflow-y: auto;
                }

                .plugin-item {
                    background: var(--bg-tertiary);
                    border-radius: 8px;
                    padding: 12px 16px;
                    cursor: pointer;
                    border: 2px solid transparent;
                    transition: all 0.2s;
                }

                .plugin-item:hover {
                    border-color: var(--border-color);
                }

                .plugin-item.selected {
                    border-color: var(--accent-primary);
                }

                .plugin-item.error {
                    border-left: 4px solid var(--error);
                }

                .plugin-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 4px;
                }

                .plugin-info {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .plugin-name {
                    font-weight: 600;
                }

                .plugin-version {
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }

                .plugin-description {
                    font-size: 0.85rem;
                    color: var(--text-secondary);
                    margin-bottom: 4px;
                }

                .plugin-error {
                    font-size: 0.8rem;
                    color: var(--error);
                    margin-top: 4px;
                }

                .plugin-timing {
                    display: flex;
                    gap: 12px;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                    margin-top: 4px;
                }

                .plugin-deps {
                    font-size: 0.75rem;
                    color: var(--text-secondary);
                    margin-top: 4px;
                    font-style: italic;
                }

                /* Toggle Switch */
                .toggle {
                    position: relative;
                    display: inline-block;
                    width: 40px;
                    height: 22px;
                }

                .toggle.small {
                    width: 32px;
                    height: 18px;
                }

                .toggle input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }

                .slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    transition: 0.3s;
                    border-radius: 22px;
                }

                .slider:before {
                    position: absolute;
                    content: "";
                    height: 16px;
                    width: 16px;
                    left: 2px;
                    bottom: 2px;
                    background-color: var(--text-secondary);
                    transition: 0.3s;
                    border-radius: 50%;
                }

                .toggle.small .slider:before {
                    height: 12px;
                    width: 12px;
                }

                input:checked + .slider {
                    background-color: var(--accent-primary);
                    border-color: var(--accent-primary);
                }

                input:checked + .slider:before {
                    transform: translateX(18px);
                    background-color: white;
                }

                .toggle.small input:checked + .slider:before {
                    transform: translateX(14px);
                }

                /* Execution Order */
                .execution-order {
                    margin-top: 20px;
                    padding-top: 16px;
                    border-top: 1px solid var(--border-color);
                }

                .execution-order h3 {
                    font-size: 0.9rem;
                    color: var(--text-secondary);
                    margin-bottom: 8px;
                }

                .order-list {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                }

                .order-item {
                    background: var(--bg-tertiary);
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }

                /* Details Panel */
                .plugin-details-card {
                    min-height: 400px;
                }

                .details-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }

                .details-header h2 {
                    margin: 0;
                }

                .details-section {
                    margin-bottom: 24px;
                }

                .details-section h3 {
                    font-size: 1rem;
                    color: var(--text-secondary);
                    margin-bottom: 12px;
                    border-bottom: 1px solid var(--border-color);
                    padding-bottom: 8px;
                }

                .section-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .section-header h3 {
                    margin-bottom: 0;
                    border: none;
                    padding-bottom: 0;
                }

                .config-actions {
                    display: flex;
                    gap: 8px;
                }

                .section-description {
                    font-size: 0.85rem;
                    color: var(--text-secondary);
                    margin-bottom: 12px;
                }

                .info-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 12px;
                    margin-bottom: 12px;
                }

                .info-item {
                    background: var(--bg-tertiary);
                    padding: 10px;
                    border-radius: 6px;
                }

                .info-label {
                    display: block;
                    font-size: 0.75rem;
                    color: var(--text-secondary);
                    margin-bottom: 4px;
                }

                .info-value {
                    font-weight: 600;
                }

                .description-text {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                /* Timing Grid */
                .timing-grid {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 12px;
                }

                .timing-stat {
                    background: var(--bg-tertiary);
                    padding: 12px;
                    border-radius: 6px;
                    text-align: center;
                }

                .timing-stat .timing-value {
                    font-size: 1.2rem;
                    font-weight: 700;
                    color: var(--accent-primary);
                }

                .timing-stat .timing-label {
                    font-size: 0.75rem;
                    color: var(--text-secondary);
                }

                /* Config Grid */
                .config-grid {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    margin-top: 12px;
                }

                .config-item {
                    background: var(--bg-tertiary);
                    padding: 12px;
                    border-radius: 6px;
                }

                .config-label {
                    display: block;
                    font-weight: 600;
                    margin-bottom: 4px;
                }

                .config-label .required {
                    color: var(--error);
                    margin-left: 4px;
                }

                .config-description {
                    display: block;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                    margin-bottom: 8px;
                }

                .config-value {
                    font-family: monospace;
                    color: var(--accent-primary);
                }

                .config-value em {
                    color: var(--text-secondary);
                    font-style: italic;
                }

                .config-input {
                    width: 100%;
                    padding: 8px 12px;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    color: var(--text-primary);
                    font-family: monospace;
                }

                .config-input:focus {
                    outline: none;
                    border-color: var(--accent-primary);
                }

                /* Schema Grid */
                .schema-grid {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .schema-item {
                    display: grid;
                    grid-template-columns: 150px 80px 1fr;
                    gap: 12px;
                    align-items: center;
                    background: var(--bg-tertiary);
                    padding: 8px 12px;
                    border-radius: 4px;
                    font-size: 0.85rem;
                }

                .schema-key {
                    font-family: monospace;
                    font-weight: 600;
                }

                .schema-type {
                    color: var(--accent-primary);
                    font-size: 0.75rem;
                    background: rgba(78, 205, 196, 0.1);
                    padding: 2px 6px;
                    border-radius: 4px;
                    text-align: center;
                }

                .schema-description {
                    color: var(--text-secondary);
                }

                /* Action Buttons */
                .action-buttons {
                    display: flex;
                    gap: 12px;
                    flex-wrap: wrap;
                }

                .action-hint {
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                    margin-top: 8px;
                    font-style: italic;
                }

                .btn-small {
                    padding: 6px 12px;
                    font-size: 0.85rem;
                }

                /* Empty State */
                .empty-state {
                    text-align: center;
                    color: var(--text-secondary);
                    padding: 40px;
                }

                /* Queue Assignment Section */
                .queue-assignment-card {
                    margin-top: 20px;
                }

                .queue-assignment-card h2 {
                    margin-bottom: 8px;
                }

                .queue-assignment-card .card-description {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    margin-bottom: 20px;
                }

                .queue-assignment-grid {
                    display: grid;
                    grid-template-columns: 1fr auto 1fr;
                    gap: 20px;
                    align-items: start;
                }

                @media (max-width: 800px) {
                    .queue-assignment-grid {
                        grid-template-columns: 1fr;
                    }
                    .queue-arrow {
                        transform: rotate(90deg);
                        justify-self: center;
                    }
                }

                .queue-column {
                    background: var(--bg-tertiary);
                    border-radius: 12px;
                    padding: 16px;
                }

                .metadata-queue {
                    border-left: 4px solid #fbbf24;
                }

                .hashing-queue {
                    border-left: 4px solid #a78bfa;
                }

                .queue-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 8px;
                }

                .queue-header h3 {
                    margin: 0;
                    font-size: 1.1rem;
                    flex: 1;
                }

                .queue-icon {
                    font-size: 1.2rem;
                }

                .queue-count {
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                    background: var(--bg-secondary);
                    padding: 2px 8px;
                    border-radius: 10px;
                }

                .queue-column > .queue-description {
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                    margin-bottom: 12px;
                }

                .queue-plugins {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }

                .queue-plugin-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background: var(--bg-secondary);
                    padding: 8px 12px;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .queue-plugin-item:hover {
                    background: var(--bg-primary);
                    transform: translateX(4px);
                }

                .queue-plugin-item .plugin-name {
                    font-weight: 500;
                }

                .plugin-avg-time {
                    font-size: 0.8rem;
                    color: #34d399;
                    background: rgba(52, 211, 153, 0.1);
                    padding: 2px 8px;
                    border-radius: 8px;
                }

                .plugin-avg-time.slow {
                    color: #f87171;
                    background: rgba(248, 113, 113, 0.1);
                }

                .no-plugins {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    font-style: italic;
                    padding: 12px;
                    text-align: center;
                }

                .queue-arrow {
                    font-size: 2rem;
                    color: var(--text-secondary);
                    align-self: center;
                }

                /* Performance Overview */
                .performance-overview-card {
                    margin-top: 20px;
                }

                .performance-overview-card h2 {
                    margin-bottom: 8px;
                }

                .performance-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: 16px;
                }

                .performance-card {
                    background: var(--bg-tertiary);
                    border-radius: 8px;
                    padding: 16px;
                    text-align: center;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .performance-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                }

                .performance-card.quick {
                    border: 1px solid var(--accent-primary);
                }

                .performance-card.slow {
                    border: 1px solid var(--accent-warning);
                }

                .performance-card h3 {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    margin-bottom: 8px;
                }

                .perf-value {
                    font-size: 1.8rem;
                    font-weight: 700;
                    color: var(--accent-primary);
                }

                .perf-label {
                    color: var(--text-secondary);
                    font-size: 0.85rem;
                }

                .perf-details {
                    margin-top: 12px;
                    font-size: 0.75rem;
                    color: var(--text-secondary);
                }
            `}</style>
        </div>
    );
}

export default Plugins;
