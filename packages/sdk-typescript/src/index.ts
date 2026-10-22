export type { Appointment, Site, Dock, Proposal, ReplanRequest, Snapshot } from '@dockslot/domain';
import type { Appointment, Proposal, ReplanRequest, Snapshot } from '@dockslot/domain';
export class DockSlotError extends Error {
  constructor(
    public status: number,
    public response: unknown,
  ) {
    super(`DockSlot request failed (${status})`);
  }
}
export class DockSlot {
  constructor(private options: { baseUrl: string; token: string; fetch?: typeof fetch }) {}
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await (this.options.fetch || fetch)(
      `${this.options.baseUrl.replace(/\/$/, '')}/v1${path}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
    );
    const body = await response.json();
    if (!response.ok) throw new DockSlotError(response.status, body);
    return body;
  }
  calendar(siteId: string) {
    return this.request<Snapshot>(`/sites/${encodeURIComponent(siteId)}/calendar`);
  }
  createAppointment(input: unknown, idempotencyKey: string) {
    return this.request<Appointment>('/appointments', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }
  updateEta(appointmentId: string, etaAt: string) {
    return this.request<Appointment>(`/appointments/${encodeURIComponent(appointmentId)}/eta`, {
      method: 'POST',
      body: JSON.stringify({ etaAt }),
    });
  }
  propose(siteId: string, input: ReplanRequest) {
    return this.request<Proposal>(`/sites/${encodeURIComponent(siteId)}/replans`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  apply(proposal: Proposal) {
    return this.request<{ planVersion: number }>(
      `/replans/${encodeURIComponent(proposal.id)}/apply`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedPlanVersion: proposal.baselinePlanVersion }),
      },
    );
  }
}
