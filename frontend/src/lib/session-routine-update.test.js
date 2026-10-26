import { describe, expect, it } from 'vitest'
import { captureAddedRoutine, captureSessionRoutines, planSessionRoutineUpdates, applySessionRoutineUpdates, routineIdForSessionAdd } from './session-routine-update.js'

const routine = (id, ex) => ({ id, name: `Routine ${id}`, emoji: 'dumbbell', ex })
const entry = (rid, id, cfg, extra = {}) => ({
  id, rid,
  target: { ...cfg, weight: (cfg.weight || 0) + 2.5 },
  planned: Object.fromEntries(['sets', 'reps', 'repsMin', 'sec', 'setsMax', 'weight'].filter(k => cfg[k] != null).map(k => [k, cfg[k]])),
  sets: Array.from({ length: cfg.sets || 1 }, () => ({ w: cfg.weight || 0, r: cfg.reps || 1 })),
  ...extra,
})

function activeFrom(routines) {
  const entries = routines.flatMap(r => r.ex.map(cfg => entry(r.id, cfg.id, cfg, cfg.sg ? { sg: cfg.sg } : {})))
  const captured = captureSessionRoutines(routines, entries)
  return { id: 'workout', routineIds: routines.map(r => r.id), ...captured }
}

describe('session routine updates', () => {
  it('does not read an automatic prescription or performed rows as a routine edit', () => {
    const r = routine('A', [{ id: 'bench', sets: 2, reps: 10, weight: 50 }])
    const active = activeFrom([r])
    active.entries[0].target.weight = 55
    active.entries[0].sets.push({ w: 70, r: 4, done: true })
    active.entries[0].sets[0].r = 15
    expect(planSessionRoutineUpdates(active, [r])).toEqual({ changes: [], conflicts: [] })
  })

  it('offers additions, removals and reordering using the full active session', () => {
    const r = routine('A', [
      { id: 'b', sets: 2, reps: 10, weight: 10 },
      { id: 'c', sets: 3, reps: 8, weight: 20 },
    ])
    const active = activeFrom([r])
    const added = entry('A', 'd', { id: 'd', sets: 4, reps: 6, weight: 30 })
    active.entries = [added, active.entries[1]]
    const [change] = planSessionRoutineUpdates(active, [r]).changes
    expect(change.ex.map(e => e.id)).toEqual(['d', 'c'])
    expect(change.ex[0]).toMatchObject({ sets: 4, reps: 6, weight: 30 })
  })

  it('detects a pure reorder and an in-place swap', () => {
    const r = routine('A', [
      { id: 'b', sets: 2, reps: 10, weight: 10 },
      { id: 'c', sets: 3, reps: 8, weight: 20 },
    ])
    const active = activeFrom([r])
    active.entries.reverse()
    expect(planSessionRoutineUpdates(active, [r]).changes[0].ex.map(e => e.id)).toEqual(['c', 'b'])

    const swapped = activeFrom([r])
    swapped.entries[0] = { ...entry('A', 'd', { id: 'd', sets: 4, reps: 6, weight: 30 }), routineSource: swapped.entries[0].routineSource }
    expect(planSessionRoutineUpdates(swapped, [r]).changes[0].ex.map(e => e.id)).toEqual(['d', 'c'])
  })

  it('keeps unchecked exercises because it reads active rather than the filtered workout', () => {
    const r = routine('A', [{ id: 'b', sets: 2, reps: 10, weight: 10 }, { id: 'c', sets: 2, reps: 10, weight: 10 }])
    const active = activeFrom([r])
    active.entries[0].sets[0].done = true
    expect(planSessionRoutineUpdates(active, [r]).changes).toEqual([])
  })

  it('copies explicit planned configuration and setup changes, not logged values', () => {
    const r = routine('A', [{ id: 'b', sets: 2, reps: 10, weight: 50, restSec: 90 }])
    const active = activeFrom([r])
    const e = active.entries[0]
    e.planned = { ...e.planned, sets: 3, reps: 8, weight: 45 }
    e.target = { ...e.target, sets: 3, reps: 8, weight: 45, restSec: 120 }
    e.sets = [{ warmup: true, w: 20, r: 8 }, { w: 45, r: 20, done: true }, { w: 45, r: 8 }, { w: 45, r: 8 }]
    const [change] = planSessionRoutineUpdates(active, [r]).changes
    expect(change.ex[0]).toMatchObject({ sets: 3, reps: 8, weight: 45, restSec: 120, warmupSets: 1 })
  })

  it('normalizes superset ids but detects pairing and unpairing', () => {
    const r = routine('A', [
      { id: 'b', sets: 2, reps: 10, weight: 10, sg: 'old' },
      { id: 'c', sets: 2, reps: 10, weight: 10, sg: 'old' },
    ])
    const active = activeFrom([r])
    active.entries.forEach(e => { e.sg = 'new-generated-id' })
    expect(planSessionRoutineUpdates(active, [r]).changes).toEqual([])
    delete active.entries[1].sg
    expect(planSessionRoutineUpdates(active, [r]).changes).toHaveLength(1)
  })

  it('handles combined sessions independently and refuses a concurrently edited routine', () => {
    const a = routine('A', [{ id: 'a', sets: 2, reps: 10, weight: 10 }])
    const b = routine('B', [{ id: 'b', sets: 2, reps: 10, weight: 20 }])
    const active = activeFrom([a, b])
    active.entries.push(entry('A', 'new', { id: 'new', sets: 1, reps: 5, weight: 5 }))
    active.entries.push(entry('B', 'new-b', { id: 'new-b', sets: 1, reps: 5, weight: 5 }))
    const changedB = structuredClone(b)
    changedB.name = 'Edited elsewhere'
    const plan = planSessionRoutineUpdates(active, [a, changedB])
    expect(plan.changes.map(c => c.id)).toEqual(['A'])
    expect(plan.conflicts).toEqual([{ id: 'B', name: 'Edited elsewhere', reason: 'changed' }])
  })

  it('ignores a concurrent routine edit when this session itself made no plan change', () => {
    const r = routine('A', [{ id: 'a', sets: 2, reps: 10, weight: 10 }])
    const active = activeFrom([r])
    const changed = { ...structuredClone(r), name: 'Edited elsewhere' }
    expect(planSessionRoutineUpdates(active, [changed])).toEqual({ changes: [], conflicts: [] })
  })

  it('treats a routine already updated to the session candidate as applied, not conflicted', () => {
    const r = routine('A', [{ id: 'a', sets: 2, reps: 10, weight: 10, restSec: 90 }])
    const active = activeFrom([r])
    active.entries[0].target.restSec = 120
    const alreadyApplied = structuredClone(r)
    alreadyApplied.ex[0].restSec = 120
    expect(planSessionRoutineUpdates(active, [alreadyApplied])).toEqual({ changes: [], conflicts: [] })
  })

  it('assigns the sole routine when an emptied session adds its next exercise', () => {
    expect(routineIdForSessionAdd({ cur: 0, entries: [], routineIds: ['A'] })).toBe('A')
    expect(routineIdForSessionAdd({ cur: 0, entries: [], routineIds: ['A', 'B'] })).toBeNull()
  })

  it('re-checks conflicts when applying and never overwrites a deleted routine', () => {
    const a = routine('A', [{ id: 'a', sets: 2, reps: 10, weight: 10 }])
    const b = routine('B', [{ id: 'b', sets: 2, reps: 10, weight: 20 }])
    const active = activeFrom([a, b])
    active.entries.push(entry('A', 'new', { id: 'new', sets: 1, reps: 5, weight: 5 }))
    active.entries.push(entry('B', 'new-b', { id: 'new-b', sets: 1, reps: 5, weight: 5 }))
    const state = { routines: [structuredClone(a)] }
    const applied = applySessionRoutineUpdates(state, active)
    expect(applied.changes.map(c => c.id)).toEqual(['A'])
    expect(applied.conflicts).toEqual([{ id: 'B', name: 'Routine B', reason: 'deleted' }])
    expect(state.routines[0].ex.map(e => e.id)).toEqual(['a', 'new'])
  })

  it('captures a routine added during the session and skips backfills and freestyle', () => {
    const a = routine('A', [{ id: 'a', sets: 2, reps: 10, weight: 10 }])
    const active = { id: 'workout', entries: [], routineIds: [] }
    const entries = captureAddedRoutine(active, a, [entry('A', 'a', a.ex[0])])
    active.entries.push(...entries)
    expect(planSessionRoutineUpdates(active, [a]).changes).toEqual([])
    active.backfill = { durationMin: 30 }
    expect(planSessionRoutineUpdates(active, [a])).toEqual({ changes: [], conflicts: [] })
    expect(planSessionRoutineUpdates({ entries: [], routineIds: [] }, [a])).toEqual({ changes: [], conflicts: [] })
  })
})
