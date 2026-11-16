import { useEffect, useState } from 'react';

import { useTheme } from '@/hooks/theme.context';
import { api } from '@/lib/api';
import { Discovery } from '@/views/Discovery';
import { Inbox } from '@/views/Inbox';
import { RequestView } from '@/views/RequestView';

type Route = { tab: 'discovery' } | { tab: 'requests'; id: number | null };

/** Routes: #/discovery (the chat), #/ (all requests) and #/requests/<QUERY_MASTER_ID>. Hash routes need no rewrites. */
function route(): Route {
  if (/^#\/discovery/.test(window.location.hash)) return { tab: 'discovery' };
  const m = window.location.hash.match(/^#\/requests\/(\d+)/);
  return { tab: 'requests', id: m ? Number(m[1]) : null };
}

function App() {
  const { isDark, toggleTheme } = useTheme();
  const [at, setAt] = useState<Route>(route);
  // Once opened, the Discovery tab stays mounted (hidden on Requests), so the conversation survives a look at a request.
  const [discoveryOpened, setDiscoveryOpened] = useState(() => route().tab === 'discovery');
  const [viewer, setViewer] = useState<string>('');

  useEffect(() => {
    const onHash = () => {
      const next = route();
      setAt(next);
      if (next.tab === 'discovery') setDiscoveryOpened(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { api.whoAmI().then(setViewer).catch(() => setViewer('')); }, []);

  const setTheme = (dark: boolean) => {
    if (dark !== isDark) toggleTheme();
    try { localStorage.setItem('cohort-theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
  };
  const discovery = at.tab === 'discovery';

  return (
    <>
      <header className={discovery ? 'topbar disc-gutter' : 'topbar'}>
        <div className="topbar-inner">
          <a className="brand" href={discovery ? '#/discovery' : '#/'}>
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-text">{discovery ? 'Cohort Discovery' : 'Cohort data requests'}</span>
            <span className="brand-sub">{discovery ? 'i2b2 on Microsoft Fabric' : 'Review and approval'}</span>
          </a>
          <div className="seg" role="tablist" aria-label="Section">
            <button type="button" role="tab" aria-selected={discovery} aria-pressed={discovery}
              onClick={() => { window.location.hash = '#/discovery'; }}>Discovery</button>
            <button type="button" role="tab" aria-selected={!discovery} aria-pressed={!discovery}
              onClick={() => { window.location.hash = '#/'; }}>Requests</button>
          </div>
          <div className="actions">
            <span className="source-id mono" title="Fabric workspace">MedicalCohortDemo</span>
            {viewer ? <span className="source-id" title="Signed in">{viewer}</span> : null}
            <div className="seg" role="group" aria-label="Colour theme">
              <button type="button" aria-pressed={!isDark} onClick={() => setTheme(false)}>Light</button>
              <button type="button" aria-pressed={isDark} onClick={() => setTheme(true)}>Dark</button>
            </div>
          </div>
        </div>
      </header>
      {discoveryOpened ? (
        <main style={discovery ? undefined : { display: 'none' }}><Discovery /></main>
      ) : null}
      {discovery ? null : (
        <main style={{ padding: '36px var(--pad) 64px', maxWidth: 1240 }}>
          {at.id === null ? (
            <Inbox open={(n) => { window.location.hash = `#/requests/${n}`; }} />
          ) : (
            <RequestView key={at.id} id={at.id} back={() => { window.location.hash = '#/'; }} />
          )}
        </main>
      )}
    </>
  );
}

export default App;
