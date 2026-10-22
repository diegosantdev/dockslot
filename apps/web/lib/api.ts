import { DateTime } from 'luxon';
import type { Site } from '@dockslot/domain';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/v1${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(data.error || 'Request failed', response.status, data.details);
  return data as T;
}
export const labels = {
  en: {
    board: 'Dock board',
    recovery: 'Recovery',
    gate: 'Gate & yard',
    metrics: 'Metrics',
    settings: 'Settings',
    newBooking: 'New appointment',
    live: 'Live updates',
    today: 'Today',
    title: 'Appointments and availability by dock.',
  },
  pt: {
    board: 'Quadro de docas',
    recovery: 'Recuperação',
    gate: 'Portaria e pátio',
    metrics: 'Métricas',
    settings: 'Configurações',
    newBooking: 'Nova reserva',
    live: 'Atualizações ao vivo',
    today: 'Hoje',
    title: 'Agendamentos e disponibilidade por doca.',
  },
};
export const time = (value: string | null | undefined, zone: string) =>
  value
    ? new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: zone,
      }).format(new Date(value))
    : '-';
export const localDate = (value: Date, zone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
export function zonedISO(date: string, clock: string, zone: string) {
  const value = DateTime.fromISO(`${date}T${clock}`, { zone });
  if (!value.isValid || value.toFormat('yyyy-MM-dd HH:mm') !== `${date} ${clock}`)
    throw new Error(
      'This local time does not exist in the facility timezone. Choose another time.',
    );
  const options = value.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis());
  return options[0].toUTC().toISO()!;
}
export function shiftBounds(date: string, site: Site) {
  const startAt = zonedISO(date, site.policy.open, site.timezone);
  const endDate =
    site.policy.close <= site.policy.open
      ? DateTime.fromISO(date).plus({ days: 1 }).toISODate()!
      : date;
  const endAt = zonedISO(endDate, site.policy.close, site.timezone);
  return { startAt, endAt, minutes: (Date.parse(endAt) - Date.parse(startAt)) / 60000 };
}
