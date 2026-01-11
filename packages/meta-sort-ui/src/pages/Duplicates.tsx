import { useState, useEffect, useCallback } from 'react';
import { DuplicateData, DuplicateGroup } from '../types';
import { formatNumber, formatMs, getFilename } from '../utils/format';

function Duplicates() {
    const [duplicateData, setDuplicateData] = useState<DuplicateData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'hash' | 'title'>('hash');
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

    const fetchDuplicates = useCallback(async () => {
        try {
            const res = await fetch('/api/duplicates');
            if (res.ok) {
                const data = await res.json();
                setDuplicateData(data);
                setError(null);
            } else {
                setError('Failed to fetch duplicate data');
            }
        } catch (err) {
            console.error('Failed to fetch duplicates:', err);
            setError('Failed to fetch duplicate data');
        }
    }, []);

    const computeDuplicates = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/duplicates/compute', { method: 'POST' });
            if (res.ok) {
                await fetchDuplicates();
            } else {
                setError('Failed to compute duplicates');
            }
        } catch (err) {
            console.error('Failed to compute duplicates:', err);
            setError('Failed to compute duplicates');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchDuplicates();
        const interval = setInterval(fetchDuplicates, 30000); // Refresh every 30s
        return () => clearInterval(interval);
    }, [fetchDuplicates]);

    const toggleGroup = (key: string) => {
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const expandAll = () => {
        const groups = activeTab === 'hash'
            ? duplicateData?.hashDuplicates
            : duplicateData?.titleDuplicates;
        if (groups) {
            setExpandedGroups(new Set(groups.map(g => g.key)));
        }
    };

    const collapseAll = () => {
        setExpandedGroups(new Set());
    };

    const renderDuplicateGroup = (group: DuplicateGroup, type: 'hash' | 'title') => {
        const isExpanded = expandedGroups.has(group.key);
        const displayKey = type === 'hash'
            ? `${group.key.substring(0, 16)}...`
            : group.key;

        return (
            <div key={group.key} className={`duplicate-group ${isExpanded ? 'expanded' : ''}`}>
                <div
                    className="group-header"
                    onClick={() => toggleGroup(group.key)}
                >
                    <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                    <span className="group-key" title={group.key}>{displayKey}</span>
                    <span className="group-count">{group.files.length} files</span>
                </div>
                {isExpanded && (
                    <div className="group-files">
                        {group.files.map((file, idx) => (
                            <div key={idx} className="file-item">
                                <span className="file-index">{idx + 1}.</span>
                                <span className="file-name" title={file}>{getFilename(file)}</span>
                                <span className="file-path" title={file}>{file}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const hashDuplicates = duplicateData?.hashDuplicates || [];
    const titleDuplicates = duplicateData?.titleDuplicates || [];
    const stats = duplicateData?.stats;

    return (
        <div className="duplicates-page">
            <div className="duplicates-header">
                <h1>Duplicate Analysis</h1>
                <div className="header-actions">
                    <button
                        className="btn btn-primary"
                        onClick={computeDuplicates}
                        disabled={loading}
                    >
                        {loading ? 'Computing...' : 'Recompute Duplicates'}
                    </button>
                </div>
            </div>

            {error && (
                <div className="error-banner">{error}</div>
            )}

            {/* Stats Cards */}
            {stats && (
                <div className="stats-cards">
                    <div className="stat-card hash">
                        <div className="stat-icon">#</div>
                        <div className="stat-content">
                            <div className="stat-value">{formatNumber(stats.hashGroupCount)}</div>
                            <div className="stat-label">Hash Duplicate Groups</div>
                            <div className="stat-detail">{formatNumber(stats.hashFileCount)} total files</div>
                        </div>
                    </div>
                    <div className="stat-card title">
                        <div className="stat-icon">T</div>
                        <div className="stat-content">
                            <div className="stat-value">{formatNumber(stats.titleGroupCount)}</div>
                            <div className="stat-label">Title Duplicate Groups</div>
                            <div className="stat-detail">{formatNumber(stats.titleFileCount)} total files</div>
                        </div>
                    </div>
                    {duplicateData?.computedAt && (
                        <div className="stat-card info">
                            <div className="stat-icon">i</div>
                            <div className="stat-content">
                                <div className="stat-value">{formatMs(duplicateData.computationTimeMs)}</div>
                                <div className="stat-label">Computation Time</div>
                                <div className="stat-detail">
                                    {new Date(duplicateData.computedAt).toLocaleString()}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Tabs */}
            <div className="card duplicates-card">
                <div className="tabs-header">
                    <div className="tabs">
                        <button
                            className={`tab ${activeTab === 'hash' ? 'active' : ''}`}
                            onClick={() => setActiveTab('hash')}
                        >
                            Hash Duplicates ({hashDuplicates.length})
                        </button>
                        <button
                            className={`tab ${activeTab === 'title' ? 'active' : ''}`}
                            onClick={() => setActiveTab('title')}
                        >
                            Title Duplicates ({titleDuplicates.length})
                        </button>
                    </div>
                    <div className="tab-actions">
                        <button className="btn btn-small btn-secondary" onClick={expandAll}>
                            Expand All
                        </button>
                        <button className="btn btn-small btn-secondary" onClick={collapseAll}>
                            Collapse All
                        </button>
                    </div>
                </div>

                <div className="tab-content">
                    {activeTab === 'hash' && (
                        <div className="duplicates-list">
                            {hashDuplicates.length === 0 ? (
                                <div className="empty-state">
                                    <p>No hash duplicates found</p>
                                    <p className="hint">Files with identical content (same SHA-256 hash)</p>
                                </div>
                            ) : (
                                <>
                                    <p className="list-description">
                                        Files with identical content (exact byte-for-byte matches)
                                    </p>
                                    {hashDuplicates.map(group => renderDuplicateGroup(group, 'hash'))}
                                </>
                            )}
                        </div>
                    )}

                    {activeTab === 'title' && (
                        <div className="duplicates-list">
                            {titleDuplicates.length === 0 ? (
                                <div className="empty-state">
                                    <p>No title duplicates found</p>
                                    <p className="hint">Files with similar parsed titles</p>
                                </div>
                            ) : (
                                <>
                                    <p className="list-description">
                                        Files with matching parsed titles (may be different quality/releases)
                                    </p>
                                    {titleDuplicates.map(group => renderDuplicateGroup(group, 'title'))}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <style>{`
                .duplicates-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }

                .duplicates-header h1 {
                    font-size: 1.8rem;
                }

                .error-banner {
                    background: rgba(255, 107, 107, 0.1);
                    border: 1px solid var(--error);
                    color: var(--error);
                    padding: 12px 16px;
                    border-radius: 8px;
                    margin-bottom: 20px;
                }

                /* Stats Cards */
                .stats-cards {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 16px;
                    margin-bottom: 24px;
                }

                .stat-card {
                    background: var(--bg-secondary);
                    border-radius: 12px;
                    padding: 20px;
                    display: flex;
                    gap: 16px;
                    align-items: center;
                    border: 1px solid var(--border-color);
                }

                .stat-card.hash {
                    border-left: 4px solid #a78bfa;
                }

                .stat-card.title {
                    border-left: 4px solid #fbbf24;
                }

                .stat-card.info {
                    border-left: 4px solid #60a5fa;
                }

                .stat-icon {
                    width: 48px;
                    height: 48px;
                    background: var(--bg-tertiary);
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.5rem;
                    font-weight: bold;
                    color: var(--text-secondary);
                }

                .stat-card.hash .stat-icon {
                    color: #a78bfa;
                }

                .stat-card.title .stat-icon {
                    color: #fbbf24;
                }

                .stat-card.info .stat-icon {
                    color: #60a5fa;
                }

                .stat-content {
                    flex: 1;
                }

                .stat-value {
                    font-size: 1.8rem;
                    font-weight: 700;
                    color: var(--text-primary);
                }

                .stat-label {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                .stat-detail {
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    margin-top: 4px;
                    opacity: 0.7;
                }

                /* Tabs */
                .duplicates-card {
                    min-height: 400px;
                }

                .tabs-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    border-bottom: 1px solid var(--border-color);
                    padding-bottom: 12px;
                }

                .tabs {
                    display: flex;
                    gap: 8px;
                }

                .tab {
                    padding: 10px 20px;
                    background: transparent;
                    border: none;
                    color: var(--text-secondary);
                    font-size: 1rem;
                    cursor: pointer;
                    border-radius: 8px 8px 0 0;
                    transition: all 0.2s;
                }

                .tab:hover {
                    color: var(--text-primary);
                    background: var(--bg-tertiary);
                }

                .tab.active {
                    color: var(--accent-primary);
                    background: var(--bg-tertiary);
                    font-weight: 600;
                }

                .tab-actions {
                    display: flex;
                    gap: 8px;
                }

                .btn-small {
                    padding: 6px 12px;
                    font-size: 0.85rem;
                }

                /* Duplicates List */
                .list-description {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    margin-bottom: 16px;
                }

                .duplicates-list {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .duplicate-group {
                    background: var(--bg-tertiary);
                    border-radius: 8px;
                    overflow: hidden;
                }

                .group-header {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px 16px;
                    cursor: pointer;
                    transition: background 0.2s;
                }

                .group-header:hover {
                    background: var(--bg-secondary);
                }

                .expand-icon {
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    width: 16px;
                }

                .group-key {
                    flex: 1;
                    font-family: monospace;
                    font-size: 0.9rem;
                    color: var(--accent-primary);
                }

                .group-count {
                    background: var(--bg-secondary);
                    padding: 4px 10px;
                    border-radius: 12px;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }

                .group-files {
                    background: var(--bg-secondary);
                    padding: 8px 16px;
                    border-top: 1px solid var(--border-color);
                }

                .file-item {
                    display: grid;
                    grid-template-columns: 30px 200px 1fr;
                    gap: 12px;
                    padding: 8px 0;
                    border-bottom: 1px solid var(--border-color);
                    font-size: 0.85rem;
                }

                .file-item:last-child {
                    border-bottom: none;
                }

                .file-index {
                    color: var(--text-secondary);
                    text-align: right;
                }

                .file-name {
                    font-weight: 500;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .file-path {
                    color: var(--text-secondary);
                    font-family: monospace;
                    font-size: 0.8rem;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                /* Empty State */
                .empty-state {
                    text-align: center;
                    padding: 60px 20px;
                    color: var(--text-secondary);
                }

                .empty-state p {
                    margin: 0;
                }

                .empty-state .hint {
                    font-size: 0.9rem;
                    margin-top: 8px;
                    opacity: 0.7;
                }

                @media (max-width: 800px) {
                    .tabs-header {
                        flex-direction: column;
                        gap: 12px;
                        align-items: flex-start;
                    }

                    .file-item {
                        grid-template-columns: 30px 1fr;
                    }

                    .file-path {
                        grid-column: 1 / -1;
                        padding-left: 42px;
                    }
                }
            `}</style>
        </div>
    );
}

export default Duplicates;
