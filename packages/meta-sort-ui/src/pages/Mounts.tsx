import { useState, useEffect } from 'react';

interface MountConfig {
  id: string;
  name: string;
  type: 'nfs' | 'smb' | 'rclone';
  enabled: boolean;
  mountPath: string;
  // Type-specific
  nfsServer?: string;
  nfsPath?: string;
  smbServer?: string;
  smbShare?: string;
  rcloneRemote?: string;
  rclonePath?: string;
}

interface MountStatus extends MountConfig {
  mounted: boolean;
  error?: string;
  lastChecked: number;
}

interface RcloneRemote {
  name: string;
  type: string;
}

function Mounts() {
  const [mounts, setMounts] = useState<MountStatus[]>([]);
  const [remotes, setRemotes] = useState<RcloneRemote[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newMount, setNewMount] = useState<Partial<MountConfig>>({
    type: 'rclone',
    enabled: true,
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [mountsRes, remotesRes] = await Promise.all([
        fetch('/api/mounts'),
        fetch('/api/mounts/rclone/remotes')
      ]);

      if (mountsRes.ok) {
        const data = await mountsRes.json();
        setMounts(data.mounts || []);
      }
      if (remotesRes.ok) {
        const data = await remotesRes.json();
        setRemotes(data.remotes || []);
      }
    } catch (err) {
      console.error('Failed to fetch mounts:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleMount = async (id: string) => {
    try {
      await fetch(`/api/mounts/${id}/mount`, { method: 'POST' });
      fetchData();
    } catch (err) {
      console.error('Failed to mount:', err);
    }
  };

  const handleUnmount = async (id: string) => {
    try {
      await fetch(`/api/mounts/${id}/unmount`, { method: 'POST' });
      fetchData();
    } catch (err) {
      console.error('Failed to unmount:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to remove this mount?')) return;
    try {
      await fetch(`/api/mounts/${id}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error('Failed to delete mount:', err);
    }
  };

  const handleAddMount = async () => {
    try {
      const res = await fetch('/api/mounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newMount),
      });
      if (res.ok) {
        setShowAddModal(false);
        setNewMount({ type: 'rclone', enabled: true });
        fetchData();
      }
    } catch (err) {
      console.error('Failed to add mount:', err);
    }
  };

  const getMountIcon = (type: string) => {
    switch (type) {
      case 'nfs':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
            <line x1="6" y1="6" x2="6.01" y2="6"/>
            <line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
        );
      case 'smb':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
        );
      case 'rclone':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
          </svg>
        );
      default:
        return null;
    }
  };

  return (
    <div className="mounts-page">
      <div className="mounts-header">
        <h1>Remote Mounts</h1>
        <div className="mounts-controls">
          <a href="/rclone/" target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
            rclone Web UI
          </a>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            Add Mount
          </button>
        </div>
      </div>

      {remotes.length > 0 && (
        <div className="card">
          <h2>Available rclone Remotes</h2>
          <div className="remotes-grid">
            {remotes.map((remote) => (
              <div key={remote.name} className="remote-item">
                <span className="remote-name">{remote.name}</span>
                <span className="remote-type">{remote.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading">Loading mounts...</div>
      ) : mounts.length === 0 ? (
        <div className="empty-state">
          <p>No mounts configured</p>
          <p className="hint">Add a mount to connect remote storage like NFS, SMB, or cloud storage via rclone</p>
        </div>
      ) : (
        <div className="mounts-grid">
          {mounts.map((mount) => (
            <div key={mount.id} className={`mount-card ${mount.mounted ? 'mounted' : ''}`}>
              <div className="mount-header">
                <div className="mount-icon">{getMountIcon(mount.type)}</div>
                <div className="mount-info">
                  <h3>{mount.name}</h3>
                  <span className="mount-type">{mount.type.toUpperCase()}</span>
                </div>
                <div className={`mount-status ${mount.mounted ? 'status-success' : 'status-error'}`}>
                  {mount.mounted ? 'Mounted' : 'Unmounted'}
                </div>
              </div>

              <div className="mount-details">
                <div className="detail">
                  <span className="label">Mount Path</span>
                  <span className="value">{mount.mountPath}</span>
                </div>
                {mount.type === 'nfs' && (
                  <div className="detail">
                    <span className="label">Server</span>
                    <span className="value">{mount.nfsServer}:{mount.nfsPath}</span>
                  </div>
                )}
                {mount.type === 'smb' && (
                  <div className="detail">
                    <span className="label">Share</span>
                    <span className="value">//{mount.smbServer}/{mount.smbShare}</span>
                  </div>
                )}
                {mount.type === 'rclone' && (
                  <div className="detail">
                    <span className="label">Remote</span>
                    <span className="value">{mount.rcloneRemote}{mount.rclonePath || ''}</span>
                  </div>
                )}
              </div>

              {mount.error && (
                <div className="mount-error">{mount.error}</div>
              )}

              <div className="mount-actions">
                {mount.mounted ? (
                  <button className="btn btn-secondary" onClick={() => handleUnmount(mount.id)}>
                    Unmount
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={() => handleMount(mount.id)}>
                    Mount
                  </button>
                )}
                <button className="btn btn-danger" onClick={() => handleDelete(mount.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Mount</h2>
              <button className="close-btn" onClick={() => setShowAddModal(false)}>×</button>
            </div>
            <div className="modal-content">
              <div className="form-group">
                <label>Name</label>
                <input
                  type="text"
                  value={newMount.name || ''}
                  onChange={(e) => setNewMount({ ...newMount, name: e.target.value })}
                  placeholder="My Remote Storage"
                />
              </div>

              <div className="form-group">
                <label>Type</label>
                <select
                  value={newMount.type}
                  onChange={(e) => setNewMount({ ...newMount, type: e.target.value as any })}
                >
                  <option value="rclone">rclone (Cloud)</option>
                  <option value="nfs">NFS</option>
                  <option value="smb">SMB/CIFS</option>
                </select>
              </div>

              <div className="form-group">
                <label>Mount Path</label>
                <input
                  type="text"
                  value={newMount.mountPath || ''}
                  onChange={(e) => setNewMount({ ...newMount, mountPath: e.target.value })}
                  placeholder="/mnt/remote"
                />
              </div>

              {newMount.type === 'rclone' && (
                <>
                  <div className="form-group">
                    <label>rclone Remote</label>
                    <select
                      value={newMount.rcloneRemote || ''}
                      onChange={(e) => setNewMount({ ...newMount, rcloneRemote: e.target.value })}
                    >
                      <option value="">Select remote...</option>
                      {remotes.map((r) => (
                        <option key={r.name} value={r.name}>{r.name} ({r.type})</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Path in Remote (optional)</label>
                    <input
                      type="text"
                      value={newMount.rclonePath || ''}
                      onChange={(e) => setNewMount({ ...newMount, rclonePath: e.target.value })}
                      placeholder="/path/to/folder"
                    />
                  </div>
                </>
              )}

              {newMount.type === 'nfs' && (
                <>
                  <div className="form-group">
                    <label>NFS Server</label>
                    <input
                      type="text"
                      value={newMount.nfsServer || ''}
                      onChange={(e) => setNewMount({ ...newMount, nfsServer: e.target.value })}
                      placeholder="192.168.1.100"
                    />
                  </div>
                  <div className="form-group">
                    <label>NFS Path</label>
                    <input
                      type="text"
                      value={newMount.nfsPath || ''}
                      onChange={(e) => setNewMount({ ...newMount, nfsPath: e.target.value })}
                      placeholder="/export/media"
                    />
                  </div>
                </>
              )}

              {newMount.type === 'smb' && (
                <>
                  <div className="form-group">
                    <label>SMB Server</label>
                    <input
                      type="text"
                      value={newMount.smbServer || ''}
                      onChange={(e) => setNewMount({ ...newMount, smbServer: e.target.value })}
                      placeholder="192.168.1.100"
                    />
                  </div>
                  <div className="form-group">
                    <label>Share Name</label>
                    <input
                      type="text"
                      value={newMount.smbShare || ''}
                      onChange={(e) => setNewMount({ ...newMount, smbShare: e.target.value })}
                      placeholder="media"
                    />
                  </div>
                </>
              )}

              <div className="form-actions">
                <button className="btn btn-secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={handleAddMount}>
                  Add Mount
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .mounts-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .mounts-header h1 {
          font-size: 1.8rem;
        }

        .mounts-controls {
          display: flex;
          gap: 15px;
        }

        .remotes-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }

        .remote-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 15px;
          background: var(--bg-tertiary);
          border-radius: 6px;
        }

        .remote-name {
          font-weight: 500;
        }

        .remote-type {
          color: var(--text-secondary);
          font-size: 0.85rem;
        }

        .loading, .empty-state {
          text-align: center;
          color: var(--text-secondary);
          padding: 60px;
          background: var(--bg-secondary);
          border-radius: 8px;
        }

        .empty-state .hint {
          margin-top: 10px;
          font-size: 0.9rem;
        }

        .mounts-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
          gap: 20px;
        }

        .mount-card {
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          padding: 20px;
          transition: border-color 0.2s;
        }

        .mount-card.mounted {
          border-color: var(--accent-primary);
        }

        .mount-header {
          display: flex;
          align-items: center;
          gap: 15px;
          margin-bottom: 15px;
        }

        .mount-icon {
          color: var(--accent-primary);
        }

        .mount-info {
          flex: 1;
        }

        .mount-info h3 {
          margin-bottom: 4px;
        }

        .mount-type {
          font-size: 0.75rem;
          color: var(--text-secondary);
          background: var(--bg-tertiary);
          padding: 2px 8px;
          border-radius: 4px;
        }

        .mount-status {
          font-size: 0.85rem;
          padding: 4px 10px;
          border-radius: 12px;
        }

        .mount-details {
          margin-bottom: 15px;
        }

        .mount-details .detail {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid var(--border-color);
        }

        .mount-details .detail:last-child {
          border-bottom: none;
        }

        .mount-details .label {
          color: var(--text-secondary);
        }

        .mount-details .value {
          font-family: monospace;
          font-size: 0.9rem;
        }

        .mount-error {
          background: rgba(255, 107, 107, 0.1);
          color: var(--error);
          padding: 10px;
          border-radius: 6px;
          font-size: 0.9rem;
          margin-bottom: 15px;
        }

        .mount-actions {
          display: flex;
          gap: 10px;
        }

        .btn-danger {
          background: transparent;
          color: var(--error);
          border: 1px solid var(--error);
        }

        .btn-danger:hover {
          background: rgba(255, 107, 107, 0.1);
        }

        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal {
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          width: 90%;
          max-width: 500px;
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px;
          border-bottom: 1px solid var(--border-color);
        }

        .modal-header h2 {
          color: var(--accent-primary);
        }

        .close-btn {
          background: none;
          border: none;
          color: var(--text-secondary);
          font-size: 1.5rem;
          cursor: pointer;
        }

        .modal-content {
          padding: 20px;
        }

        .form-group {
          margin-bottom: 20px;
        }

        .form-group label {
          display: block;
          margin-bottom: 8px;
          color: var(--text-secondary);
        }

        .form-group input,
        .form-group select {
          width: 100%;
          padding: 10px 15px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          border-radius: 6px;
          color: var(--text-primary);
        }

        .form-group input:focus,
        .form-group select:focus {
          outline: none;
          border-color: var(--accent-primary);
        }

        .form-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid var(--border-color);
        }
      `}</style>
    </div>
  );
}

export default Mounts;
