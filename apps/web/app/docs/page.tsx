'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronDown, Code2, Play, Search } from 'lucide-react';

type Endpoint = {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters?: any[];
  requestBody?: any;
  responses?: Record<string, any>;
};

export default function ApiDocsPage() {
  const [spec, setSpec] = useState<any>(null);
  const [query, setQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState('ALL');
  const [openKey, setOpenKey] = useState<string | null>('GET /v1/sites');
  const [testBody, setTestBody] = useState('{}');
  const [testResult, setTestResult] = useState<{ status: number; body: string } | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    void fetch('/v1/openapi.json')
      .then((r) => r.json())
      .then(setSpec)
      .catch(() => {});
  }, []);

  const endpoints: Endpoint[] = [];
  if (spec?.paths) {
    for (const [path, methods] of Object.entries<any>(spec.paths)) {
      for (const [method, info] of Object.entries<any>(methods)) {
        if (['get', 'post', 'patch', 'put', 'delete'].includes(method.toLowerCase())) {
          endpoints.push({
            method: method.toUpperCase(),
            path,
            summary: info.summary || '',
            description: info.description || '',
            parameters: info.parameters || [],
            requestBody: info.requestBody,
            responses: info.responses || {},
          });
        }
      }
    }
  }

  const filtered = endpoints.filter((ep) => {
    if (methodFilter !== 'ALL' && ep.method !== methodFilter) return false;
    if (!query) return true;
    return `${ep.method} ${ep.path} ${ep.summary} ${ep.description}`
      .toLowerCase()
      .includes(query.toLowerCase());
  });

  async function runEndpoint(ep: Endpoint) {
    setRunning(true);
    setTestResult(null);
    try {
      const hasBody = ['POST', 'PATCH', 'PUT'].includes(ep.method);
      const res = await fetch(ep.path, {
        method: ep.method,
        credentials: 'same-origin',
        headers: hasBody ? { 'Content-Type': 'application/json' } : {},
        body: hasBody ? testBody : undefined,
      });
      const text = await res.text();
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
      setTestResult({ status: res.status, body: formatted });
    } catch (e) {
      setTestResult({ status: 0, body: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="api-docs-shell">
      <header className="topbar api-docs-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <a className="brand" href="/">
            <span className="brand-icon">
              <img src="/logo.png" alt="" width={26} height={26} />
            </span>
            <span className="brand-name">DockSlot</span>
          </a>
          <div className="breadcrumb">
            <span>/</span> <strong>API Reference</strong>
          </div>
        </div>
        <div className="topbar-right">
          <a className="button" href="/v1/openapi.json" target="_blank" rel="noreferrer">
            <Code2 size={15} />
            API Schema (JSON)
          </a>
          <a className="button primary" href="/">
            <ArrowLeft size={15} />
            Back to board
          </a>
        </div>
      </header>

      <main className="content api-docs-content">
        <div className="page-heading">
          <div>
            <h1>API Reference</h1>
            <p>
              REST endpoints for scheduling, gate operations, recovery proposals, and webhooks. All
              timestamps use ISO 8601 UTC.
            </p>
          </div>
          <div className="heading-actions">
            <span className="badge">REST v1</span>
            <span className="badge">v{spec?.info?.version || '0.1.0'}</span>
          </div>
        </div>

        <section className="panel">
          <div className="board-toolbar">
            <div className="segmented">
              {['ALL', 'GET', 'POST', 'PATCH', 'DELETE'].map((m) => (
                <button
                  key={m}
                  className={methodFilter === m ? 'selected' : ''}
                  onClick={() => setMethodFilter(m)}
                >
                  {m === 'ALL' ? 'All methods' : m}
                </button>
              ))}
            </div>
            <div className="search" style={{ minWidth: 280 }}>
              <Search size={15} />
              <input
                aria-label="Filter endpoints"
                placeholder="Search path or method..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="api-endpoint-list">
            {filtered.map((ep) => {
              const key = `${ep.method} ${ep.path}`;
              const isOpen = openKey === key;
              const schema = ep.requestBody?.content?.['application/json']?.schema;
              const responses = Object.keys(ep.responses || {});
              return (
                <div key={key} className={`api-endpoint-card ${isOpen ? 'open' : ''}`}>
                  <button
                    type="button"
                    className="api-endpoint-head"
                    onClick={() => {
                      setOpenKey(isOpen ? null : key);
                      setTestResult(null);
                    }}
                  >
                    <span className={`api-method ${ep.method.toLowerCase()}`}>{ep.method}</span>
                    <code className="api-path">{ep.path}</code>
                    <span className="api-summary">
                      {responses.length ? `Responses: ${responses.join(', ')}` : ''}
                    </span>
                    <ChevronDown size={15} className={`dropdown-chevron ${isOpen ? 'rot' : ''}`} />
                  </button>
                  {isOpen && (
                    <div className="api-endpoint-body">
                      <div className="api-grid">
                        <div>
                          <h4>Request schema</h4>
                          {schema ? (
                            <pre className="api-code">{JSON.stringify(schema, null, 2)}</pre>
                          ) : ep.parameters?.length ? (
                            <pre className="api-code">{JSON.stringify(ep.parameters, null, 2)}</pre>
                          ) : (
                            <p className="muted">No request body required.</p>
                          )}
                        </div>
                        <div>
                          <div className="split">
                            <h4>Interactive request</h4>
                            {!ep.path.includes(':') && (
                              <button
                                type="button"
                                className="button primary"
                                disabled={running}
                                onClick={() => void runEndpoint(ep)}
                              >
                                <Play size={13} />
                                {running ? 'Running...' : 'Send request'}
                              </button>
                            )}
                          </div>
                          {['POST', 'PATCH', 'PUT'].includes(ep.method) &&
                            !ep.path.includes(':') && (
                              <textarea
                                rows={4}
                                value={testBody}
                                onChange={(e) => setTestBody(e.target.value)}
                                className="api-body-input"
                              />
                            )}
                          {testResult ? (
                            <pre className="api-code">
                              Status {testResult.status}
                              {'\n\n'}
                              {testResult.body}
                            </pre>
                          ) : (
                            <pre className="api-code">
                              {`curl -X ${ep.method} http://localhost:4000${ep.path} \\\n  -H "Authorization: Bearer <token>"`}
                            </pre>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
