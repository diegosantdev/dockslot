import { z } from 'zod';
import { DateTime, IANAZone } from 'luxon';

export const iso = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
export const id = z.string().min(1).max(100);
export const operation = z.enum(['inbound', 'outbound']);
export const roleSchema = z.enum([
  'org_admin',
  'site_manager',
  'planner',
  'gate_operator',
  'dock_operator',
  'viewer',
]);
export type Role = z.infer<typeof roleSchema>;
export type Permission = 'read' | 'plan' | 'gate' | 'dock' | 'manage' | 'admin';
export const permissions: Record<Role, Permission[]> = {
  org_admin: ['read', 'plan', 'gate', 'dock', 'manage', 'admin'],
  site_manager: ['read', 'plan', 'gate', 'dock', 'manage'],
  planner: ['read', 'plan'],
  gate_operator: ['read', 'gate'],
  dock_operator: ['read', 'dock'],
  viewer: ['read'],
};
export const policySchema = z.object({
  open: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('07:00'),
  close: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('19:00'),
  weekdays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5, 6, 7]),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  slotMinutes: z.number().int().min(5).max(60).default(15),
  toleranceMinutes: z.number().int().min(0).max(180).default(15),
  noShowMinutes: z.number().int().min(0).max(1440).default(60),
  fairnessMinutes: z.number().int().min(60).default(1440),
  portalAutoConfirm: z.boolean().default(false),
  weights: z
    .object({
      waiting: z.number().min(0),
      movement: z.number().min(0),
      sla: z.number().min(0),
      fragmentation: z.number().min(0),
    })
    .default({ waiting: 1, movement: 4, sla: 8, fragmentation: 0.2 }),
});
export const siteInput = z.object({
  name: z.string().min(1).max(150),
  timezone: z.string().refine((v) => IANAZone.isValidZone(v), 'Invalid IANA timezone'),
  address: z.string().max(500).default(''),
  instructions: z.string().max(2000).default(''),
  policy: policySchema.default(() => policySchema.parse({})),
});
export type Site = z.infer<typeof siteInput> & {
  id: string;
  organizationId: string;
  currentPlanVersion: number;
};
export const dockInput = z.object({
  code: z.string().min(1).max(50),
  operationType: z.enum(['inbound', 'outbound', 'both']).default('both'),
  capabilities: z.array(z.string().min(1).max(80)).max(50).default([]),
  maxLengthMeters: z.number().positive().nullable().default(null),
  maxWeightTons: z.number().positive().nullable().default(null),
  status: z.enum(['available', 'out_of_service', 'maintenance']).default('available'),
});
export type Dock = z.infer<typeof dockInput> & { id: string; siteId: string };
export const dockChanges = z.object(Object.fromEntries(Object.entries(dockInput.shape).map(([key,schema])=>[key,(schema instanceof z.ZodDefault?schema.removeDefault():schema).optional()])));
export const appointmentFields = z
  .object({
    siteId: id,
    carrierId: id.optional(),
    carrierName: z.string().min(1).max(150),
    reference: z.string().min(1).max(100),
    vehicle: z.string().max(80).default(''),
    operationType: operation,
    etaAt: iso.nullable().default(null),
    earliestStartAt: iso,
    latestStartAt: iso,
    durationMinutes: z.number().int().min(5).max(720),
    priority: z.number().int().min(1).max(5).default(2),
    requiredCapabilities: z.array(z.string().min(1).max(80)).max(50).default([]),
    lengthMeters: z.number().positive().nullable().default(null),
    weightTons: z.number().positive().nullable().default(null),
    hardWindow: z.boolean().default(true),
    locked: z.boolean().default(false),
    relocationAllowed: z.boolean().default(true),
    notes: z.string().max(4000).default(''),
    cargo: z.string().max(500).default(''),
    quantity: z.number().nonnegative().nullable().default(null),
    externalId: z.string().min(1).max(150).nullable().default(null),
  });
export const appointmentInput = appointmentFields.refine((v) => v.latestStartAt >= v.earliestStartAt, {
    message: 'Latest start must follow earliest start',
    path: ['latestStartAt'],
  });
