import { Routes, Route } from 'react-router-dom';
import Welcome from './pages/Welcome';
import Monitor from './pages/Monitor';
import Plugins from './pages/Plugins';
import ServiceNav from './components/ServiceNav';

// NOTE: Mounts page has been moved to meta-core dashboard
// NOTE: Duplicates page has been moved to meta-dup service (port 8183)

function App() {
  return (
    <div className="app">
      <main className="main-content">
        <ServiceNav />
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/monitor" element={<Monitor />} />
          <Route path="/plugins" element={<Plugins />} />
        </Routes>
      </main>

      <style>{`
        .main-content {
          padding: 30px;
          max-width: 1400px;
          margin: 0 auto;
        }
      `}</style>
    </div>
  );
}

export default App;
