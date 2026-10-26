// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { beginWorkout, finishWorkout } from './sheets.jsx'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { EXDB } from './lib/exercises-data.js'
import { isWarmupRow } from './lib/workout-model.js'

const clone = value => structuredClone(value)
const BENCH = EXDB[0].id
const ADDED = EXDB.find(ex => ex.id !== BENCH).id
const S = () => useStore.getState().S
const mounted = []

function install() {
  const st = clone(DEF)
  Object.assign(st, {
    routines: [{ id: 'A', name: 'Routine A', emoji: 'dumbbell', ex: [{ id: BENCH, sets: 1, reps: 5, weight: 20 }] }],
    week: { 1: ['A'] }, active: null, workouts: [], weighIn: false,
  })
  useStore.setState({ S: st, user: null })
  act(() => beginWorkout(['A'], null))
}

function completeWithAddedExercise() {
  act(() => useStore.getState().update(state => {
    const first = state.active.entries[0]
    first.sets.filter(row => !isWarmupRow(row)).forEach(row => { row.done = true })
    const added = clone(first)
    added.id = ADDED
    added.target = { ...added.target, id: ADDED, sets: 1, reps: 8, weight: 10 }
    added.planned = { sets: 1, reps: 8, weight: 10 }
    added.sets = [{ w: 10, r: 8, done: true }]
    delete added.routineSource
    state.active.entries.push(added)
  }))
}

function renderTopSheet() {
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}

function tap(host, text) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text)
  expect(button, text).toBeTruthy()
  act(() => button.click())
}

beforeEach(() => {
  localStorage.clear()
  useUI.getState().stopRest()
  useUI.getState().stopWork()
  useUI.setState({ sheets: [], timer: null, work: null })
})

afterEach(() => {
  mounted.splice(0).forEach(root => act(() => root.unmount()))
  document.body.innerHTML = ''
})

describe('persisting live session changes into a routine', () => {
  it('saves the workout before asking, then updates the routine when accepted', () => {
    install()
    completeWithAddedExercise()

    act(() => finishWorkout())

    expect(S().active).toBeNull()
    expect(S().workouts).toHaveLength(1)
    expect(S().workouts[0].entries.map(entry => entry.id)).toEqual([BENCH, ADDED])
    expect(S().routines[0].ex.map(entry => entry.id)).toEqual([BENCH])
    const prompt = renderTopSheet()
    expect(prompt.textContent).toContain('Update routine?')

    tap(prompt, 'Update routine')

    expect(S().routines[0].ex.map(entry => entry.id)).toEqual([BENCH, ADDED])
    expect(useUI.getState().sheets.at(-1)).toBeTruthy() // finish summary
  })

  it('keeps the routine unchanged when declined', () => {
    install()
    completeWithAddedExercise()
    act(() => finishWorkout())
    const prompt = renderTopSheet()

    tap(prompt, 'Keep routine as is')

    expect(S().workouts).toHaveLength(1)
    expect(S().routines[0].ex.map(entry => entry.id)).toEqual([BENCH])
  })

  it('goes straight to the summary when the session did not change the routine', () => {
    install()
    act(() => useStore.getState().update(state => {
      state.active.entries[0].sets.filter(row => !isWarmupRow(row)).forEach(row => { row.done = true })
    }))

    act(() => finishWorkout())

    const summary = renderTopSheet()
    expect(summary.textContent).not.toContain('Update routine?')
    expect(S().routines[0].ex.map(entry => entry.id)).toEqual([BENCH])
  })

  it('warns and refuses to overwrite a routine changed after the workout began', () => {
    install()
    completeWithAddedExercise()
    act(() => useStore.getState().update(state => { state.routines[0].name = 'Changed elsewhere' }))

    act(() => finishWorkout())

    expect(S().workouts).toHaveLength(1)
    const warning = renderTopSheet()
    expect(warning.textContent).toContain('Routine changed elsewhere')
    tap(warning, 'Continue')
    expect(S().routines[0].name).toBe('Changed elsewhere')
    expect(S().routines[0].ex.map(entry => entry.id)).toEqual([BENCH])
  })

  it('reports both the applied update and the skipped conflict in a combined session', () => {
    const st = clone(DEF)
    const second = EXDB.find(ex => ex.id !== BENCH && ex.id !== ADDED).id
    Object.assign(st, {
      routines: [
        { id: 'A', name: 'Routine A', ex: [{ id: BENCH, sets: 1, reps: 5, weight: 20 }] },
        { id: 'B', name: 'Routine B', ex: [{ id: ADDED, sets: 1, reps: 8, weight: 10 }] },
      ], active: null, workouts: [], weighIn: false,
    })
    useStore.setState({ S: st, user: null })
    act(() => beginWorkout(['A', 'B'], null))
    act(() => useStore.getState().update(state => {
      state.active.entries.forEach(entry => entry.sets.filter(row => !isWarmupRow(row)).forEach(row => { row.done = true }))
      const add = (source, rid, id) => {
        const added = clone(source)
        added.id = id
        added.rid = rid
        added.target = { ...added.target, id, sets: 1, reps: 6, weight: 5 }
        added.planned = { sets: 1, reps: 6, weight: 5 }
        added.sets = [{ w: 5, r: 6, done: true }]
        delete added.routineSource
        state.active.entries.push(added)
      }
      add(state.active.entries[0], 'A', second)
      add(state.active.entries[1], 'B', second)
      state.routines[1].name = 'Routine B elsewhere'
    }))

    act(() => finishWorkout())
    const prompt = renderTopSheet()
    expect(prompt.textContent).toContain('will not be overwritten')
    tap(prompt, 'Update routine')

    expect(S().routines[0].ex.map(entry => entry.id)).toEqual([BENCH, second])
    expect(S().routines[1].ex.map(entry => entry.id)).toEqual([ADDED])
    expect(useUI.getState().toastMsg).toBe('Routine updated; another routine changed elsewhere and was not overwritten.')
  })
})