// Optional patch fields must not apply creation defaults to omitted properties.
export const appointmentChanges = z.object(Object.fromEntries(Object.entries(appointmentFields.shape).map(([key,schema]) => [key, (schema instanceof z.ZodDefault ? schema.removeDefault() : schema).optional()])));
export type Appointment = z.infer<typeof appointmentInput> & {
  id: string;
  organizationId: string;
  createdAt: string;
  version: number;
  status: 'requested' | 'confirmed' | 'cancelled' | 'rejected' | 'no_show' | 'fulfilled';
};
export type Visit = {
  appointmentId: string;
  status:
    'expected' | 'checked_in' | 'in_service' | 'service_completed' | 'checked_out' | 'no_show';
  checkedInAt: string | null;
  serviceStartedAt: string | null;
  serviceCompletedAt: string | null;
  checkedOutAt: string | null;
};
export type Allocation = {
  id: string;
  appointmentId: string;
  dockId: string;
  startAt: string;
  endAt: string;
  planVersion: number;
};
export type Block = { id: string; dockId: string; startAt: string; endAt: string; reason: string };
export type Snapshot = {
  site: Site;
  docks: Dock[];
  appointments: Appointment[];
  allocations: Allocation[];
  visits: Visit[];
  blocks: Block[];
};
export type Slot = Pick<Allocation, 'dockId' | 'startAt' | 'endAt'>;
export type Assignment = {
  appointmentId: string;
  from: Slot | null;
  to: Slot | null;
  reasons: string[];
  locked: boolean;
};
export const replanInput = z
  .object({
    startAt: iso,
    endAt: iso,
    reason: z.enum(['late_arrival', 'dock_outage', 'manual', 'overrun']),
    overrides: z
      .array(z.object({ appointmentId: id, etaAt: iso.optional(), locked: z.boolean().optional() }))
      .max(500)
      .default([]),
    weights: policySchema.shape.weights.optional(),
  })
  .refine(
    (v) => v.endAt > v.startAt && Date.parse(v.endAt) - Date.parse(v.startAt) <= 7 * 86400000,
    'Horizon must be positive and at most seven days',
  );
