'use client';
import { use, useEffect, useState } from 'react';
import { MapPin, ShieldCheck } from 'lucide-react';
import { api, zonedISO } from '../../../lib/api';
export default function Portal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = () =>
    api(`/portal/${token}`)
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, [token]);
  return (
    <div className="portal-page">
      <header>
        <a className="brand" href="/">
          <span className="brand-icon">
            <img src="/logo.png" alt="" width={26} height={26} />
          </span>
          DockSlot
        </a>
        <span>Carrier portal</span>
      </header>
      <main className="panel">
        <div className="eyebrow">CARRIER PORTAL</div>
        <h1>{data?.site.name || 'Carrier access'}</h1>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {data && (
          <>
            <p>
              <MapPin size={16} /> {data.site.address}
            </p>
            <p>{data.site.instructions}</p>
            {data.appointment ? (
              <div className="portal-booking">
                <span className="badge blue">{data.appointment.status}</span>
                <h2>{data.appointment.reference}</h2>
                <p>
                  {data.appointment.carrierName} · {data.appointment.vehicle}
                </p>
                {data.appointment.allocation ? (
                  <p>
                    Scheduled:{' '}
                    {new Date(data.appointment.allocation.start_at).toLocaleString('en', {
                      timeZone: data.site.timezone,
                    })}{' '}
                    · {data.site.timezone}
                  </p>
                ) : (
                  <p>Your request is awaiting an allocation. Contact the site for changes.</p>
                )}
                <p>
                  Reported ETA:{' '}
                  {data.appointment.etaAt
                    ? new Date(data.appointment.etaAt).toLocaleString('en', {
                        timeZone: data.site.timezone,
                      })
                    : 'Not provided'}
                </p>
              </div>
            ) : data.canRequest ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError('');
                  const f = new FormData(e.currentTarget);
                  try {
                    await api(`/portal/${token}/requests`, {
                      reference: f.get('reference'),
                      carrierName: f.get('carrier'),
                      vehicle: f.get('vehicle'),
                      operationType: f.get('operation'),
                      durationMinutes: Number(f.get('duration')),
                      etaAt: zonedISO(
                        String(f.get('date')),
                        String(f.get('from')),
                        data.site.timezone,
                      ),
                      earliestStartAt: zonedISO(
                        String(f.get('date')),
                        String(f.get('from')),
                        data.site.timezone,
                      ),
                      latestStartAt: zonedISO(
                        String(f.get('date')),
                        String(f.get('to')),
                        data.site.timezone,
                      ),
                      notes: f.get('notes'),
                    });
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <h2>Request a service window</h2>
                <p>Times use {data.site.timezone}. Your site may require planner approval.</p>
                <div className="form-grid">
                  <label>
                    Your reference
                    <input name="reference" required />
                  </label>
                  <label>
                    Carrier name
                    <input name="carrier" required />
                  </label>
                  <label>
                    Vehicle / plate
                    <input name="vehicle" required />
                  </label>
                  <label>
                    Operation
                    <select name="operation">
                      <option value="inbound">Inbound</option>
                      <option value="outbound">Outbound</option>
                    </select>
                  </label>
                  <label>
                    Date
                    <input name="date" type="date" required />
                  </label>
                  <label>
                    Duration (minutes)
                    <input
                      name="duration"
                      type="number"
                      min={5}
                      max={720}
                      defaultValue={60}
                      required
                    />
                  </label>
                  <label>
                    Earliest start
                    <input name="from" type="time" defaultValue="09:00" required />
                  </label>
                  <label>
                    Latest start
                    <input name="to" type="time" defaultValue="17:00" required />
                  </label>
                  <label className="span-2">
                    Notes
                    <textarea name="notes" />
                  </label>
                </div>
                <button className="button primary" disabled={busy}>
                  {busy ? 'Submitting...' : 'Submit request'}
                </button>
              </form>
            ) : (
              <p>This link cannot create a request.</p>
            )}
          </>
        )}
        <footer>
          <ShieldCheck size={15} /> This private link grants access only to your booking.
        </footer>
      </main>
    </div>
  );
}
