import { extend, hasChanged } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { type Dep, globalVersion } from './dep'
import { recordEffectScope } from './effectScope'
import { warn } from './warning'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: Subscriber
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export let activeSub: Subscriber | undefined

export enum EffectFlags {
  ACTIVE = 1 << 0,
  RUNNING = 1 << 1,
  TRACKING = 1 << 2,
  NOTIFIED = 1 << 3,
  DIRTY = 1 << 4,
  ALLOW_RECURSE = 1 << 5,
  NO_BATCH = 1 << 6,
}

/**
 * Subscriber is a type that tracks (or subscribes to) a list of deps.
 */
export interface Subscriber extends DebuggerOptions {
  /**
   * Head of the doubly linked list representing the deps
   * @internal
   */
  deps?: Link
  /**
   * Tail of the same list
   * @internal
   */
  depsTail?: Link
  /**
   * @internal
   */
  flags: EffectFlags
  /**
   * @internal
   */
  notify(): void
}

/**
 * Represents a link between a source (Dep) and a subscriber (Effect or Computed).
 * Deps and subs have a many-to-many relationship - each link between a
 * dep and a sub is represented by a Link instance.
 *
 * A Link is also a node in two doubly-linked lists - one for the associated
 * sub to track all its deps, and one for the associated dep to track all its
 * subs.
 *
 * @internal
 */
export interface Link {
  dep: Dep
  sub: Subscriber

  /**
   * - Before each effect run, all previous dep links' version are reset to -1
   * - During the run, a link's version is synced with the source dep on access
   * - After the run, links with version -1 (that were never used) are cleaned
   *   up
   */
  version: number

  /**
   * Pointers for doubly-linked lists
   */
  nextDep?: Link
  prevDep?: Link

  nextSub?: Link
  prevSub?: Link

  prevActiveLink?: Link
}

export class ReactiveEffect<T = any>
  implements Subscriber, ReactiveEffectOptions
{
  /**
   * @internal
   */
  deps?: Link = undefined
  /**
   * @internal
   */
  depsTail?: Link = undefined
  /**
   * @internal
   */
  flags: EffectFlags = EffectFlags.ACTIVE | EffectFlags.TRACKING
  /**
   * @internal
   */
  nextEffect?: ReactiveEffect = undefined
  /**
   * @internal
   */
  allowRecurse?: boolean

  scheduler?: EffectScheduler = undefined
  onStop?: () => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  constructor(public fn: () => T) {
    recordEffectScope(this)
  }

  /**
   * @internal
   */
  notify() {
    if (this.flags & EffectFlags.RUNNING && !this.allowRecurse) {
      return
    }
    if (this.flags & EffectFlags.NO_BATCH) {
      return this.trigger()
    }
    if (!(this.flags & EffectFlags.NOTIFIED)) {
      this.flags |= EffectFlags.NOTIFIED
      // bwsy: 存储当前 effect 到 nextEffect
      // 当一个响应式变量有多个依赖时， 从 dep 方向会顺着
      // nextEffect 去执行副作用
      this.nextEffect = batchedEffect
      batchedEffect = this
    }
  }

  run() {
    // TODO cleanupEffect

    // bwsy：可能被错误清理，这要再次运行一下 fn
    if (!(this.flags & EffectFlags.ACTIVE)) {
      // stopped during cleanup
      return this.fn()
    }

    // bwsy：处理嵌套场景，先处理深层次的 effect
    // 标记 当前 effect 对象正在执行 fn 函数
    // 初始化 这里 flags 被设置成 7
    this.flags |= EffectFlags.RUNNING
    prepareDeps(this)
    const prevEffect = activeSub
    const prevShouldTrack = shouldTrack
    activeSub = this
    shouldTrack = true

    try {
      debugger
      return this.fn()
    } finally {
      if (__DEV__ && activeSub !== this) {
        warn(
          'Active effect was not restored correctly - ' +
            'this is likely a Vue internal bug.',
        )
      }
      cleanupDeps(this)
      activeSub = prevEffect
      shouldTrack = prevShouldTrack
      this.flags &= ~EffectFlags.RUNNING
      debugger
    }
  }

  stop() {
    if (this.flags & EffectFlags.ACTIVE) {
      // bwsy：二维的双向链结构，effect实例对象的 deps 是一个link 节点，
      // 每一个 link 节点在 x 方向上与上下一个 link（nextSub，prevSub）组成sub双向链
      // 在y轴方向上与上下 link 组成 dep 双向链
      //  停止收集时
      // 遍历这个 link 节点 的 dep 方向链，将这个 link 节点在其 sub 方向链中删除
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link)
      }
      this.deps = this.depsTail = undefined
      this.onStop && this.onStop()
      this.flags &= ~EffectFlags.ACTIVE
    }
  }

  trigger() {
    if (this.scheduler) {
      this.scheduler()
    } else {
      this.runIfDirty()
    }
  }

  /**
   * @internal
   */
  runIfDirty() {
    if (isDirty(this)) {
      this.run()
    }
  }

  get dirty() {
    return isDirty(this)
  }
}

let batchDepth = 0
let batchedEffect: ReactiveEffect | undefined

/**
 * @internal
 */
export function startBatch() {
  batchDepth++
}

/**
 * Run batched effects when all batches have ended
 * @internal
 */
