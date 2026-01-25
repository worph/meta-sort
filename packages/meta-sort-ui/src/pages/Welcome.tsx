import { Link } from 'react-router-dom';

function Welcome() {
  return (
    <div className="welcome-page">
      <header className="welcome-header">
        <h1>meta-sort</h1>
        <p>File sorting and metadata extraction service</p>
      </header>

      <div className="quick-links">
        <div className="links-grid">
          <Link to="/monitor" className="link-card">
            <div className="link-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
            </div>
            <h3>Monitor</h3>
            <p>Real-time processing dashboard</p>
          </Link>

          <Link to="/duplicates" className="link-card">
            <div className="link-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="8" y="2" width="13" height="18" rx="2" ry="2"/>
                <rect x="3" y="4" width="13" height="18" rx="2" ry="2"/>
              </svg>
            </div>
            <h3>Duplicates</h3>
            <p>Find duplicate files</p>
          </Link>

          <Link to="/plugins" className="link-card">
            <div className="link-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <h3>Plugins</h3>
            <p>Manage metadata plugins</p>
          </Link>

          <a href="/editor/" className="link-card">
            <div className="link-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </div>
            <h3>Editor</h3>
            <p>Edit file metadata</p>
          </a>
        </div>
      </div>

      <style>{`
        .welcome-page {
          max-width: 1000px;
          margin: 0 auto;
        }

        .welcome-header {
          text-align: center;
          margin-bottom: 40px;
        }

        .welcome-header h1 {
          font-size: 3rem;
          background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          margin-bottom: 10px;
        }

        .welcome-header p {
          color: var(--text-secondary);
          font-size: 1.2rem;
        }

        .links-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
        }

        .link-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 30px 20px;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          text-align: center;
          text-decoration: none;
          transition: all 0.2s;
        }

        .link-card:hover {
          border-color: var(--accent-primary);
          transform: translateY(-2px);
          text-decoration: none;
        }

        .link-icon {
          color: var(--accent-primary);
          margin-bottom: 15px;
        }

        .link-card h3 {
          color: var(--text-primary);
          margin-bottom: 8px;
        }

        .link-card p {
          color: var(--text-secondary);
          font-size: 0.9rem;
        }
      `}</style>
    </div>
  );
}

export default Welcome;
