import { Routes, Route } from 'react-router-dom';
import Welcome from './pages/Welcome';
import Monitor from './pages/Monitor';
import Mounts from './pages/Mounts';
import Plugins from './pages/Plugins';
import Duplicates from './pages/Duplicates';
import ServiceNav from './components/ServiceNav';

function App() {
  return (
    <div className="app">
      <main className="main-content">
        <ServiceNav />
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/monitor" element={<Monitor />} />
          <Route path="/duplicates" element={<Duplicates />} />
          <Route path="/mounts" element={<Mounts />} />
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
