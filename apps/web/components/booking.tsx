'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Clock3, LockKeyhole, Route, Truck, Link2 } from 'lucide-react';
import type { Appointment, Slot, Snapshot } from '@dockslot/domain';
import { api, time, zonedISO } from '../lib/api';
import { Badge, Modal } from './ui';
type Run = (fn: () => Promise<unknown>, success?: string) => Promise<void>;
export function Booking({
  data,
  date,
  onClose,
  run,
  onCreated,
  busy,
}: {
  data: Snapshot;
  date: string;
  onClose: () => void;
  run: Run;
  onCreated: (id: string) => void;
  busy: boolean;
}) {
  return (
    <Modal title="New appointment" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(async () => {
            const a = await api<Appointment>('/appointments', {
              siteId: data.site.id,
              reference: f.get('reference'),
              carrierName: f.get('carrierName'),
              vehicle: f.get('vehicle'),
              operationType: f.get('operationType'),
              durationMinutes: Number(f.get('duration')),
              priority: Number(f.get('priority')),
              etaAt: f.get('eta')
                ? zonedISO(String(f.get('date')), String(f.get('eta')), data.site.timezone)
                : null,
              earliestStartAt: zonedISO(
                String(f.get('date')),
                String(f.get('earliest')),
                data.site.timezone,
              ),
              latestStartAt: zonedISO(
                String(f.get('date')),
                String(f.get('latest')),
                data.site.timezone,
              ),
              requiredCapabilities: String(f.get('capabilities') || '')
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
              notes: f.get('notes'),
              cargo: f.get('cargo'),
              hardWindow: f.get('hardWindow') === 'on',
              externalId: String(f.get('externalId') || '') || null,
            });
            onCreated(a.id);
          }, 'Appointment requested. Select an available slot to confirm.');
        }}
      >
        <div className="modal-content">
          <p className="form-intro">
            Create a request, then choose a compatible dock and confirm its allocation. Times use{' '}
            <strong>{data.site.timezone}</strong>.
          </p>
          <div className="form-grid">
            <label>
              Reference
              <input name="reference" placeholder="PO-9044" required maxLength={100} />
            </label>
            <label>
              Carrier
              <input name="carrierName" placeholder="Carrier name" required />
            </label>
            <label>
              Vehicle / plate
              <input name="vehicle" placeholder="ABC-1234" />
            </label>
            <label>
              Operation
              <select name="operationType">
                <option value="inbound">Inbound · unload</option>
                <option value="outbound">Outbound · load</option>
              </select>
            </label>
            <label>
              Date
              <input name="date" type="date" defaultValue={date} required />
            </label>
            <label>
              Reported ETA
              <input name="eta" type="time" defaultValue="09:00" />
            </label>
            <label>
              Earliest service start
              <input name="earliest" type="time" defaultValue="07:00" required />
            </label>
            <label>
              Latest service start
              <input name="latest" type="time" defaultValue="18:00" required />
            </label>
            <label>
              Estimated duration (minutes)
              <input name="duration" type="number" min={5} max={720} defaultValue={60} required />
            </label>
            <label>
              Priority
              <select name="priority">
                <option value={1}>1 · Low</option>
                <option value={2}>2 · Standard</option>
                <option value={3}>3 · Elevated</option>
                <option value={4}>4 · High</option>
                <option value={5}>5 · Critical</option>
              </select>
            </label>
            <label>
              Capabilities (comma separated)
              <input name="capabilities" placeholder="reefer, liftgate" />
            </label>
            <label>
              External ID
              <input name="externalId" placeholder="Optional integration reference" />
            </label>
            <label className="span-2">
              Cargo description
              <input name="cargo" placeholder="Palletized goods" />
            </label>
            <label className="span-2">
              Notes
              <textarea name="notes" rows={2} />
            </label>
            <label className="checkbox span-2">
              <input type="checkbox" name="hardWindow" defaultChecked />
              Service window is mandatory
            </label>
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Create request <ArrowUpRight size={16} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function Detail({
  id,
  data,
  onClose,
  run,
  busy,
  can,
  onRecover,
}: {
  id: string;
  data: Snapshot;
  onClose: () => void;
  run: Run;
  busy: boolean;
  can: (p: string) => boolean;
  onRecover: () => void;
}) {
  const a = data.appointments.find((a) => a.id === id)!;
  const allocation = data.allocations.find((x) => x.appointmentId === id),
    visit = data.visits.find((v) => v.appointmentId === id);
  const [slots, setSlots] = useState<Slot[]>([]),
    [reasons, setReasons] = useState<string[]>([]),
    [picked, setPicked] = useState<Slot | null>(null),
    [history, setHistory] = useState<any[]>([]),
    [reason, setReason] = useState(''),
    [eta, setEta] = useState(''),
    [portal, setPortal] = useState(''),
    [editing, setEditing] = useState(false);
  const zone = data.site.timezone;
  useEffect(() => {
    void api<any[]>(`/appointments/${id}/history`)
      .then(setHistory)
      .catch(() => {});
    const pending = sessionStorage.getItem('dockslot-move');
    if (pending) {
      const move = JSON.parse(pending);
      if (move.appointmentId === id) {
        setPicked({
          dockId: move.dockId,
          startAt: move.startAt,
          endAt: new Date(Date.parse(move.startAt) + a.durationMinutes * 60000).toISOString(),
        });
        sessionStorage.removeItem('dockslot-move');
      }
    }
  }, [id, a.durationMinutes, data.site.currentPlanVersion]);
  if (!a) return null;
  const next = (
    {
      expected: 'check-in',
      checked_in: 'start-service',
      in_service: 'complete-service',
      service_completed: 'check-out',
    } as Record<string, string>
  )[visit?.status || 'expected'];
  return (
    <Modal title={a.reference} onClose={onClose}>
      <div className="modal-content">
        <div className="detail-summary">
          <span className="carrier-symbol">
            <Truck size={24} />
          </span>
          <div>
            <h3>{a.carrierName}</h3>
            <p>
              {a.vehicle || 'No vehicle recorded'} · {a.operationType}
            </p>
          </div>
          <Badge tone={visit?.status === 'in_service' ? 'blue' : 'neutral'}>{a.status}</Badge>
        </div>
        <div className="detail-facts">
          <div>
            <span>Dock / service</span>
            <strong>
              {allocation
                ? data.docks.find((d) => d.id === allocation.dockId)?.code
                : 'Unallocated'}
            </strong>
            <small>
              {allocation
                ? `${time(allocation.startAt, zone)} - ${time(allocation.endAt, zone)}`
                : 'Select a slot below'}
            </small>
          </div>
          <div>
            <span>Reported ETA</span>
            <strong>{time(a.etaAt, zone)}</strong>
            <small>{zone}</small>
          </div>
          <div>
            <span>Visit state</span>
            <strong>{visit?.status.replaceAll('_', ' ')}</strong>
            <small>
              {a.durationMinutes} min · Priority {a.priority}
            </small>
          </div>
        </div>
        {a.notes && <p className="form-intro">{a.notes}</p>}
        <div className="detail-actions">
          {next && (
            <button
              className="button primary"
              disabled={
                busy ||
                !can(['check-in', 'check-out'].includes(next) ? 'gate' : 'dock') ||
                !['confirmed', 'fulfilled'].includes(a.status)
              }
              onClick={() => run(() => api(`/appointments/${id}/${next}`, {}), 'Visit updated')}
            >
              <Check size={16} />
              {next.replaceAll('-', ' ')}
            </button>
          )}
          <button
            className="button"
            disabled={busy || !can(a.locked ? 'manage' : 'plan')}
            onClick={() =>
              run(
                () =>
                  api(
                    `/appointments/${id}`,
                    { expectedVersion: a.version, changes: { locked: !a.locked } },
                    'PATCH',
                  ),
                a.locked ? 'Appointment unlocked' : 'Appointment locked',
              )
            }
          >
            <LockKeyhole size={15} />
            {a.locked ? 'Unlock' : 'Lock'}
          </button>
          <button className="button" disabled={!can('plan')} onClick={onRecover}>
            <Route size={15} />
            Recover
          </button>
        </div>
        <section className="detail-section">
          <h3>Update arrival estimate</h3>
          <p>Reporting a delay flags the impact. It does not move this booking.</p>
          <div className="inline-form">
            <input
              aria-label="New ETA"
              type="datetime-local"
              value={eta}
              onChange={(e) => setEta(e.target.value)}
            />
            <button
              className="button"
              disabled={busy || !eta || !can('plan')}
              onClick={() =>
                run(
                  () =>
                    api(`/appointments/${id}/eta`, {
                      etaAt: zonedISO(eta.slice(0, 10), eta.slice(11, 16), zone),
                    }),
                  'ETA updated',
                )
              }
            >
              Update ETA
            </button>
          </div>
        </section>
        <section className="detail-section">
          <div className="split">
            <h3>{allocation ? 'Move appointment' : 'Confirm allocation'}</h3>
            <button
              className="text-button"
              disabled={busy || !can('plan')}
              onClick={() =>
                run(async () => {
                  const result = await api('/availability/search', {
                    appointmentId: id,
                    startAt: a.earliestStartAt,
                    endAt: new Date(
                      Date.parse(a.latestStartAt) + a.durationMinutes * 60000,
                    ).toISOString(),
                  });
                  setSlots(result.slots);
                  setReasons(result.reasons);
                })
              }
            >
              Find available slots
            </button>
          </div>
          <p>
            Choose a slot, review it, then confirm. The server checks conflicts again before saving.
          </p>
          {slots.length > 0 && (
            <select
              aria-label="Available slot"
              value={picked ? `${picked.dockId}|${picked.startAt}` : ''}
              onChange={(e) => {
                const [dock, start] = e.target.value.split('|');
                setPicked(slots.find((s) => s.dockId === dock && s.startAt === start) || null);
              }}
            >
              <option value="">Select a slot...</option>
              {slots.map((s) => (
                <option key={`${s.dockId}|${s.startAt}`} value={`${s.dockId}|${s.startAt}`}>
                  {data.docks.find((d) => d.id === s.dockId)?.code} · {time(s.startAt, zone)} -{' '}
                  {time(s.endAt, zone)}
                </option>
              ))}
            </select>
          )}
          {!!reasons.length && !slots.length && <p className="form-error">{reasons.join('. ')}</p>}
          {picked && (
            <div className="move-preview">
              <div>
                <strong>Proposed move</strong>
                <p>
                  {data.docks.find((d) => d.id === picked.dockId)?.code} ·{' '}
                  {time(picked.startAt, zone)} - {time(picked.endAt, zone)}
                </p>
              </div>
              <button
                className="button primary"
                disabled={busy || !can('plan')}
                onClick={() =>
                  run(async () => {
                    await api(`/appointments/${id}/confirm`, {
                      dockId: picked.dockId,
                      startAt: picked.startAt,
                      expectedPlanVersion: data.site.currentPlanVersion,
                    });
                    setPicked(null);
                    setSlots([]);
                  }, 'Allocation confirmed')
                }
              >
                Confirm slot
              </button>
            </div>
          )}
        </section>
        <section className="detail-section">
          <div className="split">
            <h3>Booking details</h3>
            <button
              className="text-button"
              disabled={!can('plan')}
              onClick={() => setEditing(!editing)}
            >
              {editing ? 'Close editor' : 'Edit details'}
            </button>
          </div>
          {editing && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void run(
                  () =>
                    api(
                      `/appointments/${id}`,
                      {
                        expectedVersion: a.version,
                        changes: {
                          carrierName: f.get('carrierName'),
                          vehicle: f.get('vehicle'),
                          notes: f.get('notes'),
                          priority: Number(f.get('priority')),
                          requiredCapabilities: String(f.get('capabilities'))
                            .split(',')
                            .map((x) => x.trim())
                            .filter(Boolean),
                        },
                      },
                      'PATCH',
                    ),
                  'Appointment updated',
                );
              }}
            >
              <div className="form-grid">
                <label>
                  Carrier
                  <input name="carrierName" defaultValue={a.carrierName} required />
                </label>
                <label>
                  Vehicle
                  <input name="vehicle" defaultValue={a.vehicle} />
                </label>
                <label>
                  Priority
                  <input name="priority" type="number" min={1} max={5} defaultValue={a.priority} />
                </label>
                <label>
                  Required capabilities
                  <input name="capabilities" defaultValue={a.requiredCapabilities.join(', ')} />
                </label>
                <label className="span-2">
                  Notes
                  <textarea name="notes" defaultValue={a.notes} />
                </label>
              </div>
              <button className="button" disabled={busy}>
                Save details
              </button>
            </form>
          )}
          <div className="inline-form">
            <input
              aria-label="Cancellation or no-show reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for cancellation / no-show"
            />
            <button
              className="button danger"
              disabled={busy || reason.length < 3 || !can('plan')}
              onClick={() =>
                run(() => api(`/appointments/${id}/cancel`, { reason }), 'Appointment cancelled')
              }
            >
              Cancel
            </button>
            <button
              className="button"
              disabled={busy || reason.length < 3 || !can('plan')}
              onClick={() =>
                run(() => api(`/appointments/${id}/mark-no-show`, { reason }), 'No-show recorded')
              }
            >
              No-show
            </button>
          </div>
        </section>
        <section className="detail-section">
          <div className="split">
            <h3>Carrier access</h3>
            <button
              className="text-button"
              disabled={busy || !can('plan')}
              onClick={() =>
                run(async () => {
                  const link = await api('/portal-tokens', {
                    siteId: data.site.id,
                    appointmentId: id,
                    scopes: ['read'],
                    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
                  });
                  setPortal(window.location.origin + link.path);
                })
              }
            >
              <Link2 size={14} />
              Create 7-day link
            </button>
          </div>
          {portal && (
            <a className="portal-link" href={portal} target="_blank" rel="noreferrer">
              {portal}
            </a>
          )}
        </section>
        <section className="detail-section">
          <h3>Activity timeline</h3>
          <div className="history">
            {history.map((h) => (
              <div key={h.id}>
                <Clock3 size={13} />
                <span>
                  {h.action.replaceAll('.', ' · ').replaceAll('_', ' ')}
                  <small>
                    {new Date(h.created_at).toLocaleString()} · {h.source}
                  </small>
                </span>
              </div>
            ))}
            {!history.length && <p>No appointment events recorded yet.</p>}
          </div>
        </section>
      </div>
    </Modal>
  );
}