export type ReplanRequest = z.infer<typeof replanInput>;
export type Proposal = {
  id: string;
  baselinePlanVersion: number;
  assignments: Assignment[];
  unscheduled: { appointmentId: string; reasons: string[] }[];
  applicable: boolean;
  warnings: string[];
  metrics: {
    movedCount: number;
    totalProjectedWaitingMinutes: number | null;
    lateMinutes: number | null;
    hardConstraintViolations: number;
    baselineProjectedWaitingMinutes: number | null;
  };
  reason: string;
  algorithmVersion: string;
};
export class DomainError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const fail = (
  condition: unknown,
  code: number,
  message: string,
  details?: unknown,
): asserts condition => {
  if (!condition) throw new DomainError(code, message, details);
};
export function assert(
  condition: unknown,
  code: number,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
export const overlaps = (
  a: { startAt: string; endAt: string },
  b: { startAt: string; endAt: string },
) => Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(b.startAt) < Date.parse(a.endAt);
export const minutes = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 60000;
export const addMinutes = (at: string, n: number) =>
  new Date(Date.parse(at) + n * 60000).toISOString();
export const sameSlot = (a: Slot | null | undefined, b: Slot | null | undefined) =>
  a?.dockId === b?.dockId && a?.startAt === b?.startAt && a?.endAt === b?.endAt;
export const fixed = (a: Appointment, visit?: Visit) =>
  a.locked ||
  !a.relocationAllowed ||
  ['fulfilled', 'cancelled', 'no_show', 'rejected'].includes(a.status) ||
  (!!visit && ['in_service', 'service_completed', 'checked_out'].includes(visit.status));
const calendarCache = new WeakMap<Site, { policyKey: string; slots: Map<string, boolean> }>();
export function withinHours(site: Site, slot: Slot): boolean {
  const policyKey = `${site.timezone}|${site.policy.open}|${site.policy.close}|${site.policy.weekdays.join(',')}|${site.policy.holidays.join(',')}`;
  let cache = calendarCache.get(site);
  if (!cache || cache.policyKey !== policyKey) {
    cache = { policyKey, slots: new Map() };
    calendarCache.set(site, cache);
  }
  const key = `${slot.startAt}|${slot.endAt}`,
    cached = cache.slots.get(key);
  if (cached !== undefined) return cached;
  const valid = calculateWithinHours(site, slot);
  cache.slots.set(key, valid);
  return valid;
}
function calculateWithinHours(site: Site, slot: Slot): boolean {
  const start = DateTime.fromISO(slot.startAt).setZone(site.timezone),
    end = DateTime.fromISO(slot.endAt).setZone(site.timezone);
  if (!start.isValid || !end.isValid || end <= start) return false;
  const { policy } = site;
  const shiftDay=policy.close<=policy.open && start.toFormat('HH:mm')<policy.close?start.minus({days:1}):start;
  const date = shiftDay.toISODate()!;
  if (!policy.weekdays.includes(shiftDay.weekday) || policy.holidays.includes(date)) return false;
  const open = DateTime.fromISO(`${date}T${policy.open}`, { zone: site.timezone });
  let close = DateTime.fromISO(`${date}T${policy.close}`, { zone: site.timezone });
  if (policy.close <= policy.open) close = close.plus({ days: 1 });
  return start >= open && end <= close;
}
export function violations(
  snapshot: Snapshot,
  a: Appointment,
  slot: Slot,
  allocations = snapshot.allocations,
  ignoreEta = false,
): string[] {
  const reasons: string[] = [],
    dock = snapshot.docks.find((d) => d.id === slot.dockId);
  if (!dock) return ['Dock does not belong to this site'];
  if (dock.status !== 'available') reasons.push(`Dock is ${dock.status.replaceAll('_', ' ')}`);
  if (dock.operationType !== 'both' && dock.operationType !== a.operationType)
    reasons.push('Operation type is incompatible');
  if (a.requiredCapabilities.some((c) => !dock.capabilities.includes(c)))
    reasons.push('Required capabilities are missing');
  if (a.lengthMeters && dock.maxLengthMeters && a.lengthMeters > dock.maxLengthMeters)
    reasons.push('Vehicle exceeds dock length');
  if (a.weightTons && dock.maxWeightTons && a.weightTons > dock.maxWeightTons)
    reasons.push('Vehicle exceeds dock weight');
  if (!withinHours(snapshot.site, slot)) reasons.push('Outside operating hours or on a holiday');
  if (a.hardWindow && (slot.startAt < a.earliestStartAt || slot.startAt > a.latestStartAt))
    reasons.push('Outside mandatory service window');
  if (!ignoreEta && a.etaAt && slot.startAt < a.etaAt)
    reasons.push('Service begins before reported ETA');
  if (minutes(slot.endAt, slot.startAt) !== a.durationMinutes)
    reasons.push('Duration does not match appointment');
  if (snapshot.blocks.some((b) => b.dockId === slot.dockId && overlaps(b, slot)))
    reasons.push('Dock is blocked in this interval');
  if (
    allocations.some(
      (b) => b.appointmentId !== a.id && b.dockId === slot.dockId && overlaps(b, slot),
    )
  )
    reasons.push('Dock is already reserved in this interval');
  return reasons;
}
export function transition(visit: Visit, action: string, now: string): Visit {
  const flow: Record<string, [Visit['status'], Visit['status'], keyof Visit]> = {
    'check-in': ['expected', 'checked_in', 'checkedInAt'],
    'start-service': ['checked_in', 'in_service', 'serviceStartedAt'],
    'complete-service': ['in_service', 'service_completed', 'serviceCompletedAt'],
    'check-out': ['service_completed', 'checked_out', 'checkedOutAt'],
  };
  const rule = flow[action];
  assert(rule, 400, 'Unknown visit action');
  assert(
    visit.status === rule[0],
    409,
    `${action} requires ${rule[0]}; current state is ${visit.status}`,
  );
  return { ...visit, status: rule[1], [rule[2]]: now };
}
export const newVisit = (appointmentId: string): Visit => ({
  appointmentId,
  status: 'expected',
  checkedInAt: null,
  serviceStartedAt: null,
  serviceCompletedAt: null,
  checkedOutAt: null,
});
