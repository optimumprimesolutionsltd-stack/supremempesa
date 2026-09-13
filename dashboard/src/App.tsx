import { useEffect, useState } from 'react';
import { Reconciliation } from './pages/Reconciliation.js';
import { ReviewQueue } from './pages/ReviewQueue.js';
import { Transactions } from './pages/Transactions.js';
import { api, getOperator, getToken, setOperator, setToken, type Health } from './lib/api.js';

type Tab = 'review' | 'transactions' | 'reconciliation';

export function App() {
  const [tab, setTab] = useState<Tab>('review');
  const [health, setHealth] = useState<Health | null>(null);
  const [needsToken, setNeedsToken] = useState(!getToken());

  useEffect(() => {
    if (needsToken) return;
    const load = () => api.health().then(setHealth).catch(() => setHealth(null));
    void load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [needsToken]);

  if (needsToken) return <TokenGate onSaved={() => setNeedsToken(false)} />;

  return (
    <div className="app">
      <header className="top">
        <h1>M-Pesa · Tally reconciliation</h1>
        <span className="spacer" />
        <span className="muted small">signed in as {getOperator() || 'operator'}</span>
        <button
          className="action"
          onClick={() => {
            setToken('');
            setNeedsToken(true);
          }}
        >
          Sign out
        </button>
      </header>

      {health && <HealthCards health={health} />}

      <nav className="tabs">
        <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
          Review queue
          {health && health.unmatchedCount + health.ambiguousCount > 0
            ? ` (${health.unmatchedCount + health.ambiguousCount})`
            : ''}
        </button>
        <button className={tab === 'transactions' ? 'active' : ''} onClick={() => setTab('transactions')}>
          Transactions
        </button>
        <button className={tab === 'reconciliation' ? 'active' : ''} onClick={() => setTab('reconciliation')}>
          Reconciliation
        </button>
      </nav>

      {tab === 'review' && <ReviewQueue />}
      {tab === 'transactions' && <Transactions />}
      {tab === 'reconciliation' && <Reconciliation />}
    </div>
  );
}

/**
 * Operational health at a glance. Callback silence is deliberately the first
 * card: a quiet webhook looks exactly like a quiet business day, and it is the
 * failure most likely to go unnoticed for a week.
 */
function HealthCards({ health }: { health: Health }) {
  const silence = health.minutesSinceLastCallback;
  const silent = silence !== null && silence > 120;

  return (
    <div className="cards">
      <div className={`card ${silent ? 'alert' : ''}`}>
        <div className="label">Last M-Pesa callback</div>
        <div className="value">{silence === null ? '—' : silence < 60 ? `${silence}m` : `${Math.round(silence / 60)}h`}</div>
      </div>
      <div className={`card ${health.unmatchedCount > 0 ? 'warn' : ''}`}>
        <div className="label">Needs review</div>
        <div className="value">{health.unmatchedCount}</div>
      </div>
      <div className={`card ${health.ambiguousCount > 0 ? 'warn' : ''}`}>
        <div className="label">Ambiguous</div>
        <div className="value">{health.ambiguousCount}</div>
      </div>
      <div className={`card ${health.stuckPosts > 0 ? 'alert' : ''}`}>
        <div className="label">Stuck in Tally queue</div>
        <div className="value">{health.stuckPosts}</div>
      </div>
      <div className={`card ${health.failedPosts > 0 ? 'alert' : ''}`}>
        <div className="label">Post failures</div>
        <div className="value">{health.failedPosts}</div>
      </div>
    </div>
  );
}

function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [token, setTokenValue] = useState('');
  const [name, setName] = useState(getOperator());

  return (
    <div className="app" style={{ maxWidth: 420, paddingTop: 80 }}>
      <div className="panel">
        <h2>Sign in</h2>
        <div style={{ padding: 16 }} className="stack">
          <label className="small muted">Your name (recorded in the audit trail)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane" />
          <label className="small muted" style={{ marginTop: 10 }}>
            Admin API token
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setTokenValue(e.target.value)}
            placeholder="ADMIN_API_TOKEN"
          />
          <button
            className="action primary"
            style={{ marginTop: 14 }}
            disabled={!token || !name}
            onClick={() => {
              setToken(token);
              setOperator(name);
              onSaved();
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
