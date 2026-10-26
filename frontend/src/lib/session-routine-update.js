import { isCardio } from './exercises.js'
import { isWarmupRow } from './workout-model.js'

const clone = value => value == null ? value : structuredClone(value)
const SYNC_KEYS = new Set(['_ts', '_f', '_u'])
const PLAN_KEYS = new Set(['sets', 'reps', 'repsMin', 'sec', 'setsMax', 'weight'])
const DERIVED_TARGET_KEYS = new Set(['id', 'sg', 'rowReps', 'backoffStep'])

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).filter(key => !SYNC_KEYS.has(key)).sort()
    .map(key => [key, canonical(value[key])]))
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

// Superset ids are opaque. A newly paired group and the same group restored from a snapshot are
// the same plan even when their generated ids differ.
function normalizedGroups(ex = []) {
  const groups = new Map()
  let next = 1
  return ex.map(cfg => {
    const copy = canonical(cfg)
    if (copy.sg == null || copy.sg === '') { delete copy.sg; return copy }
    if (!groups.has(copy.sg)) groups.set(copy.sg, `group-${next++}`)
    copy.sg = groups.get(copy.sg)
    return copy
  })
}

const sameExercises = (a, b) => same(normalizedGroups(a), normalizedGroups(b))

function warmupCount(entry) {
  return (entry?.sets || []).filter(isWarmupRow).length
}

function sourceFor(entry, slot) {
  return {
    slot,
    id: entry.id,
    target: clone(entry.target || {}),
    planned: clone(entry.planned || {}),
    warmupSets: warmupCount(entry),
  }
}

/** Capture the plan and per-entry starting point inside a live session. */
export function captureSessionRoutines(routines, entries) {
  const list = Array.isArray(routines) ? routines : []
  const bases = list.map(routine => ({ id: routine.id, routine: clone(routine) }))
  const slots = new Map(list.map(routine => [routine.id, 0]))
  const tagged = (entries || []).map(entry => {
    if (!entry?.rid || !slots.has(entry.rid)) return entry
    const slot = slots.get(entry.rid)
    slots.set(entry.rid, slot + 1)
    return { ...entry, routineSource: sourceFor(entry, slot) }
  })
  return { entries: tagged, routineBases: bases }
}

/** Add a routine to an existing capture when it is appended during a workout. */
export function captureAddedRoutine(active, routine, entries) {
  if (!active || !routine) return entries || []
  active.routineBases = Array.isArray(active.routineBases) ? active.routineBases : []
  if (!active.routineBases.some(base => base.id === routine.id)) {
    active.routineBases.push({ id: routine.id, routine: clone(routine) })
  }
  return (entries || []).map((entry, slot) => ({ ...entry, routineSource: sourceFor(entry, slot) }))
}

/** Routine inherited by an exercise added from the workout-wide button. */
export function routineIdForSessionAdd(active) {
  const current = active?.entries?.[active?.cur]
  if (current?.rid) return current.rid
  const ids = [...new Set([].concat(active?.routineIds || []).filter(Boolean))]
  return ids.length === 1 ? ids[0] : null
}

function patchChangedTarget(cfg, current, initial) {
  const keys = new Set([...Object.keys(initial || {}), ...Object.keys(current || {})])
  for (const key of keys) {
    if (PLAN_KEYS.has(key) || DERIVED_TARGET_KEYS.has(key)) continue
    if (same(current?.[key], initial?.[key])) continue
    if (current?.[key] === undefined) delete cfg[key]
    else cfg[key] = clone(current[key])
  }
}

function applyPlan(cfg, planned) {
  for (const key of PLAN_KEYS) {
    if (planned?.[key] == null) delete cfg[key]
    else cfg[key] = clone(planned[key])
  }
}

function newConfig(entry) {
  const cfg = {}
  for (const [key, value] of Object.entries(entry?.target || {})) {
    if (DERIVED_TARGET_KEYS.has(key) || PLAN_KEYS.has(key)) continue
    cfg[key] = clone(value)
  }
  applyPlan(cfg, entry?.planned || {})
  cfg.id = entry.id
  if (!isCardio(entry.id) && entry?.target?.intensifier?.type !== 'restpause') {
    const warmups = warmupCount(entry)
    if (warmups) cfg.warmupSets = warmups
    else delete cfg.warmupSets
  }
  return cfg
}

function configFor(entry, baseline) {
  const source = entry?.routineSource
  const original = source && baseline?.ex?.[source.slot]
  // A swap keeps the old slot marker, but its new exercise owns a wholly new configuration.
  const cfg = original && source.id === entry.id ? clone(original) : newConfig(entry)
  if (original && source.id === entry.id) {
    patchChangedTarget(cfg, entry.target || {}, source.target || {})
    applyPlan(cfg, entry.planned || {})
    const warmups = warmupCount(entry)
    if (warmups !== source.warmupSets) {
      if (warmups) cfg.warmupSets = warmups
      else delete cfg.warmupSets
    }
    cfg.id = entry.id
  }
  if (entry?.sg != null && entry.sg !== '') cfg.sg = entry.sg
  else delete cfg.sg
  return cfg
}

function routineUnchanged(current, baseline) {
  return same(current, baseline)
}

/**
 * Build the safe routine changes offered after a workout. A changed/deleted current routine is
 * reported as a conflict and never overwritten.
 */
export function planSessionRoutineUpdates(active, routines) {
  const result = { changes: [], conflicts: [] }
  if (!active || active.backfill || !Array.isArray(active.routineBases)) return result
  const current = new Map((routines || []).filter(r => r?.id != null).map(r => [r.id, r]))
  for (const saved of active.routineBases) {
    const baseline = saved?.routine
    if (!baseline?.id) continue
    const ex = (active.entries || []).filter(entry => entry?.rid === baseline.id)
      .map(entry => configFor(entry, baseline))
    // A concurrent edit only matters when this session has something it would overwrite.
    if (sameExercises(ex, baseline.ex || [])) continue
    const now = current.get(baseline.id)
    if (!now) { result.conflicts.push({ id: baseline.id, name: baseline.name, reason: 'deleted' }); continue }
    // The existing per-exercise "Update routine" action may already have applied exactly this
    // candidate during the session. That is success, not a concurrent-edit conflict.
    if (sameExercises(ex, now.ex || [])) continue
    if (!routineUnchanged(now, baseline)) { result.conflicts.push({ id: baseline.id, name: now.name || baseline.name, reason: 'changed' }); continue }
    result.changes.push({ id: baseline.id, name: now.name, ex })
  }
  return result
}

/** Re-check conflicts at tap time, then apply every still-safe update in place. */
export function applySessionRoutineUpdates(state, active) {
  const plan = planSessionRoutineUpdates(active, state?.routines)
  const byId = new Map(plan.changes.map(change => [change.id, change]))
  for (const routine of state?.routines || []) {
    const change = byId.get(routine.id)
    if (change) routine.ex = clone(change.ex)
  }
  return plan
}
