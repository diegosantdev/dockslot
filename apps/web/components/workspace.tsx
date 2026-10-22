'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  DoorOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Route,
  Truck,
  X,
  LockKeyhole,
  AlertTriangle,
  Download,
} from 'lucide-react';
import type { Appointment, Proposal, Site, Snapshot } from '@dockslot/domain';
import { api, ApiError, labels, localDate, time, zonedISO, shiftBounds } from '../lib/api';
import { Badge, Busy, Empty, Modal, Select, Stat } from './ui';
import { Board } from './board';
import { Booking, Detail } from './booking';
import { Settings } from './settings';
type Calendar = Snapshot & { conflicts: { appointmentId: string; reasons: string[] }[] };
const icons = {
  board: CalendarDays,
  recovery: Route,
  gate: Truck,
  metrics: ChartNoAxesCombined,
  settings: Settings2,
};
export default function Workspace({
  initialSite = '',
  initialView = 'board',
}: {
  initialSite?: string;
  initialView?: string;
}) {
  const [user, setUser] = useState<any>(null),
    [boot, setBoot] = useState(true),
    [sites, setSites] = useState<Site[]>([]),
    [siteId, setSiteId] = useState(initialSite),
    [data, setData] = useState<Calendar | null>(null),
    [view, setView] = useState(initialView === 'overview' ? 'board' : initialView),
    [locale, setLocale] = useState<'en' | 'pt'>('en');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(false),
    [date, setDate] = useState(''),
    [search, setSearch] = useState(''),
    [operation, setOperation] = useState('all'),
    [selected, setSelected] = useState<string | null>(null),
    [booking, setBooking] = useState(false),
    [proposal, setProposal] = useState<Proposal | null>(null),
    [mobile, setMobile] = useState(false),
    [collapsed, setCollapsed] = useState(true),
    [metrics, setMetrics] = useState<any>(null),
    [week, setWeek] = useState(false),
    [zoom, setZoom] = useState(60),
    [statusFilter, setStatusFilter] = useState('all');
  const t = labels[locale];
  const load = useCallback(async () => {
    const me = await api('/auth/me');
    setUser(me);
    const list = await api<Site[]>('/sites');
    setSites(list);
    setSiteId((current) => (list.some((s) => s.id === current) ? current : list[0]?.id || ''));
  }, []);
  useEffect(() => {
    if (siteId && typeof window !== 'undefined') {
      const target = `/app/sites/${siteId}/${view}`;
      if (window.location.pathname !== target) {
        window.history.replaceState({}, '', target);
      }
    }
  }, [siteId, view]);
  useEffect(() => {
    load()
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) setError(e.message);
      })
      .finally(() => setBoot(false));
  }, [load]);
  const refresh = useCallback(async () => {
    if (!siteId) return;
    const [calendar, stats] = await Promise.all([
      api<Calendar>(`/sites/${siteId}/calendar`),
      api(`/sites/${siteId}/metrics`),
    ]);
    setData(calendar);
    setMetrics(stats);
    setDate((d) => d || localDate(new Date(), calendar.site.timezone));
  }, [siteId]);
  useEffect(() => {
    if (user && siteId) {
      setData(null);
      refresh().catch((e) => setError(e.message));
      setProposal(null);
    }
  }, [user, siteId, refresh]);
  useEffect(() => {
    if (!user || !siteId) return;
    const stream = new EventSource(`/v1/events/stream?siteId=${siteId}`);
    let timer: ReturnType<typeof setTimeout>;
    stream.onopen = () => {
      setOnline(true);
      void refresh();
    };
    stream.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh().catch(() => setOnline(false)), 200);
    };
    stream.onerror = () => setOnline(false);
    const fallback = setInterval(() => void refresh().catch(() => {}), 30000);
    return () => {
      stream.close();
      clearTimeout(timer);
      clearInterval(fallback);
    };
  }, [user, siteId, refresh]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(''), 6000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  async function run(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      if (success) setNotice(success);
    } catch (e) {
      setError(
        (e as Error).message +
          (e instanceof ApiError && Array.isArray(e.details)
            ? ` · ${e.details.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('; ')}`
            : ''),
      );
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: string) {
    setView(next);
    setMobile(false);
  }
  const can = (permission: string) =>
    user?.grants?.some(
      (g: any) => (!g.siteId || g.siteId === siteId) && g.permissions.includes(permission),
    );
  useEffect(() => {
    const canPlan = user?.grants?.some(
      (g: any) => (!g.siteId || g.siteId === siteId) && g.permissions.includes('plan'),
    );
    if (view === 'recovery' && data && date && !proposal && !busy && canPlan) {
      void api<Proposal>(`/sites/${siteId}/replans`, {
        startAt: shiftBounds(date, data.site).startAt,
        endAt: shiftBounds(date, data.site).endAt,
        reason: data.conflicts.length ? 'late_arrival' : 'manual',
      })
        .then(setProposal)
        .catch(() => {});
    }
  }, [view, data, date, proposal, busy, siteId, user]);
  if (boot) return <Busy />;
  if (!user && error)
    return (
      <div className="connection-error">
        <h1>DockSlot is unavailable</h1>
        <p>{error}</p>
        <button className="button" onClick={() => window.location.reload()}>
          Retry connection
        </button>
      </div>
    );
  if (!user)
    return <Login error={error} onLogin={() => load().catch((e) => setError(e.message))} />;
  const zone = data?.site.timezone || 'UTC';
  const appointments = (data?.appointments || []).filter((a) => {
    const alloc = data?.allocations.find((x) => x.appointmentId === a.id);
    const day = localDate(new Date(alloc?.startAt || a.earliestStartAt), zone);
    const end = new Date(`${date}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    return (
      (!date || day === date || (week && day >= date && day <= end.toISOString().slice(0, 10))) &&
      (operation === 'all' || a.operationType === operation) &&
      (statusFilter === 'all' ||
        a.status === statusFilter ||
        data?.visits.find((v) => v.appointmentId === a.id)?.status === statusFilter) &&
      `${a.reference} ${a.carrierName} ${a.vehicle}`.toLowerCase().includes(search.toLowerCase())
    );
  });
  const visitStatus = (a: Appointment) =>
    data?.visits.find((v) => v.appointmentId === a.id)?.status || 'expected';
  const waiting = appointments.filter((a) => visitStatus(a) === 'checked_in').length,
    inService = appointments.filter((a) => visitStatus(a) === 'in_service').length,
    done = appointments.filter((a) =>
      ['service_completed', 'checked_out'].includes(visitStatus(a)),
    ).length;
  const generate = () =>
    run(async () => {
      if (!data || !date) return;
      const result = await api<Proposal>(`/sites/${siteId}/replans`, {
        startAt: shiftBounds(date, data.site).startAt,
        endAt: shiftBounds(date, data.site).endAt,
        reason: data.conflicts.length ? 'late_arrival' : 'manual',
      });
      setProposal(result);
      navigate('recovery');
    });
  return (
    <div className={`shell ${collapsed ? 'compact' : ''}`}>
      <aside
        className={`sidebar ${mobile ? 'open' : ''}`}
        onMouseEnter={() => setCollapsed(false)}
        onMouseLeave={() => setCollapsed(true)}
      >
        <div className="sidebar-header">
          <a className="brand" href="/" aria-label="DockSlot home">
            <span className="brand-icon">
              <img src="/logo.png" alt="" width={26} height={26} />
            </span>
            <span className="brand-name">DockSlot</span>
          </a>
        </div>
        <div className="nav-label">Workspace</div>
        <nav>
          {Object.entries(icons).map(([key, Icon]) => (
            <button
              key={key}
              className={`nav-item ${view === key ? 'active' : ''}`}
              title={t[key as keyof typeof icons]}
              aria-label={t[key as keyof typeof icons]}
              aria-current={view === key ? 'page' : undefined}
              onClick={() => navigate(key)}
            >
              <Icon size={18} />
              <span>{t[key as keyof typeof icons]}</span>
              {key === 'recovery' && !!data?.conflicts.length && (
                <span className="nav-count">{data.conflicts.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {user.localMode ? (
            <div className="local-instance" title="Local workspace">
              <Monitor size={17} />
              <div>
                Local workspace<small>Stored on this computer</small>
              </div>
            </div>
          ) : (
            <button
              className="user-profile"
              onClick={() =>
                void api('/auth/logout', {}).then(() => {
                  setUser(null);
                  setData(null);
                })
              }
            >
              <span className="avatar">OP</span>
              <span>
                Workspace operator<small>Sign out</small>
              </span>
              <LogOut size={16} />
            </button>
          )}
          <div className="sidebar-meta">
            <span>DockSlot 0.1</span>
            <span>Apache-2.0</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMobile(!mobile)}
            aria-label="Toggle navigation"
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            DockSlot <span>/</span> <strong>{t[view as keyof typeof icons] || view}</strong>
          </div>
          <div className="topbar-right">
            <button className="language" onClick={() => setLocale(locale === 'en' ? 'pt' : 'en')}>
              {locale.toUpperCase()}
            </button>
            <a
              className="icon-button"
              href="http://localhost:4000/docs"
              target="_blank"
              aria-label="API documentation"
            >
              <CircleHelp size={18} />
            </a>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <h1>{t[view as keyof typeof icons] || 'Dock board'}</h1>
              <p>
                {view === 'board'
                  ? t.title
                  : view === 'recovery'
                    ? 'Review schedule changes before applying them.'
                    : view === 'gate'
                      ? 'Arrivals, service and departures.'
                      : view === 'settings'
                        ? 'Configure your facility and connect your systems.'
                        : 'Recorded activity and dock utilization.'}
              </p>
            </div>
            <div className="heading-actions">
              <Select
                ariaLabel="Site"
                value={siteId}
                options={sites.map((s) => ({ value: s.id, label: s.name }))}
                onChange={(next) => {
                  setSiteId(next);
                  setDate('');
                }}
              />
              {can('plan') && !!data && (
                <button className="button primary" onClick={() => setBooking(true)}>
                  <Plus size={17} />
                  {t.newBooking}
                </button>
              )}
            </div>
          </div>
          {error && (
            <div className="alert error" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="toast" role="status">
              <Check size={17} />
              {notice}
            </div>
          )}
          {!siteId ? (
            <Empty
              title="No facilities yet"
              text="Create a site in Settings to begin scheduling."
            />
          ) : !data ? (
            <Busy />
          ) : (
            <>
              {['board', 'gate'].includes(view) && (
                <div className="stats-grid">
                  <Stat
                    label="Scheduled today"
                    value={appointments.length}
                    note={`${appointments.filter((a) => a.operationType === 'inbound').length} inbound · ${appointments.filter((a) => a.operationType === 'outbound').length} outbound`}
                  />
                  <Stat
                    label="In the yard"
                    value={waiting}
                    note="Checked in · ready for service"
                    accent="amber"
                  />
                  <Stat
                    label="In service"
                    value={inService}
                    note={`${data.docks.filter((d) => d.status === 'available').length} operational docks`}
                    accent="blue"
                  />
                  <Stat
                    label="Completed"
                    value={done}
                    note="Service completed this shift"
                    accent="green"
                  />
                </div>
              )}
              {!!data.conflicts.length && view === 'board' && (
                <div className="incident">
                  <span className="incident-icon">
                    <AlertTriangle size={20} />
                  </span>
                  <div>
                    <strong>
                      {data.conflicts.length} appointment{data.conflicts.length === 1 ? '' : 's'}{' '}
                      need attention
                    </strong>
                    <p>
                      The current plan has a reported delay or dock conflict. Review a recovery
                      proposal before making changes.
                    </p>
                  </div>
                  <button className="button" disabled={busy || !can('plan')} onClick={generate}>
                    <Route size={16} />
                    Generate recovery plan
                    <ArrowUpRight size={16} />
                  </button>
                </div>
              )}
              {['board', 'gate'].includes(view) && (
                <section className="panel">
                  <div className="board-toolbar">
                    <div className="date-picker">
                      <button
                        className="icon-button"
                        aria-label="Previous day"
                        onClick={() => {
                          const d = new Date(date + 'T12:00Z');
                          d.setUTCDate(d.getUTCDate() - 1);
                          setDate(d.toISOString().slice(0, 10));
                        }}
                      >
                        <ChevronLeft size={17} />
                      </button>
                      <input
                        aria-label="Schedule date"
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                      <button
                        className="icon-button"
                        aria-label="Next day"
                        onClick={() => {
                          const d = new Date(date + 'T12:00Z');
                          d.setUTCDate(d.getUTCDate() + 1);
                          setDate(d.toISOString().slice(0, 10));
                        }}
                      >
                        <ChevronRight size={17} />
                      </button>
                      <button
                        className="today"
                        onClick={() => setDate(localDate(new Date(), zone))}
                      >
                        {t.today}
                      </button>
                    </div>
                    <div className="toolbar-filters">
                      <Select
                        ariaLabel="Operation filter"
                        value={operation}
                        onChange={setOperation}
                        options={[
                          { value: 'all', label: 'All operations' },
                          { value: 'inbound', label: 'Inbound' },
                          { value: 'outbound', label: 'Outbound' },
                        ]}
                      />
                      <Select
                        ariaLabel="Status filter"
                        value={statusFilter}
                        onChange={setStatusFilter}
                        options={[
                          { value: 'all', label: 'All statuses' },
                          { value: 'requested', label: 'Requested' },
                          { value: 'confirmed', label: 'Confirmed' },
                          { value: 'checked_in', label: 'Checked in' },
                          { value: 'in_service', label: 'In service' },
                          { value: 'fulfilled', label: 'Fulfilled' },
                          { value: 'cancelled', label: 'Cancelled' },
                          { value: 'no_show', label: 'No-show' },
                        ]}
                      />
                      <div className="segmented">
                        <button className={!week ? 'selected' : ''} onClick={() => setWeek(false)}>
                          Day
                        </button>
                        <button className={week ? 'selected' : ''} onClick={() => setWeek(true)}>
                          Week
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="board-subbar">
                    <div>
                      <strong>{data.site.name}</strong>
                      <span>
                        {data.docks.length} docks · {zone}
                      </span>
                    </div>
                    <div className="search">
                      <Search size={15} />
                      <input
                        aria-label="Search appointments"
                        placeholder="Search carrier, reference, plate..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  {view === 'gate' ? (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Appointment / carrier</th>
                          <th>Vehicle</th>
                          <th>Arrival / ETA</th>
                          <th>Visit status</th>
                          <th>Next action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {appointments.map((a) => {
                          const status = visitStatus(a),
                            action = (
                              {
                                expected: 'check-in',
                                checked_in: 'start-service',
                                in_service: 'complete-service',
                                service_completed: 'check-out',
                              } as Record<string, string>
                            )[status];
                          return (
                            <tr key={a.id}>
                              <td>
                                <button className="text-button" onClick={() => setSelected(a.id)}>
                                  {a.reference}
                                </button>
                                <small>{a.carrierName}</small>
                              </td>
                              <td>{a.vehicle || '-'}</td>
                              <td>{time(a.etaAt, zone)}</td>
                              <td>
                                <Badge
                                  tone={
                                    status === 'in_service'
                                      ? 'blue'
                                      : status === 'checked_in'
                                        ? 'amber'
                                        : 'neutral'
                                  }
                                >
                                  {status.replaceAll('_', ' ')}
                                </Badge>
                              </td>
                              <td>
                                {action && (
                                  <button
                                    className="button"
                                    disabled={
                                      busy ||
                                      !can(
                                        ['check-in', 'check-out'].includes(action)
                                          ? 'gate'
                                          : 'dock',
                                      ) ||
                                      !['confirmed', 'fulfilled'].includes(a.status)
                                    }
                                    onClick={() =>
                                      run(
                                        () => api(`/appointments/${a.id}/${action}`, {}),
                                        `${a.reference} · ${action} recorded`,
                                      )
                                    }
                                  >
                                    {action.replaceAll('-', ' ')}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <Board
                      data={data}
                      appointments={appointments}
                      date={date}
                      week={week}
                      zoom={zoom}
                      onSelect={setSelected}
                      canMove={can('plan')}
                      onMove={(appointmentId, dockId, startAt) => {
                        setSelected(appointmentId);
                        setNotice(
                          'Select a new slot in the appointment panel and confirm the move.',
                        );
                        window.dispatchEvent(
                          new CustomEvent('dockslot-move', {
                            detail: { appointmentId, dockId, startAt },
                          }),
                        );
                      }}
                    />
                  )}
                  {!appointments.length && (
                    <Empty
                      title="No appointments found"
                      text="Change the date or filters, or create a new appointment."
                    />
                  )}
                  <div className="board-footer">
                    <div className="legend">
                      <span>
                        <i className="inbound" />
                        Inbound
                      </span>
                      <span>
                        <i className="outbound" />
                        Outbound
                      </span>
                      <span>
                        <i className="service" />
                        In service
                      </span>
                      <span>
                        <LockKeyhole size={12} />
                        Locked
                      </span>
                      <span>
                        <i className="blocked" />
                        Blocked
                      </span>
                    </div>
                    <div className="zoom">
                      Grid{' '}
                      <Select
                        ariaLabel="Timeline grid"
                        className="up"
                        value={zoom}
                        onChange={(val) => setZoom(Number(val))}
                        options={[
                          { value: 15, label: '15 min' },
                          { value: 30, label: '30 min' },
                          { value: 60, label: '60 min' },
                        ]}
                      />
                    </div>
                  </div>
                </section>
              )}
              {view === 'recovery' && (
                <>
                  <div className="recovery-intro">
                    <div>
                      <h2>Replan the schedule</h2>
                      <p>
                        Locks and active services stay in place. Changes are applied only after
                        approval.
                      </p>
                    </div>
                    <input
                      type="date"
                      aria-label="Recovery date"
                      value={date}
                      onChange={(e) => {
                        setDate(e.target.value);
                        setProposal(null);
                      }}
                    />
                    <button
                      className="button primary"
                      disabled={busy || !can('plan')}
                      onClick={generate}
                    >
                      <RefreshCw size={16} />
                      {busy
                        ? 'Calculating...'
                        : proposal
                          ? 'Rerun recovery'
                          : 'Generate recovery plan'}
                    </button>
                  </div>
                  {proposal ? (
                    <>
                      <div className="stats-grid">
                        <Stat
                          label="Appointments moved"
                          value={proposal.metrics.movedCount}
                          note="Changes require your approval"
                        />
                        <Stat
                          label="Projected waiting"
                          value={
                            proposal.metrics.totalProjectedWaitingMinutes === null
                              ? '-'
                              : `${Math.round(proposal.metrics.totalProjectedWaitingMinutes)} min`
                          }
                          note={`Baseline: ${proposal.metrics.baselineProjectedWaitingMinutes ?? 'unknown'} min`}
                        />
                        <Stat
                          label="Unscheduled"
                          value={proposal.unscheduled.length}
                          note="Must resolve before applying"
                          accent={proposal.unscheduled.length ? 'amber' : 'green'}
                        />
                        <Stat
                          label="Hard violations"
                          value={proposal.metrics.hardConstraintViolations}
                          note={
                            proposal.applicable
                              ? 'Proposal can be applied'
                              : 'Proposal cannot be applied'
                          }
                          accent={proposal.applicable ? 'green' : 'amber'}
                        />
                      </div>
                      {data.conflicts.length > 0 && (
                        <div className="incident">
                          <span className="incident-icon">
                            <AlertTriangle size={20} />
                          </span>
                          <div>
                            <strong>
                              {data.conflicts.length} active conflict
                              {data.conflicts.length === 1 ? '' : 's'} detected
                            </strong>
                            <p>
                              {data.conflicts
                                .map(
                                  (c) =>
                                    `${data.appointments.find((a) => a.id === c.appointmentId)?.reference}: ${c.reasons.join(', ')}`,
                                )
                                .join(' · ')}
                            </p>
                          </div>
                        </div>
                      )}
                      <section className="panel">
                        <div className="section-heading">
                          <div>
                            <h2>Review the changes</h2>
                            <p>
                              Baseline v{proposal.baselinePlanVersion} to v
                              {proposal.baselinePlanVersion + 1}
                            </p>
                          </div>
                          <Badge tone={proposal.applicable ? 'green' : 'amber'}>
                            {proposal.applicable ? 'Ready for review' : 'Needs attention'}
                          </Badge>
                        </div>
                        <div className="proposal-table">
                          <div className="proposal-row table-head">
                            <span>APPOINTMENT</span>
                            <span>CURRENT PLAN</span>
                            <span>PROPOSED PLAN</span>
                            <span>WHY IT CHANGES</span>
                          </div>
                          {proposal.assignments.map((x) => {
                            const a = data.appointments.find((a) => a.id === x.appointmentId)!;
                            const changed =
                              JSON.stringify(x.from && [x.from.dockId, x.from.startAt]) !==
                              JSON.stringify(x.to && [x.to.dockId, x.to.startAt]);
                            return (
                              <div
                                className={`proposal-row ${changed ? 'changed' : ''}`}
                                key={x.appointmentId}
                              >
                                <div>
                                  <button className="text-button" onClick={() => setSelected(a.id)}>
                                    {a.reference}
                                  </button>
                                  <small>{a.carrierName}</small>
                                </div>
                                <div>
                                  {x.from ? (
                                    <>
                                      {data.docks.find((d) => d.id === x.from!.dockId)?.code}
                                      <small>
                                        {time(x.from.startAt, zone)} - {time(x.from.endAt, zone)}
                                      </small>
                                    </>
                                  ) : (
                                    'Unallocated'
                                  )}
                                </div>
                                <div>
                                  {x.to ? (
                                    <>
                                      {data.docks.find((d) => d.id === x.to!.dockId)?.code}
                                      <small>
                                        {time(x.to.startAt, zone)} - {time(x.to.endAt, zone)}
                                      </small>
                                    </>
                                  ) : (
                                    'No feasible slot'
                                  )}
                                  {x.locked && (
                                    <Badge>
                                      <LockKeyhole size={10} />
                                      Fixed
                                    </Badge>
                                  )}
                                </div>
                                <div className="reason">{x.reasons.join('. ')}</div>
                              </div>
                            );
                          })}
                        </div>
                        {proposal.warnings.length > 0 && (
                          <div className="warning-list">
                            {proposal.warnings.map((w) => (
                              <p key={w}>{w}</p>
                            ))}
                          </div>
                        )}
                        <footer className="approval-bar">
                          <div>
                            <ShieldCheck size={18} />
                            <span>Nothing changes until you approve.</span>
                          </div>
                          <button
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                await api(`/replans/${proposal.id}/reject`, {});
                                setProposal(null);
                              }, 'Proposal rejected')
                            }
                          >
                            Reject
                          </button>
                          <button
                            className="button primary"
                            disabled={
                              busy ||
                              !proposal.applicable ||
                              proposal.baselinePlanVersion !== data.site.currentPlanVersion ||
                              !can('plan')
                            }
                            onClick={() =>
                              run(async () => {
                                await api(`/replans/${proposal.id}/apply`, {
                                  expectedPlanVersion: proposal.baselinePlanVersion,
                                });
                                setProposal(null);
                              }, 'Recovery plan applied')
                            }
                          >
                            Approve & apply <ArrowUpRight size={16} />
                          </button>
                        </footer>
                        {proposal.baselinePlanVersion !== data.site.currentPlanVersion && (
                          <div className="alert error">
                            This proposal is stale. Generate a new plan before applying.
                          </div>
                        )}
                      </section>
                    </>
                  ) : (
                    <section className="panel recovery-baseline">
                      <div className="section-heading">
                        <h2>Current schedule</h2>
                        <Badge>Plan v{data.site.currentPlanVersion}</Badge>
                      </div>
                      <div className="baseline-facts">
                        <div>
                          <strong>{appointments.length}</strong>
                          <span>Appointments on this date</span>
                        </div>
                        <div>
                          <strong>{data.conflicts.length}</strong>
                          <span>Conflicts across the schedule</span>
                        </div>
                        <div>
                          <strong>{appointments.filter((a) => a.locked).length}</strong>
                          <span>Locked appointments on this date</span>
                        </div>
                      </div>
                      {data.conflicts.length > 0 && (
                        <div className="conflict-list">
                          {data.conflicts.map((c) => (
                            <button
                              key={c.appointmentId}
                              onClick={() => setSelected(c.appointmentId)}
                            >
                              <AlertTriangle size={15} />
                              <strong>
                                {data.appointments.find((a) => a.id === c.appointmentId)?.reference}
                              </strong>
                              <span>{c.reasons.join(' · ')}</span>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="baseline-note">
                        <Route size={16} />
                        <span>
                          No proposal generated. Choose a date to calculate and compare changes.
                        </span>
                      </div>
                    </section>
                  )}
                </>
              )}
              {view === 'metrics' && metrics && (
                <>
                  <div className="stats-grid">
                    <Stat
                      label="Average waiting"
                      value={
                        metrics.averageWaitingMinutes === null
                          ? '-'
                          : `${Math.round(metrics.averageWaitingMinutes)} min`
                      }
                      note={`${metrics.samples.waiting} complete observations`}
                    />
                    <Stat
                      label="Average service"
                      value={
                        metrics.averageServiceMinutes === null
                          ? '-'
                          : `${Math.round(metrics.averageServiceMinutes)} min`
                      }
                      note={`${metrics.samples.service} complete observations`}
                    />
                    <Stat
                      label="On-time arrival"
                      value={
                        metrics.onTimeArrivalPercent === null
                          ? '-'
                          : `${Math.round(metrics.onTimeArrivalPercent)}%`
                      }
                      note={`${metrics.samples.arrivals} recorded arrivals`}
                    />
                    <Stat
                      label="Dock utilization"
                      value={`${Math.min(100, Math.round((metrics.docks.reduce((n: number, d: any) => n + d.plannedMinutes, 0) / Math.max(1, data.docks.length * 720)) * 100))}%`}
                      note="Planned vs shift capacity"
                    />
                  </div>
                  <section className="panel metric-panel">
                    <div className="section-heading">
                      <div>
                        <h2>Dock utilization</h2>
                        <p>Planned minutes against a 12h shift.</p>
                      </div>
                    </div>
                    <div className="workload-grid">
                      {metrics.docks.map((d: any) => {
                        const dock = data.docks.find((x) => x.id === d.id);
                        const pct = Math.min(100, Math.round((d.plannedMinutes / 720) * 100));
                        const count = data.allocations.filter((x) => x.dockId === d.id).length;
                        const r = 27;
                        const circ = 2 * Math.PI * r;
                        const tone = dock?.operationType || 'inbound';
                        return (
                          <div className="workload-ring-card" key={d.id}>
                            <div className="mini-ring">
                              <svg viewBox="0 0 68 68">
                                <circle cx="34" cy="34" r={r} className={`ring-track ${tone}`} />
                                <circle
                                  cx="34"
                                  cy="34"
                                  r={r}
                                  className={`ring-fill ${tone}`}
                                  strokeDasharray={circ}
                                  strokeDashoffset={circ - (pct / 100) * circ}
                                />
                              </svg>
                              <strong>{pct}%</strong>
                            </div>
                            <div className="workload-ring-info">
                              <div className="workload-ring-head">
                                <strong>{d.code}</strong>
                                <span className={`ring-pill ${tone}`}>
                                  {tone === 'both' ? 'Hybrid' : tone}
                                </span>
                              </div>
                              <p>
                                {(d.plannedMinutes / 60).toFixed(1)}h · {count} bookings
                              </p>
                              <small>
                                {dock?.capabilities.length
                                  ? dock.capabilities.join(', ')
                                  : 'Standard'}{' '}
                                · {d.status}
                              </small>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {!metrics.samples.service && (
                      <div className="metric-note">
                        Complete a service in Gate & yard to see actual service times.
                      </div>
                    )}
                  </section>
                </>
              )}
              {view === 'settings' && (
                <Settings
                  data={data}
                  can={can}
                  run={run}
                  refresh={load}
                  busy={busy}
                  localMode={user.localMode}
                />
              )}
            </>
          )}
          {!siteId && (
            <Settings
              data={null}
              can={can}
              run={run}
              refresh={load}
              busy={busy}
              localMode={user.localMode}
            />
          )}
        </div>
      </main>
      {booking && data && (
        <Booking
          data={data}
          date={date}
          onClose={() => setBooking(false)}
          run={run}
          onCreated={(id) => {
            setBooking(false);
            setSelected(id);
          }}
          busy={busy}
        />
      )}
      {selected && data && (
        <Detail
          id={selected}
          data={data}
          onClose={() => setSelected(null)}
          run={run}
          busy={busy}
          can={can}
          onRecover={() => {
            setSelected(null);
            void generate();
          }}
        />
      )}
    </div>
  );
}
function Login({ error, onLogin }: { error: string; onLogin: () => void }) {
  const [email, setEmail] = useState('admin@dockslot.local'),
    [password, setPassword] = useState(''),
    [localError, setLocalError] = useState(''),
    [busy, setBusy] = useState(false),
    [setup, setSetup] = useState(false),
    [org, setOrg] = useState('');
  return (
    <div className="login-page">
      <div className="login-story">
        <a className="brand" href="/">
          <span className="brand-icon">
            <img src="/logo.png" alt="" width={26} height={26} />
          </span>
          DockSlot
        </a>
        <Badge>DOCK SCHEDULING</Badge>
        <h1>
          Dock scheduling and
          <br />
          <span>yard operations.</span>
        </h1>
        <p>Manage appointments, track arrivals at the gate, and adjust the dock schedule.</p>
        <div className="login-grid">
          <div />
          <div />
          <div />
          <div />
          <div />
          <div />
        </div>
        <span className="login-foot">Self-hosted workspace</span>
      </div>
      <div className="login-form">
        <div>
          <span className="eyebrow">WORKSPACE ACCESS</span>
          <h2>{setup ? 'Set up your instance' : 'Sign in'}</h2>
          <p>
            {setup
              ? 'Create the first organization administrator.'
              : 'Enter your credentials to access the workspace.'}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setLocalError('');
              try {
                if (setup) await api('/auth/bootstrap', { organization: org, email, password });
                await api('/auth/login', { email, password });
                onLogin();
              } catch (e) {
                setLocalError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {setup && (
              <label>
                Organization
                <input required value={org} onChange={(e) => setOrg(e.target.value)} />
              </label>
            )}
            <label>
              Email address
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={setup ? 'new-password' : 'current-password'}
                required
                minLength={setup ? 12 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {(localError || error) && (
              <p className="form-error" role="alert">
                {localError || error}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? 'Connecting...' : setup ? 'Create workspace' : 'Sign in to workspace'}
              <ArrowUpRight size={17} />
            </button>
          </form>
          <button className="text-button setup-link" onClick={() => setSetup(!setup)}>
            {setup ? 'Already initialized? Sign in' : 'New installation? Initialize your workspace'}
          </button>
        </div>
      </div>
    </div>
  );
}
