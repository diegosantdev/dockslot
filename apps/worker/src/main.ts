import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pool, transaction } from '@dockslot/db';
import { decrypt, webhookTarget } from '../../api/src/security.js';

/** Resolve and validate on each attempt, then pin the checked IP to prevent DNS rebinding. */
export async function deliver(
  url: string,
  secret: string,
  eventId: string,
  payload: string,
): Promise<number> {
  const target = await webhookTarget(url),
    timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return new Promise((resolve, reject) => {
    const request = (target.url.protocol === 'https:' ? https : http).request(
      target.url,
      {
        method: 'POST',
        timeout: 10000,
        lookup: (_hostname, options, callback) => {
          if ((options as { all?: boolean }).all) {
            (callback as unknown as (error: null, addresses: typeof target.address[]) => void)(null, [target.address]);
          } else callback(null, target.address.address, target.address.family);
        },
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-DockSlot-Event-Id': eventId,
          'X-DockSlot-Timestamp': timestamp,
          'X-DockSlot-Signature': `v1=${signature}`,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode || 500);
      },
    );
    request.on('timeout', () => request.destroy(new Error('Webhook timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}
export async function tick(db = pool, sender = deliver) {
  await transaction(async (c) => {
    const events = (
      await c.query(
        'SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED',
      )
    ).rows;
    for (const e of events) {
      await c.query(
        'INSERT INTO webhook_deliveries(event_id,endpoint_id) SELECT $1,id FROM webhook_endpoints WHERE organization_id=$2 AND active AND (cardinality(event_filters)=0 OR $3=ANY(event_filters)) ON CONFLICT DO NOTHING',
        [e.id, e.organization_id, e.name],
      );
      await c.query('UPDATE outbox_events SET published_at=now() WHERE id=$1', [e.id]);
    }
  }, db);
  await transaction(async (c) => {
    const row = (
      await c.query(
        "SELECT d.*,w.url,w.encrypted_secret,e.name,e.payload_json,e.created_at FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id JOIN outbox_events e ON e.id=d.event_id WHERE d.status='pending' AND d.next_attempt_at<=now() AND w.active ORDER BY d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED",
      )
    ).rows[0];
    if (!row) return;
    const attempt = row.attempt + 1;
    let code: number | null = null,
      error: string | null = null;
    try {
      code = await sender(
        row.url,
        decrypt(row.encrypted_secret),
        String(row.event_id),
        JSON.stringify({
          id: String(row.event_id),
          type: row.name,
          createdAt: row.created_at,
          data: row.payload_json,
        }),
      );
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    const success = code !== null && code >= 200 && code < 300;
    await c.query(
      "UPDATE webhook_deliveries SET attempt=$2,status=$3,response_code=$4,last_error=$5,next_attempt_at=now()+($6::integer*interval '1 second') WHERE id=$1",
      [
        row.id,
        attempt,
        success ? 'delivered' : attempt >= 8 ? 'failed' : 'pending',
        code,
        error,
        Math.min(3600, 2 ** attempt * 5),
      ],
    );
  }, db);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let running = true;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      running = false;
    });
  while (running) {
    try {
      await tick();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Worker cycle failed',
          error: (error as Error).message,
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await pool.end();
}
