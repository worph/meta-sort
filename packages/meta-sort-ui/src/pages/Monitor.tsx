import { useState, useEffect, useCallback } from 'react';
import {
    ProcessingStatus,
    Metrics,
    RedisStats,
    QueueItem,
    HashTimingStats,
    FailedFile
} from '../types';
import {
    formatMs,
    formatNumber,
    formatUptime,
    formatBytes,
    getFilename
} from '../utils/format';

function Monitor() {
    const [status, setStatus] = useState<ProcessingStatus | null>(null);
    const [metrics, setMetrics] = useState<Metrics | null>(null);
    const [redisStats, setRedisStats] = useState<RedisStats | null>(null);
    const [queue, setQueue] = useState<QueueItem[]>([]);
    const [failedFiles, setFailedFiles] = useState<FailedFile[]>([]);

    const fetchData = useCallback(async () => {
        try {
            const [statusRes, metricsRes, queueRes, statsRes, failedRes] = await Promise.all([
                fetch('/api/processing/status'),
                fetch('/api/metrics'),
                fetch('/api/processing/queue'),
                fetch('/api/stats'),
                fetch('/api/processing/failed')
            ]);

            if (statusRes.ok) setStatus(await statusRes.json());
            if (metricsRes.ok) setMetrics(await metricsRes.json());
            if (queueRes.ok) {
                const queueData = await queueRes.json();
                setQueue(queueData.items || []);
            }
            if (statsRes.ok) setRedisStats(await statsRes.json());
            if (failedRes.ok) {
                const failedData = await failedRes.json();
                setFailedFiles(failedData.failedFiles || []);
            }
        } catch (err) {
            console.error('Failed to fetch data:', err);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 2000);
        return () => clearInterval(interval);
    }, [fetchData]);

    const triggerScan = async () => {
        try {
            await fetch('/api/scan/trigger', { method: 'POST' });
            fetchData();
        } catch (err) {
            console.error('Failed to trigger scan:', err);
        }
    };

    const retryFile = async (filePath: string) => {
        try {
            await fetch('/api/processing/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filePath })
            });
            fetchData();
        } catch (err) {
            console.error('Failed to retry file:', err);
        }
    };

    const retryAllFailed = async () => {
        try {
            await fetch('/api/processing/retry-all', { method: 'POST' });
            fetchData();
        } catch (err) {
            console.error('Failed to retry all files:', err);
        }
    };

    // Calculate progress for 6-stage pipeline (including failed)
    // Discovered = files waiting for fast queue (validated but not yet processing)
    const getProgress = () => {
        if (!status) return { discovered: 0, fast: 0, awaitingBackground: 0, background: 0, done: 0, failed: 0, total: 0 };

        const computed = status.computed;
        const discoveredCount = status.totalDiscovered || 0; // Files waiting for fast queue
        const fastRunningCount = computed?.fastQueueRunning || 0;
        const awaitingBackgroundCount = status.awaitingBackground || 0;
        const backgroundRunningCount = computed?.backgroundQueueRunning || 0;
        const failedCount = status.totalFailed || 0;

        // Total = discovered + fast running + awaiting bg + bg running + done + failed
        const total = discoveredCount + fastRunningCount + awaitingBackgroundCount + backgroundRunningCount + status.totalDone + failedCount;

        if (total === 0) return { discovered: 0, fast: 0, awaitingBackground: 0, background: 0, done: 100, failed: 0, total: 0 };

        return {
            discovered: (discoveredCount / total) * 100,
            fast: (fastRunningCount / total) * 100,
            awaitingBackground: (awaitingBackgroundCount / total) * 100,
            background: (backgroundRunningCount / total) * 100,
            done: (status.totalDone / total) * 100,
            failed: (failedCount / total) * 100,
            total
        };
    };

    // Get queue statistics for display
    // StreamingPipeline stages: validation → lightProcessing → hashProcessing
    // UI mapping: Validation → Fast Queue → Background Queue
    const getQueueStats = () => {
        const computed = status?.computed;
        const fastQueueConcurrency = status?.fastQueueConcurrency || 16;
        const backgroundQueueConcurrency = status?.backgroundQueueConcurrency || 8;

        return {
            // Stage 1: Validation (quick extension checks)
            // Concurrency: 2x fast queue workers
            preProcess: {
                running: computed?.preProcessRunning || 0,
                pending: computed?.preProcessPending || 0,
                max: fastQueueConcurrency * 2,
                paused: computed?.preProcessPaused || false
            },
            // Stage 2: Fast Queue (midhash256 + FFmpeg + plugins)
            // Concurrency: fastQueueConcurrency workers
            fast: {
                running: computed?.fastQueueRunning || 0,
                pending: computed?.fastQueuePending || 0,
                max: fastQueueConcurrency,
                paused: computed?.fastQueuePaused || false
            },
            // Stage 3: Background Queue (SHA-256 full file hash)
            // Concurrency: backgroundQueueConcurrency workers
            background: {
                running: computed?.backgroundQueueRunning || 0,
                pending: computed?.backgroundQueuePending || 0,
                max: backgroundQueueConcurrency,
                paused: computed?.backgroundQueuePaused || false
            }
        };
    };

    const progress = getProgress();
    const queueStats = getQueueStats();

    return (
        <div className="monitor-page">
            <div className="monitor-header">
                <h1>Processing Monitor</h1>
                <button className="btn btn-primary" onClick={triggerScan}>
                    Trigger Scan
                </button>
            </div>

            {/* Pipeline Progress Bar - 6 Stage (including failed) */}
            {status && (
                <div className="card pipeline-section">
                    <h2>Processing Pipeline</h2>
                    <div className="pipeline-bar-container">
                        <div className="pipeline-bar">
                            <div className="bar-segment discovered" style={{ width: `${progress.discovered}%` }} />
                            <div className="bar-segment fast" style={{ width: `${progress.fast}%` }} />
                            <div className="bar-segment awaiting-background" style={{ width: `${progress.awaitingBackground}%` }} />
                            <div className="bar-segment background" style={{ width: `${progress.background}%` }} />
                            <div className="bar-segment done" style={{ width: `${progress.done}%` }} />
                            <div className="bar-segment failed" style={{ width: `${progress.failed}%` }} />
                        </div>
                    </div>
                    <div className="pipeline-stats">
                        <div className="pipeline-stat discovered">
                            <span className="stat-dot"></span>
                            <span className="stat-label">Discovered</span>
                            <span className="stat-value">{formatNumber(status.totalDiscovered)}</span>
                        </div>
                        <div className="pipeline-stat fast">
                            <span className="stat-dot"></span>
                            <span className="stat-label">Fast Queue</span>
                            <span className="stat-value">
                                {queueStats.fast.running}/{queueStats.fast.max}
                            </span>
                            {queueStats.fast.paused && <span className="paused-indicator">paused</span>}
                        </div>
                        <div className="pipeline-stat awaiting-background">
                            <span className="stat-dot"></span>
                            <span className="stat-label">Awaiting BG</span>
                            <span className="stat-value">{formatNumber(status.awaitingBackground || 0)}</span>
                        </div>
                        <div className="pipeline-stat background">
                            <span className="stat-dot"></span>
                            <span className="stat-label">Background</span>
                            <span className="stat-value">
                                {queueStats.background.running}/{queueStats.background.max}
                            </span>
                            {queueStats.background.paused && <span className="paused-indicator">paused</span>}
                        </div>
                        <div className="pipeline-stat done">
                            <span className="stat-dot"></span>
                            <span className="stat-label">Complete</span>
                            <span className="stat-value">{formatNumber(status.totalDone)}</span>
                        </div>
                        {(status.totalFailed || 0) > 0 && (
                            <div className="pipeline-stat failed">
                                <span className="stat-dot"></span>
                                <span className="stat-label">Failed</span>
                                <span className="stat-value">{formatNumber(status.totalFailed || 0)}</span>
                            </div>
                        )}
                    </div>
                    {progress.total > 0 && (
                        <div className="pipeline-summary">
                            {formatNumber(progress.total)} total files |{' '}
                            {((status.totalDone / progress.total) * 100).toFixed(1)}% complete
                            {(status.totalFailed || 0) > 0 && ` | ${status.totalFailed} failed`}
                        </div>
                    )}
                </div>
            )}

            {/* Queue Status Cards - StreamingPipeline stages */}
            {status && (
                <div className="queue-cards">
                    <div className="queue-card fast">
                        <div className="queue-card-header">
                            <span className="queue-icon">⚡</span>
                            <span className="queue-name">Fast Queue</span>
                        </div>
                        <div className="queue-card-body">
                            <div className="queue-stat">
                                <span className="queue-stat-label">Running</span>
                                <span className="queue-stat-value">{queueStats.fast.running}/{queueStats.fast.max}</span>
                            </div>
                            <div className="queue-stat">
                                <span className="queue-stat-label">Pending</span>
                                <span className="queue-stat-value">{queueStats.fast.pending}</span>
                            </div>
                            <div className="queue-progress-bar">
                                <div
                                    className="queue-progress-fill"
                                    style={{ width: `${(queueStats.fast.running / queueStats.fast.max) * 100}%` }}
                                />
                            </div>
                            <div className="queue-status">
                                {queueStats.fast.paused ? (
                                    <span className="status-paused">⏸ Paused</span>
                                ) : queueStats.fast.running > 0 ? (
                                    <span className="status-running">▶ Running</span>
                                ) : (
                                    <span className="status-idle">● Idle</span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="queue-card background">
                        <div className="queue-card-header">
                            <span className="queue-icon">🔄</span>
                            <span className="queue-name">Background Queue</span>
                        </div>
                        <div className="queue-card-body">
                            <div className="queue-stat">
                                <span className="queue-stat-label">Running</span>
                                <span className="queue-stat-value">{queueStats.background.running}/{queueStats.background.max}</span>
                            </div>
                            <div className="queue-stat">
                                <span className="queue-stat-label">Pending</span>
                                <span className="queue-stat-value">{queueStats.background.pending}</span>
                            </div>
                            <div className="queue-progress-bar">
                                <div
                                    className="queue-progress-fill"
                                    style={{ width: `${(queueStats.background.running / queueStats.background.max) * 100}%` }}
                                />
                            </div>
                            <div className="queue-status">
                                {queueStats.background.paused ? (
                                    <span className="status-paused">⏸ Paused</span>
                                ) : queueStats.background.running > 0 ? (
                                    <span className="status-running">▶ Running</span>
                                ) : (
                                    <span className="status-idle">● Idle</span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="grid grid-2">
                {/* Metrics and Stats */}
                <div className="card">
                    <h2>Performance Metrics</h2>
                    {metrics && (
                        <div className="metrics-grid">
                            <div className="metric-box">
                                <h3>Processed</h3>
                                <div className="metric-value">{formatNumber(metrics.totalFilesProcessed)}</div>
                                <div className="metric-label">of {formatNumber(metrics.totalFilesDiscovered)} discovered</div>
                                {metrics.totalFilesFailed > 0 && (
                                    <div className="metric-error">
                                        {metrics.totalFilesFailed} failed
                                    </div>
                                )}
                            </div>

                            <div className="metric-box">
                                <h3>Avg Metadata</h3>
                                <div className="metric-value">{formatMs(metrics.averageLightProcessingMs)}</div>
                                <div className="metric-label">per file</div>
                            </div>

                            <div className="metric-box">
                                <h3>Avg Hashing</h3>
                                <div className="metric-value">{formatMs(metrics.averageHashProcessingMs)}</div>
                                <div className="metric-label">per file</div>
                            </div>

                            <div className="metric-box throughput">
                                <h3>Throughput</h3>
                                <div className="metric-value">{(metrics.filesPerSecond * 60).toFixed(1)}</div>
                                <div className="metric-label">Files/min</div>
                            </div>
                        </div>
                    )}

                    <h3 className="section-title">System Stats</h3>
                    <div className="stats-grid">
                        <div className="stat-box">
                            <div className="stat-value">{redisStats ? formatNumber(redisStats.fileCount) : '-'}</div>
                            <div className="stat-label">Files in Redis</div>
                        </div>
                        <div className="stat-box">
                            <div className="stat-value">{redisStats?.memoryUsage || '-'}</div>
                            <div className="stat-label">Redis Memory</div>
                        </div>
                        <div className="stat-box">
                            <div className="stat-value">{metrics ? formatUptime(metrics.uptime) : '-'}</div>
                            <div className="stat-label">Uptime</div>
                        </div>
                        <div className="stat-box">
                            <div className="stat-value">
                                {metrics?.memoryUsage
                                    ? `${Math.round(metrics.memoryUsage.heapUsed / 1024 / 1024)} MB`
                                    : '-'}
                            </div>
                            <div className="stat-label">Node Heap</div>
                        </div>
                    </div>
                </div>

                {/* Total Size Card */}
                <div className="card total-size-card">
                    <h2>Total Size</h2>
                    <div className="total-size-value">
                        {redisStats ? formatBytes(redisStats.totalSize) : '-'}
                    </div>
                    <div className="total-size-label">Watch Folders</div>
                </div>
            </div>

            {/* Hash Computation Performance */}
            {metrics?.hashComputationTimes && Object.keys(metrics.hashComputationTimes).length > 0 && (
                <div className="card">
                    <h2>Hash Computation Performance</h2>
                    <p className="card-description">Per-algorithm timing for hash computations</p>
                    <div className="hash-timing-grid">
                        {Object.entries(metrics.hashComputationTimes).map(([algorithm, stats]: [string, HashTimingStats]) => {
                            const displayName = algorithm
                                .replace('sha256', 'SHA-256')
                                .replace('sha1', 'SHA-1')
                                .replace('md5', 'MD5')
                                .replace('midhash256', 'MidHash');
                            const isQuick = stats.average < 1000;

                            return (
                                <div key={algorithm} className={`timing-card ${isQuick ? 'quick' : 'slow'}`}>
                                    <h3>{displayName}</h3>
                                    <div className="timing-value">{formatMs(stats.average)}</div>
                                    <div className="timing-label">Average Time</div>
                                    <div className="timing-details">
                                        {formatNumber(stats.count)} computed |
                                        min: {formatMs(stats.min)} |
                                        max: {formatMs(stats.max)}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Active Queue */}
            <div className="card">
                <h2>Active Processing ({queue.length})</h2>
                {queue.length > 0 ? (
                    <table>
                        <thead>
                            <tr>
                                <th>File</th>
                                <th>Stage</th>
                                <th>Duration</th>
                            </tr>
                        </thead>
                        <tbody>
                            {queue.slice(0, 100).map((item, i) => {
                                // Map legacy phase to new stage names
                                const getStageInfo = () => {
                                    if (item.queue) {
                                        // New queue field
                                        switch (item.queue) {
                                            case 'validation': return { label: 'Validation', class: 'validation' };
                                            case 'metadata': return { label: 'Fast Queue', class: 'metadata' };
                                            case 'hashing': return { label: 'Background Queue', class: 'hashing' };
                                            default: return { label: item.queue, class: 'unknown' };
                                        }
                                    }
                                    // Legacy phase field
                                    switch (item.phase) {
                                        case 'light': return { label: 'Fast Queue', class: 'metadata' };
                                        case 'hash': return { label: 'Background Queue', class: 'hashing' };
                                        default: return { label: item.phase, class: 'unknown' };
                                    }
                                };
                                const stageInfo = getStageInfo();

                                return (
                                    <tr key={i}>
                                        <td className="file-path" title={item.path}>{getFilename(item.path)}</td>
                                        <td>
                                            <span className={`stage-badge stage-${stageInfo.class}`}>
                                                {stageInfo.label}
                                            </span>
                                            {item.plugin && (
                                                <span className="plugin-badge">{item.plugin}</span>
                                            )}
                                        </td>
                                        <td>
                                            {item.startTime ? formatMs(Date.now() - item.startTime) : '-'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                ) : (
                    <div className="empty-state">No files currently processing</div>
                )}
            </div>

            {/* Failed Files */}
            {failedFiles.length > 0 && (
                <div className="card failed-files-section">
                    <div className="card-header-with-action">
                        <h2>Failed Files ({failedFiles.length})</h2>
                        <button className="btn btn-small btn-warning" onClick={retryAllFailed}>
                            Retry All
                        </button>
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th>File</th>
                                <th>Reason</th>
                                <th>Retries</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {failedFiles.slice(0, 100).map((file, i) => (
                                <tr key={i}>
                                    <td className="file-path" title={file.filePath}>{getFilename(file.filePath)}</td>
                                    <td className="error-reason" title={file.reason}>
                                        {file.reason.length > 50 ? file.reason.substring(0, 50) + '...' : file.reason}
                                    </td>
                                    <td>{file.retryCount}</td>
                                    <td>
                                        <button
                                            className="btn btn-small btn-retry"
                                            onClick={() => retryFile(file.filePath)}
                                        >
                                            Retry
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Watched Folders */}
            {status && status.watchedFolders && (
                <div className="card">
                    <h2>Watched Folders</h2>
                    <ul className="folder-list">
                        {(Array.isArray(status.watchedFolders)
                            ? status.watchedFolders
                            : [status.watchedFolders]
                        ).map((folder, i) => (
                            <li key={i}>{folder}</li>
                        ))}
                    </ul>
                </div>
            )}

            <style>{`
                .monitor-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }

                .monitor-header h1 {
                    font-size: 1.8rem;
                }


                /* Pipeline Progress Bar */
                .pipeline-section {
                    margin-bottom: 24px;
                }

                .pipeline-section h2 {
                    margin-bottom: 16px;
                }

                .pipeline-bar-container {
                    margin-bottom: 16px;
                }

                .pipeline-bar {
                    display: flex;
                    height: 24px;
                    border-radius: 12px;
                    overflow: hidden;
                    background: var(--bg-tertiary);
                }

                .bar-segment {
                    transition: width 0.3s ease;
                }

                .bar-segment.discovered {
                    background: linear-gradient(90deg, #6b7280, #9ca3af);
                }

                .bar-segment.preprocess {
                    background: linear-gradient(90deg, #3b82f6, #60a5fa);
                }

                .bar-segment.awaiting-fast {
                    background: linear-gradient(90deg, #06b6d4, #22d3ee);
                }

                .bar-segment.fast {
                    background: linear-gradient(90deg, #f59e0b, #fbbf24);
                }

                .bar-segment.awaiting-background {
                    background: linear-gradient(90deg, #ec4899, #f472b6);
                }

                .bar-segment.background {
                    background: linear-gradient(90deg, #8b5cf6, #a78bfa);
                }

                .bar-segment.done {
                    background: linear-gradient(90deg, #10b981, #34d399);
                }

                .bar-segment.failed {
                    background: linear-gradient(90deg, #ef4444, #f87171);
                }

                .pipeline-stats {
                    display: flex;
                    justify-content: space-around;
                    flex-wrap: wrap;
                    gap: 12px;
                }

                .pipeline-stat {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .stat-dot {
                    width: 12px;
                    height: 12px;
                    border-radius: 50%;
                }

                .pipeline-stat.discovered .stat-dot { background: #9ca3af; }
                .pipeline-stat.preprocess .stat-dot { background: #60a5fa; }
                .pipeline-stat.awaiting-fast .stat-dot { background: #22d3ee; }
                .pipeline-stat.fast .stat-dot { background: #fbbf24; }
                .pipeline-stat.awaiting-background .stat-dot { background: #f472b6; }
                .pipeline-stat.background .stat-dot { background: #a78bfa; }
                .pipeline-stat.done .stat-dot { background: #34d399; }
                .pipeline-stat.failed .stat-dot { background: #f87171; }

                .pipeline-stat .stat-label {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                .pipeline-stat .stat-value {
                    font-weight: 700;
                    font-size: 1.1rem;
                }

                .pipeline-stat.discovered .stat-value { color: #9ca3af; }
                .pipeline-stat.preprocess .stat-value { color: #60a5fa; }
                .pipeline-stat.awaiting-fast .stat-value { color: #22d3ee; }
                .pipeline-stat.fast .stat-value { color: #fbbf24; }
                .pipeline-stat.awaiting-background .stat-value { color: #f472b6; }
                .pipeline-stat.background .stat-value { color: #a78bfa; }
                .pipeline-stat.done .stat-value { color: #34d399; }
                .pipeline-stat.failed .stat-value { color: #f87171; }

                .paused-indicator {
                    font-size: 0.75rem;
                    color: var(--accent-warning);
                    background: rgba(245, 158, 11, 0.2);
                    padding: 2px 6px;
                    border-radius: 4px;
                }

                .pipeline-summary {
                    text-align: center;
                    margin-top: 16px;
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                /* Queue Status Cards */
                .queue-cards {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 16px;
                    margin-bottom: 24px;
                }

                @media (max-width: 900px) {
                    .queue-cards {
                        grid-template-columns: 1fr;
                    }
                }

                .queue-card {
                    background: var(--bg-secondary);
                    border-radius: 12px;
                    padding: 16px;
                    border: 1px solid var(--border-color);
                }

                .queue-card.preprocess {
                    border-top: 3px solid #60a5fa;
                }

                .queue-card.fast {
                    border-top: 3px solid #fbbf24;
                }

                .queue-card.background {
                    border-top: 3px solid #a78bfa;
                }

                .queue-card-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 16px;
                }

                .queue-icon {
                    font-size: 1.2rem;
                }

                .queue-name {
                    font-weight: 600;
                    font-size: 1.1rem;
                    color: var(--text-primary);
                }

                .queue-card-body {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }

                .queue-stat {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .queue-stat-label {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                .queue-stat-value {
                    font-weight: 600;
                    font-size: 1.1rem;
                    color: var(--text-primary);
                }

                .queue-progress-bar {
                    height: 6px;
                    background: var(--bg-tertiary);
                    border-radius: 3px;
                    overflow: hidden;
                }

                .queue-progress-fill {
                    height: 100%;
                    transition: width 0.3s ease;
                }

                .queue-card.preprocess .queue-progress-fill {
                    background: linear-gradient(90deg, #3b82f6, #60a5fa);
                }

                .queue-card.fast .queue-progress-fill {
                    background: linear-gradient(90deg, #f59e0b, #fbbf24);
                }

                .queue-card.background .queue-progress-fill {
                    background: linear-gradient(90deg, #8b5cf6, #a78bfa);
                }

                .queue-status {
                    text-align: center;
                    margin-top: 4px;
                }

                .status-running {
                    color: #34d399;
                    font-size: 0.85rem;
                    font-weight: 500;
                }

                .status-paused {
                    color: #fbbf24;
                    font-size: 0.85rem;
                    font-weight: 500;
                }

                .status-idle {
                    color: var(--text-secondary);
                    font-size: 0.85rem;
                }

                .queue-card-footer {
                    margin-top: 12px;
                    padding-top: 12px;
                    border-top: 1px solid var(--border-color);
                }

                .queue-description {
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }

                .more-files {
                    text-align: center;
                    padding: 12px;
                    color: var(--text-secondary);
                    font-style: italic;
                }

                /* Total Size Card */
                .total-size-card {
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    text-align: center;
                }

                .total-size-card h2 {
                    margin-bottom: 16px;
                }

                .total-size-value {
                    font-size: 2.5rem;
                    font-weight: 700;
                    color: var(--accent-primary);
                    margin-bottom: 8px;
                }

                .total-size-label {
                    color: var(--text-secondary);
                    font-size: 1rem;
                }

                /* Metrics Grid */
                .metrics-grid {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 16px;
                    margin-bottom: 24px;
                }

                @media (max-width: 900px) {
                    .metrics-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }
                    .pipeline-cards {
                        grid-template-columns: repeat(2, 1fr);
                    }
                }

                .metric-box {
                    text-align: center;
                    padding: 15px;
                    background: var(--bg-tertiary);
                    border-radius: 8px;
                }

                .metric-box h3 {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    margin-bottom: 8px;
                }

                .metric-value {
                    font-size: 1.8rem;
                    font-weight: 700;
                    color: var(--accent-primary);
                }

                .metric-label {
                    color: var(--text-secondary);
                    font-size: 0.85rem;
                }

                .metric-error {
                    color: var(--error);
                    font-size: 0.8rem;
                    margin-top: 8px;
                }

                /* Stats Grid */
                .section-title {
                    margin-top: 24px;
                    margin-bottom: 12px;
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 12px;
                }

                .stat-box {
                    background: var(--bg-tertiary);
                    border-radius: 8px;
                    padding: 12px;
                    text-align: center;
                }

                .stat-value {
                    font-size: 1.4rem;
                    font-weight: 700;
                    color: var(--accent-primary);
                }

                .stat-label {
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                }

                /* Hash Timing */
                .card-description {
                    color: var(--text-secondary);
                    margin-bottom: 16px;
                    font-size: 0.9rem;
                }

                .hash-timing-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: 16px;
                }

                .timing-card {
                    background: var(--bg-tertiary);
                    border-radius: 8px;
                    padding: 16px;
                    text-align: center;
                }

                .timing-card.quick {
                    border: 1px solid var(--accent-primary);
                }

                .timing-card.slow {
                    border: 1px solid var(--accent-warning);
                }

                .timing-card h3 {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    margin-bottom: 8px;
                }

                .timing-value {
                    font-size: 1.8rem;
                    font-weight: 700;
                    color: var(--accent-primary);
                }

                .timing-label {
                    color: var(--text-secondary);
                    font-size: 0.85rem;
                }

                .timing-details {
                    margin-top: 12px;
                    font-size: 0.75rem;
                    color: var(--text-secondary);
                }

                /* Card Header with Action */
                .card-header-with-action {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 16px;
                }

                .card-header-with-action h2 {
                    margin: 0;
                }

                .btn-small {
                    padding: 6px 12px;
                    font-size: 0.8rem;
                }

                /* Empty State */
                .empty-state {
                    text-align: center;
                    color: var(--text-secondary);
                    padding: 40px;
                }

                .empty-state.success {
                    color: var(--accent-primary);
                }

                .loading-icon {
                    font-size: 2rem;
                    margin-bottom: 12px;
                }

                .hint {
                    font-size: 0.8rem;
                    margin-top: 8px;
                    opacity: 0.7;
                }

                /* Stage Badges */
                .stage-badge {
                    display: inline-block;
                    padding: 4px 10px;
                    border-radius: 12px;
                    font-size: 0.8rem;
                    font-weight: 500;
                }

                .stage-validation {
                    background: rgba(59, 130, 246, 0.15);
                    color: #60a5fa;
                }

                .stage-metadata {
                    background: rgba(245, 158, 11, 0.15);
                    color: #fbbf24;
                }

                .stage-hashing {
                    background: rgba(139, 92, 246, 0.15);
                    color: #a78bfa;
                }

                .stage-plugin {
                    background: rgba(6, 182, 212, 0.15);
                    color: #22d3ee;
                }

                .plugin-badge {
                    display: inline-block;
                    margin-left: 8px;
                    padding: 2px 8px;
                    border-radius: 8px;
                    font-size: 0.7rem;
                    background: var(--bg-tertiary);
                    color: var(--text-secondary);
                }

                /* Table */
                .file-path {
                    font-family: monospace;
                    max-width: 400px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                /* Folder List */
                .folder-list {
                    list-style: none;
                }

                .folder-list li {
                    padding: 10px 15px;
                    background: var(--bg-tertiary);
                    border-radius: 6px;
                    margin-bottom: 8px;
                    font-family: monospace;
                }

                /* Failed Files Section */
                .failed-files-section {
                    border-left: 4px solid #ef4444;
                }

                .failed-files-section h2 {
                    color: #f87171;
                }

                .error-reason {
                    color: #f87171;
                    font-size: 0.85rem;
                    max-width: 300px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .btn-warning {
                    background: linear-gradient(135deg, #f59e0b, #d97706);
                    color: white;
                }

                .btn-warning:hover {
                    background: linear-gradient(135deg, #d97706, #b45309);
                }

                .btn-retry {
                    background: linear-gradient(135deg, #3b82f6, #2563eb);
                    color: white;
                    padding: 4px 8px;
                    font-size: 0.75rem;
                }

                .btn-retry:hover {
                    background: linear-gradient(135deg, #2563eb, #1d4ed8);
                }
            `}</style>
        </div>
    );
}

export default Monitor;
