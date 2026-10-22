import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { assert, permissions, type Permission, type Role } from '@dockslot/domain';
import type { Client } from '@dockslot/db';
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const secretToken = () => randomBytes(32).toString('base64url');
export type Principal = {
  id: string;
  organizationId: string;
  source: 'local' | 'session' | 'integration';
  grants: { siteId: string | null; permissions: Permission[] }[];
};
export function authMode() {
  const mode = process.env.AUTH_MODE || 'local';
  assert(mode === 'local' || mode === 'session', 500, 'AUTH_MODE must be local or session');
  return mode;
}
export function localPrincipal(): Principal {
  return {
    id: 'local_operator',
    organizationId: process.env.LOCAL_ORGANIZATION_ID || 'org_local',
    source: 'local',
    grants: [{ siteId: null, permissions: permissions.org_admin }],
  };
}
export function allowed(p: Principal, permission: Permission, siteId?: string) {
  return p.grants.some(
    (g) => (!g.siteId || g.siteId === siteId) && g.permissions.includes(permission),
  );
}
export function authorize(p: Principal, permission: Permission, siteId?: string) {
  assert(allowed(p, permission, siteId), 403, `Missing ${permission} permission for this site`);
}
export async function authenticate(
  c: Client,
  token: string,
  source: 'session' | 'integration',
  org?: string,
): Promise<Principal> {
  if (source === 'integration') {
    const row = (
      await c.query(
        'UPDATE api_tokens SET last_used_at=now() WHERE hashed_token=$1 AND expires_at>now() AND revoked_at IS NULL RETURNING *',
        [hashToken(token)],
      )
    ).rows[0];
    assert(row, 401, 'Invalid or expired credentials');
    return {
      id: row.id,
      organizationId: row.organization_id,
      source,
      grants: [{ siteId: row.site_id, permissions: row.scopes }],
    };
  }
  const rows = (
    await c.query(
      'SELECT m.*,u.email FROM sessions s JOIN users u ON u.id=s.user_id AND u.active JOIN memberships m ON m.user_id=u.id WHERE s.hashed_token=$1 AND s.expires_at>now()',
      [hashToken(token)],
    )
  ).rows;
  assert(rows.length, 401, 'Invalid or expired session');
  const orgId = org || rows[0].organization_id,
    memberships = rows.filter((r) => r.organization_id === orgId);
  assert(memberships.length, 403, 'No membership in this organization');
  return {
    id: rows[0].user_id,
    organizationId: orgId,
    source,
    grants: memberships.map((r) => ({
      siteId: r.site_id,
      permissions: permissions[r.role as Role],
    })),
  };
}
function encryptionKey() {
  const value = process.env.ENCRYPTION_KEY || '';
  assert(/^[a-f\d]{64}$/i.test(value), 503, 'Configure ENCRYPTION_KEY before registering webhooks');
  return Buffer.from(value, 'hex');
}
export function encrypt(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((v) => v.toString('base64')).join('.');
}
export function decrypt(value: string) {
  const [iv, tag, body] = value.split('.').map((v) => Buffer.from(v, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8');
}
export function privateAddress(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Only globally routable unicast IPv6; reject mapped IPv4 and special ranges.
  return !/^[23][0-9a-f]{3}:/i.test(ip) || /^2001:(db8|0):/i.test(ip);
}
export async function webhookTarget(raw: string) {
  const url = new URL(raw);
  assert(
    !url.username && !url.password && !url.hash,
    400,
    'Webhook URL cannot include credentials or a fragment',
  );
  assert(
    url.protocol === 'https:' ||
      (process.env.WEBHOOK_ALLOW_PRIVATE === 'true' && url.protocol === 'http:'),
    400,
    'Webhook URL must use HTTPS',
  );
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  assert(
    addresses.length &&
      (process.env.WEBHOOK_ALLOW_PRIVATE === 'true' ||
        addresses.every((a) => !privateAddress(a.address))),
    400,
    'Webhook target must resolve to public addresses',
  );
  return { url, address: addresses[0] };
}
