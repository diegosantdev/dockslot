'use client';
import { useEffect, useState } from 'react';
import { Download, ExternalLink, KeyRound, Plus, Upload, Webhook } from 'lucide-react';
import type { Snapshot } from '@dockslot/domain';
import { api, zonedISO, localDate } from '../lib/api';
import { Badge } from './ui';
export function Settings({
  data,
  can,
  run,
  refresh,
  busy,
  localMode = false,
}: {
  data: Snapshot | null;
  can: (p: string) => boolean;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  refresh: () => Promise<void>;
  busy: boolean;
  localMode?: boolean;
}) {
  const [tab, setTab] = useState('facility'),
    [csv, setCsv] = useState(''),
    [dragging, setDragging] = useState(false),
    [fileName, setFileName] = useState(''),
    [preview, setPreview] = useState<any>(null),
    [audit, setAudit] = useState<any[]>([]),
    [hooks, setHooks] = useState<any[]>([]),
    [tokens, setTokens] = useState<any[]>([]),
    [deliveries, setDeliveries] = useState<any[]>([]),
    [members, setMembers] = useState<any[]>([]),
    [secret, setSecret] = useState('');
  const siteId = data?.site.id;
  const reload = async () => {
    if (siteId) {
      setAudit(await api(`/audit-events?siteId=${siteId}`));
    }
    if (can('admin')) {
      const [h, t, d, m] = await Promise.all([
        api('/integrations/webhooks'),
        api('/integrations/tokens'),
        api('/integrations/deliveries'),
        localMode ? Promise.resolve([]) : api('/members'),
      ]);
      setHooks(h);
      setTokens(t);
      setDeliveries(d);
      setMembers(m);
    }
  };
  useEffect(() => {
    void reload().catch(() => {});
  }, [siteId, data?.site.currentPlanVersion, tab]);
  return (
    <>
      <div className="settings-tabs">
        {[
          'facility',
          'docks',
          'integrations',
          'imports',
          ...(!localMode ? ['members'] : []),
          'audit',
        ].map((t) => (
          <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <section className="panel settings-panel">
        {tab === 'facility' && (
          <>
            <div className="section-heading">
              <div>
                <h2>Facility & operating calendar</h2>
                <p>Operating hours and scheduling rules use the facility timezone.</p>
              </div>
            </div>
            {data && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void run(
                    () =>
                      api(
                        `/sites/${siteId}`,
                        {
                          name: f.get('name'),
                          timezone: f.get('timezone'),
                          address: f.get('address'),
                          instructions: f.get('instructions'),
                          policy: {
                            ...data.site.policy,
                            open: f.get('open'),
                            close: f.get('close'),
                            weekdays: String(f.get('weekdays')).split(',').map(Number),
                            holidays: String(f.get('holidays'))
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                            noShowMinutes: Number(f.get('noShow')),
                            toleranceMinutes: Number(f.get('tolerance')),
                            portalAutoConfirm: f.get('auto') === 'on',
                          },
                        },
                        'PATCH',
                      ),
                    'Facility settings updated',
                  );
                }}
              >
                <div className="form-grid">
                  <label>
                    Name
                    <input name="name" defaultValue={data.site.name} required />
                  </label>
                  <label>
                    Timezone
                    <input name="timezone" defaultValue={data.site.timezone} required />
                  </label>
                  <label>
                    Opens
                    <input name="open" type="time" defaultValue={data.site.policy.open} required />
                  </label>
                  <label>
                    Closes
                    <input
                      name="close"
                      type="time"
                      defaultValue={data.site.policy.close}
                      required
                    />
                  </label>
                  <label>
                    Weekdays (Monday = 1)
                    <input name="weekdays" defaultValue={data.site.policy.weekdays.join(',')} />
                  </label>
                  <label>
                    Holidays (YYYY-MM-DD, separated by commas)
                    <input name="holidays" defaultValue={data.site.policy.holidays.join(',')} />
                  </label>
                  <label>
                    No-show grace (minutes)
                    <input
                      name="noShow"
                      type="number"
                      min={0}
                      defaultValue={data.site.policy.noShowMinutes}
                    />
                  </label>
                  <label>
                    On-time tolerance (minutes)
                    <input
                      name="tolerance"
                      type="number"
                      min={0}
                      defaultValue={data.site.policy.toleranceMinutes}
                    />
                  </label>
                  <label className="span-2">
                    Address
                    <input name="address" defaultValue={data.site.address} />
                  </label>
                  <label className="span-2">
                    Arrival instructions
                    <textarea name="instructions" defaultValue={data.site.instructions} />
                  </label>
                  <label className="checkbox span-2">
                    <input
                      type="checkbox"
                      name="auto"
                      defaultChecked={data.site.policy.portalAutoConfirm}
                    />
                    Automatically confirm carrier requests when a valid slot exists
                  </label>
                </div>
                <button className="button primary" disabled={busy || !can('manage')}>
                  Save facility
                </button>
              </form>
            )}
            <div className="detail-section">
              <h3>Add another site</h3>
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void run(async () => {
                    await api('/sites', { name: f.get('name'), timezone: f.get('timezone') });
                    await refresh();
                  }, 'Site created');
                }}
              >
                <input name="name" placeholder="Facility name" required />
                <input
                  name="timezone"
                  placeholder="America/Sao_Paulo"
                  defaultValue="America/Sao_Paulo"
                  required
                />
                <button className="button" disabled={busy || !can('admin')}>
                  <Plus size={15} />
                  Add site
                </button>
              </form>
            </div>
          </>
        )}
        {tab === 'docks' && data && (
          <>
            <h2>Docks & availability</h2>
            <p className="muted">
              Changing availability flags affected bookings. Review a recovery plan to move them.
            </p>
            <div className="dock-settings-grid">
              {data.docks.map((d) => (
                <div className="dock-setting" key={d.id}>
                  <div className="split">
                    <h3>{d.code}</h3>
                    <Badge>{d.operationType}</Badge>
                  </div>
                  <p>{d.capabilities.join(' · ') || 'Standard capabilities'}</p>
                  <label>
                    Operational status
                    <select
                      value={d.status}
                      disabled={!can('manage') || busy}
                      onChange={(e) =>
                        run(
                          () => api(`/docks/${d.id}`, { status: e.target.value }, 'PATCH'),
                          'Dock status updated',
                        )
                      }
                    >
                      <option value="available">Available</option>
                      <option value="maintenance">Maintenance</option>
                      <option value="out_of_service">Out of service</option>
                    </select>
                  </label>
                  <form
                    className="block-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void run(
                        () =>
                          api(`/docks/${d.id}/blocks`, {
                            startAt: zonedISO(
                              String(f.get('day')),
                              String(f.get('from')),
                              data.site.timezone,
                            ),
                            endAt: zonedISO(
                              String(f.get('day')),
                              String(f.get('to')),
                              data.site.timezone,
                            ),
                            reason: f.get('reason'),
                          }),
                        'Dock block recorded',
                      );
                    }}
                  >
                    <label>
                      Block date
                      <input
                        name="day"
                        type="date"
                        defaultValue={localDate(new Date(), data.site.timezone)}
                        required
                      />
                    </label>
                    <div className="form-grid">
                      <label>
                        From
                        <input name="from" type="time" defaultValue="09:00" required />
                      </label>
                      <label>
                        To
                        <input name="to" type="time" defaultValue="10:30" required />
                      </label>
                    </div>
                    <input name="reason" placeholder="Reason for block" minLength={3} required />
                    <button className="button" disabled={busy || !(can('manage') || can('dock'))}>
                      Block interval
                    </button>
                  </form>
                  {data.blocks
                    .filter((b) => b.dockId === d.id)
                    .map((b) => (
                      <div className="block-list" key={b.id}>
                        <span>{b.reason}</span>
                        <button
                          className="text-button"
                          disabled={!can('manage')}
                          onClick={() =>
                            run(
                              () => api(`/docks/${d.id}/blocks/${b.id}`, undefined, 'DELETE'),
                              'Block removed',
                            )
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                </div>
              ))}
            </div>
            <form
              className="detail-section"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void run(
                  () =>
                    api(`/sites/${siteId}/docks`, {
                      code: f.get('code'),
                      operationType: f.get('operationType'),
                      capabilities: String(f.get('capabilities'))
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    }),
                  'Dock created',
                );
              }}
            >
              <h3>Add a dock</h3>
              <div className="inline-form">
                <input name="code" placeholder="Dock 07" required />
                <select name="operationType">
                  <option value="both">Both operations</option>
                  <option value="inbound">Inbound</option>
                  <option value="outbound">Outbound</option>
                </select>
                <input name="capabilities" placeholder="Capabilities, comma separated" />
                <button className="button primary" disabled={busy || !can('manage')}>
                  Add dock
                </button>
              </div>
            </form>
          </>
        )}
        {tab === 'integrations' && (
          <>
            <h2>Integrations</h2>
            <p>
              Tokens are shown once. Webhooks are signed and delivered at least once with
              exponential retry.
            </p>
            <a
              href="/docs"
              className="button"
            >
              Open API reference <ExternalLink size={15} />
            </a>
            {secret && (
              <div className="secret-box">
                <strong>Copy this credential now</strong>
                <code>{secret}</code>
                <button
                  className="text-button"
                  onClick={() => {
                    void navigator.clipboard.writeText(secret);
                  }}
                >
                  Copy
                </button>
                <button className="text-button" onClick={() => setSecret('')}>
                  Dismiss
                </button>
              </div>
            )}
            <form
              className="detail-section"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void run(async () => {
                  const result = await api('/integrations/tokens', {
                    name: f.get('name'),
                    siteId,
                    scopes: String(f.get('scopes')).split(','),
                    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
                  });
                  setSecret(result.token);
                  await reload();
                });
              }}
            >
              <h3>
                <KeyRound size={16} /> Service tokens
              </h3>
              <div className="inline-form">
                <input name="name" placeholder="Integration name" required />
                <select name="scopes">
                  <option value="read">Read only</option>
                  <option value="read,plan">Read & planning</option>
                  <option value="read,gate">Read & gate</option>
                </select>
                <button className="button" disabled={busy || !can('admin')}>
                  Create 30-day token
                </button>
              </div>
              {tokens.map((t) => (
                <div key={t.id} className="list-row">
                  <span>
                    {t.name}
                    <small>
                      {t.scopes.join(', ')} · expires {new Date(t.expires_at).toLocaleDateString()}
                    </small>
                  </span>
                  <button
                    className="text-button"
                    disabled={!!t.revoked_at}
                    onClick={() =>
                      run(async () => {
                        await api(`/integrations/tokens/${t.id}`, undefined, 'DELETE');
                        await reload();
                      })
                    }
                  >
                    {t.revoked_at ? 'Revoked' : 'Revoke'}
                  </button>
                </div>
              ))}
            </form>
            <form
              className="detail-section"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void run(async () => {
                  const r = await api('/integrations/webhooks', {
                    url: f.get('url'),
                    eventFilters: String(f.get('events'))
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  });
                  setSecret(r.secret);
                  await reload();
                });
              }}
            >
              <h3>
                <Webhook size={16} /> Webhooks
              </h3>
              <div className="inline-form">
                <input
                  name="url"
                  type="url"
                  placeholder="https://your-system.example/events"
                  required
                />
                <input name="events" placeholder="Events (empty = all)" />
                <button className="button" disabled={busy || !can('admin')}>
                  Register webhook
                </button>
              </div>
              {hooks.map((h) => (
                <div className="list-row" key={h.id}>
                  <span>
                    {h.url}
                    <small>{h.event_filters.join(', ') || 'All organization events'}</small>
                  </span>
                  <button
                    className="text-button"
                    disabled={!h.active}
                    onClick={() =>
                      run(async () => {
                        await api(`/integrations/webhooks/${h.id}`, undefined, 'DELETE');
                        await reload();
                      })
                    }
                  >
                    {h.active ? 'Disable' : 'Disabled'}
                  </button>
                </div>
              ))}
            </form>
            <h3>Recent deliveries</h3>
            {deliveries.length ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Response</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td>
                        <Badge tone={d.status === 'delivered' ? 'green' : 'amber'}>
                          {d.status}
                        </Badge>
                      </td>
                      <td>{d.attempt}</td>
                      <td>
                        {d.response_code || '-'}
                        {d.status === 'failed' && (
                          <button
                            className="text-button"
                            onClick={() =>
                              run(async () => {
                                await api(`/integrations/deliveries/${d.id}/retry`, {});
                                await reload();
                              })
                            }
                          >
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No deliveries yet.</p>
            )}
            {siteId && (
              <div className="detail-section">
                <h3>Carrier request link</h3>
                <p>
                  One booking per link, valid for 7 days. The carrier sees only its own request.
                </p>
                <button
                  className="button"
                  disabled={busy || !can('plan')}
                  onClick={() =>
                    run(async () => {
                      const r = await api('/portal-tokens', {
                        siteId,
                        scopes: ['read', 'request'],
                        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
                      });
                      setSecret(window.location.origin + r.path);
                    })
                  }
                >
                  Create carrier link
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'imports' && siteId && (
          <>
            <div className="section-heading">
              <div>
                <h2>Import & export appointments</h2>
                <p>Validate rows with preview before importing them into the schedule.</p>
              </div>
              <a className="button" href={`/v1/exports/appointments.csv?siteId=${siteId}`}>
                <Download size={16} />
                Export CSV
              </a>
            </div>
            <label
              className={`dropzone ${dragging ? 'active' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) {
                  setCsv(await file.text());
                  setFileName(file.name);
                  setPreview(null);
                }
              }}
            >
              <span className="dropzone-icon">
                <Upload size={22} />
              </span>
              <strong>Drag & drop a CSV file here</strong>
              <span>or click to browse</span>
              {fileName && <span className="file-chip">{fileName}</span>}
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setCsv(await file.text());
                    setFileName(file.name);
                    setPreview(null);
                  }
                }}
              />
            </label>
            <label>
              CSV content
              <textarea
                rows={9}
                value={csv}
                placeholder="reference,carrierName,operationType,earliestStartAt,latestStartAt,durationMinutes"
                onChange={(e) => {
                  setCsv(e.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <div className="detail-actions">
              <button
                className="button"
                disabled={!csv || busy || !can('plan')}
                onClick={() =>
                  run(async () =>
                    setPreview(await api('/imports/appointments/preview', { siteId, csv })),
                  )
                }
              >
                Preview import
              </button>
              <button
                className="button primary"
                disabled={!preview || preview.errors.length > 0 || busy || !can('plan')}
                onClick={() =>
                  run(async () => {
                    await api('/imports/appointments/commit', {
                      siteId,
                      csv,
                      expectedPlanVersion: preview.planVersion,
                    });
                    setPreview(null);
                    setCsv('');
                  }, 'CSV import committed')
                }
              >
                Commit {preview?.rows.length || 0} rows
              </button>
            </div>
            {preview && (
              <div className="import-preview">
                <h3>
                  {preview.rows.length} valid rows · {preview.errors.length} errors
                </h3>
                {preview.errors.map((e: any, i: number) => (
                  <p className="form-error" key={i}>
                    Row {e.row}: {e.message}
                  </p>
                ))}
                {preview.rows.slice(0, 20).map((r: any) => (
                  <div className="list-row" key={r.appointment.id}>
                    <span>
                      {r.appointment.reference} · {r.appointment.carrierName}
                    </span>
                    <Badge>{r.appointment.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {tab === 'members' && (
          <>
            <h2>Workspace members</h2>
            <p>
              Roles are enforced by the API. Site-scoped members cannot access other facilities.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void run(async () => {
                  await api('/members', {
                    email: f.get('email'),
                    password: f.get('password'),
                    role: f.get('role'),
                    siteId: f.get('scope') === 'site' ? siteId : null,
                  });
                  await reload();
                }, 'Member created');
              }}
            >
              <div className="form-grid">
                <label>
                  Email
                  <input name="email" type="email" required />
                </label>
                <label>
                  Initial password
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label>
                  Role
                  <select name="role">
                    {[
                      'viewer',
                      'planner',
                      'gate_operator',
                      'dock_operator',
                      'site_manager',
                      'org_admin',
                    ].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Access scope
                  <select name="scope">
                    <option value="site">Current site</option>
                    <option value="organization">All organization sites</option>
                  </select>
                </label>
              </div>
              <button className="button primary" disabled={busy || !can('admin')}>
                Create member
              </button>
            </form>
            {members.map((m) => (
              <div className="list-row" key={m.id}>
                <span>
                  {m.email}
                  <small>{m.site_id || 'All sites'}</small>
                </span>
                <Badge>{m.role}</Badge>
                <button
                  className="text-button"
                  disabled={busy || !can('admin')}
                  onClick={() =>
                    run(async () => {
                      await api(`/members/${m.id}`, undefined, 'DELETE');
                      await reload();
                    }, 'Membership revoked')
                  }
                >
                  Revoke
                </button>
              </div>
            ))}
          </>
        )}
        {tab === 'audit' && (
          <>
            <h2>Audit trail</h2>
            <p>History of schedule, gate and dock actions.</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Source</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.action}
                      <small>{a.resource_id}</small>
                    </td>
                    <td>{a.actor}</td>
                    <td>{a.source}</td>
                    <td>{new Date(a.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </>
  );
}