export function endBatch() {
  // bwsy: 减一层 batchDepth
  if (batchDepth > 1) {
    batchDepth--
    return
  }

  // bwsy：顺着 effect 对象的 nextEffect 指针
  // 挨个遍历 effect 对象，去触发依赖运行
  // 这里是由响应式变量变化引起的，一个响应式变量
  // 肯能存在多个依赖，对比海老师图的 dep方向，挨个触发 sub
  let error: unknown
  while (batchedEffect) {
    let e: ReactiveEffect | undefined = batchedEffect
    batchedEffect = undefined
    while (e) {
      const next: ReactiveEffect | undefined = e.nextEffect
      e.nextEffect = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      if (e.flags & EffectFlags.ACTIVE) {
        try {
          e.trigger()
        } catch (err) {
          if (!error) error = err
        }
      }
      e = next
    }
  }

  batchDepth--
  if (error) throw error
}

function prepareDeps(sub: Subscriber) {
  debugger
  // Prepare deps for tracking, starting from the head
  //  从头部开始，在 deps 方向重置 link 节点版本
  for (let link = sub.deps; link; link = link.nextDep) {
    debugger
    // set all previous deps' (if any) version to -1 so that we can track
    // which ones are unused after the run
    link.version = -1
    // store previous active sub if link was being used in another context
    link.prevActiveLink = link.dep.activeLink
    link.dep.activeLink = link
  }
}

function cleanupDeps(sub: Subscriber) {
  // Cleanup unsued deps
  // bwsy：当一个 effect 执行完它的 fn，从尾部开始遍历
  // 如果链上 link 的版本还会 -1 说明没被访问，则将其从
  // 在 dep 方向和 sub 方向进行删除
  let head
  let tail = sub.depsTail
  for (let link = tail; link; link = link.prevDep) {
    if (link.version === -1) {
      if (link === tail) tail = link.prevDep
      // unused - remove it from the dep's subscribing effect list
      removeSub(link)
      // also remove it from this effect's dep list
      removeDep(link)
    } else {
      // The new head is the last node seen which wasn't removed
      // from the doubly-linked list
      head = link
    }

    // restore previous active link if any
    link.dep.activeLink = link.prevActiveLink
    link.prevActiveLink = undefined
  }
  // set the new head & tail
  sub.deps = head
  sub.depsTail = tail
}

function isDirty(sub: Subscriber): boolean {
  for (let link = sub.deps; link; link = link.nextDep) {
    if (
      link.dep.version !== link.version ||
        // bwsy: 注意 refreshComputed 会修改 link.dep.version
      (link.dep.computed && refreshComputed(link.dep.computed) === false) ||
      link.dep.version !== link.version
    ) {
      return true
    }
  }
  // @ts-expect-error only for backwards compatibility where libs manually set
  // this flag - e.g. Pinia's testing module
  if (sub._dirty) {
    return true
  }
  return false
}

/**
 * Returning false indicates the refresh failed
 * @internal
 */
export function refreshComputed(computed: ComputedRefImpl) {
  if (computed.flags & EffectFlags.RUNNING) {
    return false
  }
  if (
    computed.flags & EffectFlags.TRACKING &&
    !(computed.flags & EffectFlags.DIRTY)
  ) {
    return
  }
  computed.flags &= ~EffectFlags.DIRTY

  // Global version fast path when no reactive changes has happened since
  // last refresh.
  if (computed.globalVersion === globalVersion) {
    return
  }
  computed.globalVersion = globalVersion

  const dep = computed.dep
  computed.flags |= EffectFlags.RUNNING
  // In SSR there will be no render effect, so the computed has no subscriber
  // and therefore tracks no deps, thus we cannot rely on the dirty check.
  // Instead, computed always re-evaluate and relies on the globalVersion
  // fast path above for caching.
  if (dep.version > 0 && !computed.isSSR && !isDirty(computed)) {
    computed.flags &= ~EffectFlags.RUNNING
    return
  }

  const prevSub = activeSub
  const prevShouldTrack = shouldTrack
  activeSub = computed
  shouldTrack = true

  try {
    prepareDeps(computed)
    const value = computed.fn()
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      computed._value = value
      dep.version++
    }
  } catch (err) {
    dep.version++
  }

  activeSub = prevSub
  shouldTrack = prevShouldTrack
  cleanupDeps(computed)
  computed.flags &= ~EffectFlags.RUNNING
}

function removeSub(link: Link) {
  const { dep, prevSub, nextSub } = link
  if (prevSub) {
    prevSub.nextSub = nextSub
    link.prevSub = undefined
  }
  if (nextSub) {
    nextSub.prevSub = prevSub
    link.nextSub = undefined
  }
  if (dep.subs === link) {
    // was previous tail, point new tail to prev
    dep.subs = prevSub
  }

  if (!dep.subs && dep.computed) {
    // last subscriber removed
    // if computed, unsubscribe it from all its deps so this computed and its
    // value can be GCed
    dep.computed.flags &= ~EffectFlags.TRACKING
    for (let l = dep.computed.deps; l; l = l.nextDep) {
      removeSub(l)
    }
  }
}

function removeDep(link: Link) {
  const { prevDep, nextDep } = link
  if (prevDep) {
    prevDep.nextDep = nextDep
    link.prevDep = undefined
  }
  if (nextDep) {
    nextDep.prevDep = prevDep
    link.nextDep = undefined
  }
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const e = new ReactiveEffect(fn)
  debugger
  if (options) {
    extend(e, options)
  }
  try {
    e.run()
  } catch (err) {
    e.stop()
    throw err
  }
  const runner = e.run.bind(e) as ReactiveEffectRunner
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

/**
 * @internal
 */
export let shouldTrack = true
const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}
