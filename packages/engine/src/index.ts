import {
  addMinutes,
  fixed,
  minutes,
  sameSlot,
  violations,
  type Allocation,
  type Appointment,
  type Proposal,
  type ReplanRequest,
  type Slot,
  type Snapshot,
} from '@dockslot/domain';

/** Pure deterministic heuristic. All clocks and IDs are supplied by the caller. */
export function searchSlots(
  snapshot: Snapshot,
  a: Appointment,
  startAt: string,
  endAt: string,
  allocations = snapshot.allocations,
): { slots: Slot[]; reasons: string[] } {
  const slots: Slot[] = [],
    reasons = new Set<string>(),
    step = snapshot.site.policy.slotMinutes * 60000;
  const earliest = Math.max(
    Date.parse(startAt),
    a.hardWindow ? Date.parse(a.earliestStartAt) : 0,
    a.etaAt ? Date.parse(a.etaAt) : 0,
  );
  const last = Math.min(
    Date.parse(endAt) - a.durationMinutes * 60000,
    a.hardWindow ? Date.parse(a.latestStartAt) : Infinity,
  );
  for (const dock of [...snapshot.docks].sort((a, b) => a.id.localeCompare(b.id))) {
    const occupied = allocations.filter(x => x.dockId === dock.id && x.appointmentId !== a.id).map(x => ({ start: Date.parse(x.startAt), end: Date.parse(x.endAt) }));
    for (let at = Math.ceil(earliest / step) * step; at <= last; at += step) {
      const end = at + a.durationMinutes * 60000;
      if (occupied.some(x => at < x.end && x.start < end)) { reasons.add('Dock is already reserved in this interval'); continue; }
      const slot = {
        dockId: dock.id,
        startAt: new Date(at).toISOString(),
        endAt: new Date(at + a.durationMinutes * 60000).toISOString(),
      };
      const errors = violations(snapshot, a, slot, []);
      if (!errors.length) slots.push(slot);
      else errors.forEach((r) => reasons.add(r));
    }
  }
  if (!slots.length && !reasons.size)
    reasons.add('No interval fits the ETA, duration and mandatory window');
  return { slots, reasons: [...reasons].sort() };
}
export function replan(
  input: Snapshot,
  request: ReplanRequest,
  proposalId = 'simulation',
): Proposal {
  const snapshot = structuredClone(input);
  for (const override of request.overrides) {
    const a = snapshot.appointments.find((a) => a.id === override.appointmentId);
    if (
      !a ||
      fixed(
        a,
        snapshot.visits.find((v) => v.appointmentId === a.id),
      )
    )
      continue;
    if (override.etaAt) a.etaAt = override.etaAt;
    // An override can pin an item, never unlock an existing manual lock.
    if (override.locked) a.locked = true;
  }
  const relevant = snapshot.appointments.filter(
    (a) =>
      ['requested', 'confirmed'].includes(a.status) &&
      a.earliestStartAt < request.endAt &&
      a.latestStartAt >= request.startAt,
  );
  const immutable = new Set(
    snapshot.appointments
      .filter(
        (a) =>
          fixed(
            a,
            snapshot.visits.find((v) => v.appointmentId === a.id),
          ) || !relevant.includes(a),
      )
      .map((a) => a.id),
  );
  let allocations = snapshot.allocations.filter((a) => immutable.has(a.appointmentId));
  const weights = request.weights || snapshot.site.policy.weights,
    weightSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const cost = (a: Appointment, slot: Slot, old?: Allocation) => {
    const waiting = a.etaAt ? Math.max(0, minutes(slot.startAt, a.etaAt)) : 0;
    const movement =
      old && !sameSlot(old, slot)
        ? 30 +
          Math.abs(minutes(slot.startAt, old.startAt)) / 4 +
          (slot.dockId !== old.dockId ? 15 : 0)
        : 0;
    const late = Math.max(0, minutes(slot.startAt, a.latestStartAt));
    const gaps = allocations
      .filter((x) => x.dockId === slot.dockId && x.endAt <= slot.startAt)
      .map((x) => minutes(slot.startAt, x.endAt));
    const gap = gaps.length ? Math.min(...gaps) : 0;
    return (
      (waiting * weights.waiting +
        movement * weights.movement +
        late * weights.sla * a.priority +
        (gap > 0 && gap < a.durationMinutes ? gap : 0) * weights.fragmentation) /
      weightSum
    );
  };
  const priority = (a: Appointment) =>
    a.priority +
    Math.floor(
      Math.max(0, minutes(request.startAt, a.createdAt)) / snapshot.site.policy.fairnessMinutes,
    );
  const ordered = relevant
    .filter((a) => !immutable.has(a.id))
    .sort(
      (a, b) =>
        a.latestStartAt.localeCompare(b.latestStartAt) ||
        priority(b) - priority(a) ||
        (a.etaAt || a.earliestStartAt).localeCompare(b.etaAt || b.earliestStartAt) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const unscheduled: Proposal['unscheduled'] = [];
  for (const a of ordered) {
    const old = snapshot.allocations.find((x) => x.appointmentId === a.id);
    const { slots, reasons } = searchSlots(
      snapshot,
      a,
      request.startAt,
      request.endAt,
      allocations,
    );
    if (
      old &&
      old.startAt >= request.startAt &&
      old.endAt <= request.endAt &&
      !violations(snapshot, a, old, allocations).length &&
      !slots.some((s) => sameSlot(s, old))
    )
      slots.push(old);
    const scores = new Map(slots.map(slot => [slot, cost(a, slot, old)]));
    slots.sort(
      (x, y) =>
        scores.get(x)! - scores.get(y)! ||
        x.startAt.localeCompare(y.startAt) ||
        x.dockId.localeCompare(y.dockId),
    );
    if (slots[0])
      allocations.push({
        ...slots[0],
        id: `candidate_${a.id}`,
        appointmentId: a.id,
        planVersion: snapshot.site.currentPlanVersion + 1,
      });
    else unscheduled.push({ appointmentId: a.id, reasons });
  }
  // Bounded reinsertion improves the greedy solution without changing immutable jobs.
  for (const a of ordered.slice(0, 200)) {
    const current = allocations.find((x) => x.appointmentId === a.id);
    if (!current) continue;
    const old = snapshot.allocations.find((x) => x.appointmentId === a.id);
    const candidates = searchSlots(snapshot, a, request.startAt, request.endAt, allocations).slots;
    const scores = new Map(candidates.map(slot => [slot, cost(a, slot, old)]));
    candidates.sort(
      (x, y) =>
        scores.get(x)! - scores.get(y)! ||
        x.startAt.localeCompare(y.startAt) ||
        x.dockId.localeCompare(y.dockId),
    );
    if (candidates[0] && cost(a, candidates[0], old) < cost(a, current, old))
      allocations = allocations.map((x) => (x === current ? { ...x, ...candidates[0] } : x));
  }
  const assignments = relevant.map((a) => {
    const from = snapshot.allocations.find((x) => x.appointmentId === a.id) || null,
      to = allocations.find((x) => x.appointmentId === a.id) || null;
    const pinned = immutable.has(a.id),
      reasons: string[] = [];
    if (pinned)
      reasons.push('Preserved: manual lock, relocation restriction or service already started');
    else if (!to)
      reasons.push('No feasible slot; existing allocation will not be silently removed');
    else if (sameSlot(from, to)) reasons.push('Kept the communicated assignment');
    else {
      if (from) reasons.push(...violations(snapshot, a, from));
      if (!from) reasons.push('Assigned a compatible available dock');
      if (from && from.dockId !== to.dockId)
        reasons.push('Moved to a compatible dock to restore capacity');
      if (!reasons.length) reasons.push('Reduced weighted waiting and schedule disruption');
    }
    return { appointmentId: a.id, from, to, locked: pinned, reasons };
  });
  // Existing completed services are historical facts. Active fixed conflicts prevent application.
  const hard = assignments
    .filter((x) => x.to)
    .flatMap((x) => {
      const a = snapshot.appointments.find((a) => a.id === x.appointmentId)!;
      const visit = snapshot.visits.find((v) => v.appointmentId === a.id);
      return violations(snapshot, a, x.to!, allocations, visit?.status === 'in_service');
    });
  const known = relevant.filter((a) => a.etaAt);
  const waiting = (items: Allocation[]) =>
    known.length
      ? known.reduce((sum, a) => {
          const slot = items.find((s) => s.appointmentId === a.id);
          return sum + (slot ? Math.max(0, minutes(slot.startAt, a.etaAt!)) : 0);
        }, 0)
      : null;
  return {
    id: proposalId,
    reason: request.reason,
    algorithmVersion: 'greedy-reinsert-v1',
    baselinePlanVersion: snapshot.site.currentPlanVersion,
    assignments,
    unscheduled,
    applicable: !unscheduled.length && !hard.length,
    warnings: relevant
      .filter((a) => !a.etaAt)
      .map((a) => `${a.reference}: ETA unknown; excluded from projected waiting`),
    metrics: {
      movedCount: assignments.filter((a) => !sameSlot(a.from, a.to)).length,
      totalProjectedWaitingMinutes: waiting(allocations),
      baselineProjectedWaitingMinutes: waiting(snapshot.allocations),
      lateMinutes: known.length
        ? assignments.reduce(
            (sum, x) =>
              sum +
              (x.to
                ? Math.max(
                    0,
                    minutes(
                      x.to.startAt,
                      snapshot.appointments.find((a) => a.id === x.appointmentId)!.latestStartAt,
                    ),
                  )
                : 0),
            0,
          )
        : null,
      hardConstraintViolations: hard.length,
    },
  };
}
