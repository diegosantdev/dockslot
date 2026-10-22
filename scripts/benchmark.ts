import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { fixture, request } from '../tests/fixtures.js';
import { replan } from '@dockslot/engine';
const s = fixture(200, 20);
s.appointments[0].etaAt = '2026-11-04T14:30:00.000Z';
const start = performance.now();
const p = replan(s, request);
console.log(
  JSON.stringify(
    {
      node: process.version,
      cpu: cpus()[0].model,
      ramGB: Math.round(totalmem() / 2 ** 30),
      appointments: 200,
      docks: 20,
      durationMs: Math.round(performance.now() - start),
      applicable: p.applicable,
      moved: p.metrics.movedCount,
      unscheduled: p.unscheduled.length,
      violations: p.metrics.hardConstraintViolations,
    },
    null,
    2,
  ),
);
