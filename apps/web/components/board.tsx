'use client';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  ArrowDownLeft,
  ArrowUpRight,
  GripVertical,
  LockKeyhole,
  Truck,
  AlertCircle,
} from 'lucide-react';
import type { Appointment, Snapshot, Dock, Allocation } from '@dockslot/domain';
import { localDate, time, shiftBounds } from '../lib/api';
import { Badge } from './ui';
type Props = {
  data: Snapshot & { conflicts: { appointmentId: string; reasons: string[] }[] };
  appointments: Appointment[];
  date: string;
  week: boolean;
  zoom: number;
  onSelect: (id: string) => void;
  canMove: boolean;
  onMove: (id: string, dockId: string, startAt: string) => void;
};
export function Board(props: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const { data, appointments, date, week, zoom, onSelect, onMove, canMove } = props;
  const zone = data.site.timezone;
  const bounds=shiftBounds(date,data.site);
  function dragEnd(event: DragEndEvent) {
    if (!event.over) return;
    const old = data.allocations.find((x) => x.appointmentId === event.active.id);
    if (!old) return;
    const width = document.querySelector('.dock-track')?.getBoundingClientRect().width || 1080;
    const step=data.site.policy.slotMinutes;
    const delta = Math.round(((event.delta.x / width) * bounds.minutes) / step) * step;
    const startAt = new Date(Date.parse(old.startAt) + delta * 60000).toISOString();
    onMove(String(event.active.id), String(event.over.id), startAt);
    sessionStorage.setItem(
      'dockslot-move',
      JSON.stringify({ appointmentId: event.active.id, dockId: event.over.id, startAt }),
    );
  }
  if (week) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(`${date}T12:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    return (
      <div className="week-grid">
        {days.map((day) => (
          <div className="week-day" key={day}>
            <h3>
              {new Date(day + 'T12:00Z').toLocaleDateString('en', {
                weekday: 'short',
                day: 'numeric',
              })}
            </h3>
            {appointments
              .filter(
                (a) =>
                  localDate(
                    new Date(
                      data.allocations.find((x) => x.appointmentId === a.id)?.startAt ||
                        a.earliestStartAt,
                    ),
                    zone,
                  ) === day,
              )
              .map((a) => (
                <button
                  key={a.id}
                  className={`week-card ${a.operationType}`}
                  onClick={() => onSelect(a.id)}
                >
                  <strong>{a.reference}</strong>
                  <span>{a.carrierName}</span>
                  <small>
                    {time(data.allocations.find((x) => x.appointmentId === a.id)?.startAt, zone)} ·{' '}
                    {a.durationMinutes}m
                  </small>
                </button>
              ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <DndContext sensors={sensors} onDragEnd={dragEnd}>
      <div className="timeline-scroll">
        <div
          className="timeline"
          style={{ minWidth: zoom === 15 ? 2100 : zoom === 30 ? 1750 : 1480 }}
        >
          <div className="time-ruler">
            <div className="dock-column">DOCKS</div>
            <div
              className="hour-ruler"
              style={{ gridTemplateColumns: `repeat(${Math.ceil(bounds.minutes / 60)}, 1fr)` }}
            >
              {Array.from({ length: Math.ceil(bounds.minutes / 60) }, (_, i) => (
                <span key={i}>
                  {time(new Date(Date.parse(bounds.startAt) + i * 3600000).toISOString(), zone)}
                </span>
              ))}
            </div>
          </div>
          {data.docks.map((dock) => (
            <DockRow key={dock.id} dock={dock} {...props} />
          ))}
          {appointments.some(
            (a) =>
              !data.allocations.some((x) => x.appointmentId === a.id) && a.status === 'requested',
          ) && (
            <div className="unallocated">
              <span>UNALLOCATED</span>
              {appointments
                .filter(
                  (a) =>
                    !data.allocations.some((x) => x.appointmentId === a.id) &&
                    a.status === 'requested',
                )
                .map((a) => (
                  <button key={a.id} onClick={() => onSelect(a.id)}>
                    {a.reference} <small>{a.carrierName}</small>
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    </DndContext>
  );
}
function DockRow({
  dock,
  data,
  appointments,
  date,
  zoom,
  onSelect,
  canMove,
}: Props & { dock: Dock }) {
  const { setNodeRef, isOver } = useDroppable({ id: dock.id });
  const zone = data.site.timezone, bounds=shiftBounds(date,data.site),
    start = Date.parse(bounds.startAt),
    span = bounds.minutes * 60000;
  const position = (value: string) => ((Date.parse(value) - start) / span) * 100;
  const items = data.allocations.filter(
    (x) =>
      x.dockId === dock.id &&
      appointments.some((a) => a.id === x.appointmentId) &&
      Date.parse(x.endAt)>start&&Date.parse(x.startAt)<start+span,
  );
  const inService = data.visits.some(
    (v) => v.status === 'in_service' && items.some((x) => x.appointmentId === v.appointmentId),
  );
  return (
    <div className={`dock-row ${isOver ? 'drag-over' : ''}`}>
      <div className="dock-column">
        <div className="dock-head">
          <strong>
            <span
              className={`dock-status ${dock.status !== 'available' ? 'disabled' : inService ? 'occupied' : ''}`}
            />
            {dock.code}
          </strong>
          <small className="dock-tag">
            {dock.operationType === 'both'
              ? 'Flex'
              : dock.operationType === 'inbound'
                ? 'In'
                : 'Out'}
          </small>
        </div>
        <span>
          {dock.capabilities.includes('reefer') ? 'Reefer · Liftgate' : 'Standard dock'}
        </span>
        <small className="dock-state">
          {dock.status !== 'available'
            ? dock.status.replaceAll('_', ' ')
            : inService
              ? 'Active service'
              : `${items.length} scheduled`}
        </small>
      </div>
      <div
        className="dock-track"
        ref={setNodeRef}
        style={{ backgroundSize: `${100 / (bounds.minutes / zoom)}% 100%` }}
      >
        {data.blocks
          .filter(
            (b) =>
              b.dockId === dock.id &&
              Date.parse(b.endAt) > start &&
              Date.parse(b.startAt) < start + span,
          )
          .map((b) => (
            <div
              className="block-card"
              key={b.id}
              title={b.reason}
              style={{
                left: `${Math.max(0, position(b.startAt))}%`,
                width: `${Math.min(100, position(b.endAt)) - Math.max(0, position(b.startAt))}%`,
              }}
            >
              <span>Unavailable</span>
              <small>{b.reason}</small>
            </div>
          ))}
        {items.map((allocation) => {
          const a = appointments.find((a) => a.id === allocation.appointmentId)!;
          const visit = data.visits.find((v) => v.appointmentId === a.id);
          return (
            <AppointmentCard
              key={a.id}
              appointment={a}
              allocation={allocation}
              visit={visit?.status || 'expected'}
              conflict={data.conflicts.find((c) => c.appointmentId === a.id)?.reasons.join('; ')}
              left={position(allocation.startAt)}
              width={((Date.parse(allocation.endAt) - Date.parse(allocation.startAt)) / span) * 100}
              zone={zone}
              onSelect={onSelect}
              canMove={canMove}
            />
          );
        })}
      </div>
    </div>
  );
}
function AppointmentCard({
  appointment: a,
  allocation,
  visit,
  conflict,
  left,
  width,
  zone,
  onSelect,
  canMove,
}: {
  appointment: Appointment;
  allocation: Allocation;
  visit: string;
  conflict?: string;
  left: number;
  width: number;
  zone: string;
  onSelect: (id: string) => void;
  canMove: boolean;
}) {
  const locked =
    a.locked ||
    !a.relocationAllowed ||
    ['in_service', 'service_completed', 'checked_out'].includes(visit);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: a.id,
    disabled: !canMove || locked,
  });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onSelect(a.id)}
      className={`appointment-card ${a.operationType} ${visit === 'in_service' ? 'in-service' : ''} ${conflict ? 'conflict' : ''} ${isDragging ? 'dragging' : ''}`}
      style={{
        left: `calc(${left}% + 3px)`,
        width: `calc(${Math.max(width, 3)}% - 6px)`,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
      title={`${a.reference} · ${a.carrierName} · ${visit.replaceAll('_', ' ')}${conflict ? ` · ${conflict}` : ''}`}
    >
      <div className="appointment-top">
        <strong>{a.reference}</strong>
        <span className="appointment-icon">
          {locked ? (
            <LockKeyhole size={11} />
          ) : conflict ? (
            <AlertCircle size={12} />
          ) : a.operationType === 'inbound' ? (
            <ArrowDownLeft size={12} />
          ) : (
            <ArrowUpRight size={12} />
          )}
        </span>
      </div>
      <span>{a.carrierName}</span>
      <div className="appointment-meta">
        <small>
          {time(allocation.startAt, zone)} - {time(allocation.endAt, zone)}
        </small>
        <div className="card-status">
          {visit === 'in_service'
            ? 'In service'
            : visit === 'checked_in'
              ? 'In yard'
              : conflict
                ? 'Delayed'
                : a.locked
                  ? 'Locked'
                  : a.operationType === 'inbound'
                    ? 'Inbound'
                    : 'Outbound'}
        </div>
      </div>
    </button>
  );
}
