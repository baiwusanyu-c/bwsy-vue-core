import {
  VNode,
  normalizeVNode,
  VNodeProps,
  isSameVNodeType,
  openBlock,
  closeBlock,
  currentBlock,
  Comment,
  createVNode,
  isBlockTreeEnabled
} from '../vnode'
import { isFunction, isArray, ShapeFlags, toNumber } from '@vue/shared'
import { ComponentInternalInstance, handleSetupResult } from '../component'
import { Slots } from '../componentSlots'
import {
  RendererInternals,
  MoveType,
  SetupRenderEffectFn,
  RendererNode,
  RendererElement
} from '../renderer'
import { queuePostFlushCb } from '../scheduler'
import { filterSingleRoot, updateHOCHostEl } from '../componentRenderUtils'
import {
  pushWarningContext,
  popWarningContext,
  warn,
  assertNumber
} from '../warning'
import { handleError, ErrorCodes } from '../errorHandling'

export interface SuspenseProps {
  onResolve?: () => void
  onPending?: () => void
  onFallback?: () => void
  timeout?: string | number
}

export const isSuspense = (type: any): boolean => type.__isSuspense

// Suspense exposes a component-like API, and is treated like a component
// in the compiler, but internally it's a special built-in type that hooks
// directly into the renderer.
export const SuspenseImpl = {
  name: 'Suspense',
  // In order to make Suspense tree-shakable, we need to avoid importing it
  // directly in the renderer. The renderer checks for the __isSuspense flag
  // on a vnode's type and calls the `process` method, passing in renderer
  // internals.
  __isSuspense: true,
  process(
    n1: VNode | null,
    n2: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    isSVG: boolean,
    slotScopeIds: string[] | null,
    optimized: boolean,
    // platform-specific impl passed from renderer
    rendererInternals: RendererInternals
  ) {
    // 挂在 suspense
    if (n1 == null) {
      mountSuspense(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        isSVG,
        slotScopeIds,
        optimized,
        rendererInternals
      )
    } else {
      // 更新 suspense TODO
      patchSuspense(
        n1,
        n2,
        container,
        anchor,
        parentComponent,
        isSVG,
        slotScopeIds,
        optimized,
        rendererInternals
      )
    }
  },
  hydrate: hydrateSuspense, // 水合方法
  // 创建 suspense 边界
  // （suspense 插槽内的子组件可能会是多个或深层次的异步组件，需要确定 pending 边界）
  create: createSuspenseBoundary,
  normalize: normalizeSuspenseChildren // 标准化 suspense 的 children
}

// Force-casted public typing for h and TSX props inference
export const Suspense = (__FEATURE_SUSPENSE__
  ? SuspenseImpl
  : null) as unknown as {
  __isSuspense: true
  new (): { $props: VNodeProps & SuspenseProps }
}

// 触发 suspense 的相关钩子方法
function triggerEvent(
  vnode: VNode,
  name: 'onResolve' | 'onPending' | 'onFallback'
) {
  const eventListener = vnode.props && vnode.props[name]
  if (isFunction(eventListener)) {
    eventListener()
  }
}

function mountSuspense(
  vnode: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals
) {
  // 从内置的 helper 方法中获取 patch vnode 方法、创建元素方法
  const {
    p: patch,
    o: { createElement }
  } = rendererInternals
  // 创建一个 容器 div，
  const hiddenContainer = createElement('div')
  // 创建 suspense 边界实例 TODO
  const suspense = (vnode.suspense = createSuspenseBoundary(
    vnode,
    parentSuspense,
    parentComponent,
    container,
    hiddenContainer,
    anchor,
    isSVG,
    slotScopeIds,
    optimized,
    rendererInternals
  ))

  // start mounting the content subtree in an off-dom container
  // 开始挂载时，将其挂载到 hiddenContainer 下
  patch(
    null,
    (suspense.pendingBranch = vnode.ssContent!),
    hiddenContainer,
    null,
    parentComponent,
    suspense,
    isSVG,
    slotScopeIds
  )
  // now check if we have encountered any async deps
  // 检查是否遇到了异步依赖，
  // 即第一遍 mount 完，立即检查一次 deps，是否有异步组件，
  // 有异步组件，就切换到后备插槽分支， fallback
  if (suspense.deps > 0) {
    // has async
    // invoke @fallback event
    // 触发钩子
    triggerEvent(vnode, 'onPending')
    triggerEvent(vnode, 'onFallback')

    // mount the fallback tree
    // 挂载后备内容 fallback
    patch(
      null,
      vnode.ssFallback!,
      container,
      anchor,
      parentComponent,
      null, // fallback tree will not have suspense context
      isSVG,
      slotScopeIds
    )
    // 有异步组件，就切换到后备插槽分支， fallback
    setActiveBranch(suspense, vnode.ssFallback!)
  } else {
    // 没有异步依赖组件，就直接 resolve
    // Suspense has no async deps. Just resolve.
    suspense.resolve()
  }
}
// 更新 suspense TODO
function patchSuspense(
  n1: VNode,
  n2: VNode,
  container: RendererElement,
  anchor: RendererNode | null,
  parentComponent: ComponentInternalInstance | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  { p: patch, um: unmount, o: { createElement } }: RendererInternals
) {
  const suspense = (n2.suspense = n1.suspense)!
  suspense.vnode = n2
  n2.el = n1.el
  const newBranch = n2.ssContent!
  const newFallback = n2.ssFallback!

  const { activeBranch, pendingBranch, isInFallback, isHydrating } = suspense
  if (pendingBranch) {
    suspense.pendingBranch = newBranch
    if (isSameVNodeType(newBranch, pendingBranch)) {
      // same root type but content may have changed.
      patch(
        pendingBranch,
        newBranch,
        suspense.hiddenContainer,
        null,
        parentComponent,
        suspense,
        isSVG,
        slotScopeIds,
        optimized
      )
      if (suspense.deps <= 0) {
        suspense.resolve()
      } else if (isInFallback) {
        patch(
          activeBranch,
          newFallback,
          container,
          anchor,
          parentComponent,
          null, // fallback tree will not have suspense context
          isSVG,
          slotScopeIds,
          optimized
        )
        setActiveBranch(suspense, newFallback)
      }
    } else {
      // toggled before pending tree is resolved
      suspense.pendingId++
      if (isHydrating) {
        // if toggled before hydration is finished, the current DOM tree is
        // no longer valid. set it as the active branch so it will be unmounted
        // when resolved
        suspense.isHydrating = false
        suspense.activeBranch = pendingBranch
      } else {
        unmount(pendingBranch, parentComponent, suspense)
      }
      // increment pending ID. this is used to invalidate async callbacks
      // reset suspense state
      suspense.deps = 0
      // discard effects from pending branch
      suspense.effects.length = 0
      // discard previous container
      suspense.hiddenContainer = createElement('div')

      if (isInFallback) {
        // already in fallback state
        patch(
          null,
          newBranch,
          suspense.hiddenContainer,
          null,
          parentComponent,
          suspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        if (suspense.deps <= 0) {
          suspense.resolve()
        } else {
          patch(
            activeBranch,
            newFallback,
            container,
            anchor,
            parentComponent,
            null, // fallback tree will not have suspense context
            isSVG,
            slotScopeIds,
            optimized
          )
          setActiveBranch(suspense, newFallback)
        }
      } else if (activeBranch && isSameVNodeType(newBranch, activeBranch)) {
        // toggled "back" to current active branch
        patch(
          activeBranch,
          newBranch,
          container,
          anchor,
          parentComponent,
          suspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        // force resolve
        suspense.resolve(true)
      } else {
        // switched to a 3rd branch
        patch(
          null,
          newBranch,
          suspense.hiddenContainer,
          null,
          parentComponent,
          suspense,
          isSVG,
          slotScopeIds,
          optimized
        )
        if (suspense.deps <= 0) {
          suspense.resolve()
        }
      }
    }
  } else {
    if (activeBranch && isSameVNodeType(newBranch, activeBranch)) {
      // root did not change, just normal patch
      patch(
        activeBranch,
        newBranch,
        container,
        anchor,
        parentComponent,
        suspense,
        isSVG,
        slotScopeIds,
        optimized
      )
      setActiveBranch(suspense, newBranch)
    } else {
      // root node toggled
      // invoke @pending event
      triggerEvent(n2, 'onPending')
      // mount pending branch in off-dom container
      suspense.pendingBranch = newBranch
      suspense.pendingId++
      patch(
        null,
        newBranch,
        suspense.hiddenContainer,
        null,
        parentComponent,
        suspense,
        isSVG,
        slotScopeIds,
        optimized
      )
      if (suspense.deps <= 0) {
        // incoming branch has no async deps, resolve now.
        suspense.resolve()
      } else {
        const { timeout, pendingId } = suspense
        if (timeout > 0) {
          setTimeout(() => {
            if (suspense.pendingId === pendingId) {
              suspense.fallback(newFallback)
            }
          }, timeout)
        } else if (timeout === 0) {
          suspense.fallback(newFallback)
        }
      }
    }
  }
}

export interface SuspenseBoundary {
  vnode: VNode<RendererNode, RendererElement, SuspenseProps>
  parent: SuspenseBoundary | null
  parentComponent: ComponentInternalInstance | null
  isSVG: boolean
  container: RendererElement
  hiddenContainer: RendererElement
  anchor: RendererNode | null
  activeBranch: VNode | null
  pendingBranch: VNode | null
  deps: number
  pendingId: number
  timeout: number
  isInFallback: boolean
  isHydrating: boolean
  isUnmounted: boolean
  effects: Function[]
  resolve(force?: boolean): void
  fallback(fallbackVNode: VNode): void
  move(
    container: RendererElement,
    anchor: RendererNode | null,
    type: MoveType
  ): void
  next(): RendererNode | null
  registerDep(
    instance: ComponentInternalInstance,
    setupRenderEffect: SetupRenderEffectFn
  ): void
  unmount(parentSuspense: SuspenseBoundary | null, doRemove?: boolean): void
}

let hasWarned = false

function createSuspenseBoundary(
  vnode: VNode,
  parent: SuspenseBoundary | null,
  parentComponent: ComponentInternalInstance | null,
  container: RendererElement,
  hiddenContainer: RendererElement,
  anchor: RendererNode | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals,
  isHydrating = false
): SuspenseBoundary {
  /* istanbul ignore if */
  if (__DEV__ && !__TEST__ && !hasWarned) {
    hasWarned = true
    // @ts-ignore `console.info` cannot be null error
    console[console.info ? 'info' : 'log'](
      `<Suspense> is an experimental feature and its API will likely change.`
    )
  }

  // 从内置 helper 获取方法
  const {
    p: patch,
    m: move,
    um: unmount,
    n: next,
    o: { parentNode, remove }
  } = rendererInternals

  const timeout = vnode.props ? toNumber(vnode.props.timeout) : undefined
  if (__DEV__) {
    assertNumber(timeout, `Suspense timeout`)
  }

  // suspense 边界实例
  const suspense: SuspenseBoundary = {
    vnode,
    parent,
    parentComponent,
    isSVG,
    container,
    hiddenContainer,
    anchor,
    deps: 0,
    pendingId: 0,
    timeout: typeof timeout === 'number' ? timeout : -1,
    activeBranch: null, // 激活分支
    pendingBranch: null, // 等待分支
    isInFallback: true,
    isHydrating,
    isUnmounted: false,
    effects: [],
    // suspense resolve，由 fallback 切换到模板组件展示
    // 当异步组件被 resolve 后，此函数在 registerDep 的回调中被调用
    resolve(resume = false) {
      if (__DEV__) {
        if (!resume && !suspense.pendingBranch) {
          throw new Error(
            `suspense.resolve() is called without a pending branch.`
          )
        }
        if (suspense.isUnmounted) {
          throw new Error(
            `suspense.resolve() is called on an already unmounted suspense boundary.`
          )
        }
      }
      const {
        vnode,
        activeBranch,
        pendingBranch,
        pendingId,
        effects,
        parentComponent,
        container
      } = suspense
      // suspense 是否处于水合

      if (suspense.isHydrating) {
        suspense.isHydrating = false
      } else if (!resume) {
        // suspense 不恢复 ？
        const delayEnter =
          activeBranch &&
          pendingBranch!.transition &&
          pendingBranch!.transition.mode === 'out-in'
        // 是否有 transition 动画？
        if (delayEnter) {
          activeBranch!.transition!.afterLeave = () => {
            if (pendingId === suspense.pendingId) {
              move(pendingBranch!, container, anchor, MoveType.ENTER)
            }
          }
        }
        // this is initial anchor on mount
        // 获取初始挂载时的锚点
        let { anchor } = suspense
        // unmount current active tree
        // 如果当前的 fallback 后备内容被挂载了，就移动一下锚点
        // 然后卸载 fallback
        if (activeBranch) {
          // if the fallback tree was mounted, it may have been moved
          // as part of a parent suspense. get the latest anchor for insertion
          anchor = next(activeBranch)
          unmount(activeBranch, parentComponent, suspense, true)
        }
        //
        if (!delayEnter) {
          // move content from off-dom container to actual container
          // 将内容从 hiddenContainer 移动到目标 container 中
          move(pendingBranch!, container, anchor, MoveType.ENTER)
        }
      }

      // 设置当前的 pendingBranch（content 内容） 为激活分支
      setActiveBranch(suspense, pendingBranch!)
      suspense.pendingBranch = null
      suspense.isInFallback = false

      // flush buffered effects
      // check if there is a pending parent suspense
      // 一层层向上遍历 parent，如果 parent 存在 suspense，且有 pendingBranch
      // 将当前的 suspense 的 effects 设置到 parent 的 suspense 上

      let parent = suspense.parent
      let hasUnresolvedAncestor = false
      while (parent) {
        if (parent.pendingBranch) {
          // found a pending parent suspense, merge buffered post jobs
          // into that parent
          parent.effects.push(...effects)
          hasUnresolvedAncestor = true
          break
        }
        // 向上遍历
        parent = parent.parent
      }
      // no pending parent suspense, flush all jobs
      // 执行所有依赖
      if (!hasUnresolvedAncestor) {
        queuePostFlushCb(effects)
      }
      suspense.effects = []

      // invoke @resolve event
      // 触发 onResolve 事件
      triggerEvent(vnode, 'onResolve')
    },
    // fallBack 分支逻辑，
    // 初始化时不会调用（TODO：猜测是回退时调用）
    fallback(fallbackVNode) {
      if (!suspense.pendingBranch) {
        return
      }

      const { vnode, activeBranch, parentComponent, container, isSVG } =
        suspense

      // invoke @fallback event
      // 触发 fallback 事件
      triggerEvent(vnode, 'onFallback')
      // 執行 vnode.suspense!.next()
      // 递归的从当前激活分支获取 dom 节点作为锚点
      const anchor = next(activeBranch!)
      // 挂载 fallback 分支
      const mountFallback = () => {
        if (!suspense.isInFallback) {
          return
        }
        // mount the fallback tree
        // 挂载 fallback 分支
        patch(
          null,
          fallbackVNode,
          container,
          anchor,
          parentComponent,
          null, // fallback tree will not have suspense context
          isSVG,
          slotScopeIds,
          optimized
        )
        // 设置当前激活分支为 fallback
        setActiveBranch(suspense, fallbackVNode)
      }
      // 设置 transition
      const delayEnter =
        fallbackVNode.transition && fallbackVNode.transition.mode === 'out-in'
      if (delayEnter) {
        activeBranch!.transition!.afterLeave = mountFallback
      }
      suspense.isInFallback = true
      // unmount current active branch
      // 执行挂载 fallback前，卸载当前激活分支
      unmount(
        activeBranch!,
        parentComponent,
        null, // no suspense so unmount hooks fire now
        true // shouldRemove
      )

      // 执行挂载 fallback
      if (!delayEnter) {
        mountFallback()
      }
    },
    // 递归移动 container ，假设嵌套了两个 suspense，那么 move 函数运行时
    // 会把第二层的 suspense 的 container 设置为 第一层的 suspense.activeBranch
    // move 实际上执行的是 vnode.suspense!.move()
    move(container, anchor, type) {
      suspense.activeBranch &&
        move(suspense.activeBranch, container, anchor, type)
      suspense.container = container
    },
    // next 实际上执行的是 vnode.suspense!.next()
    // 主要功能是递归的从当前激活分支获取 dom 节点作为锚点
    next() {
      return suspense.activeBranch && next(suspense.activeBranch)
    },

    registerDep(instance, setupRenderEffect) {
      // 由于 parentSuspense 是向下逐层传递的，所以
      // 当遇到异步组件时，就会调用 parentSuspense.registerDep，
      // registerDep 在 runtime 调用时，首次被调用，instance 并不一定是子组件，
      // 而是整个 subtree 的首个 异步组件
      // 是否处于 pending 中，处于，则说明 suspense 的子树还没有被 resolve
      // 依赖计数 + 1
      const isInPendingSuspense = !!suspense.pendingBranch
      if (isInPendingSuspense) {
        suspense.deps++
      }
      const hydratedEl = instance.vnode.el
      instance
        .asyncDep!.catch(err => {
          handleError(err, instance, ErrorCodes.SETUP_FUNCTION)
        })
        // 当异步组件被 resolve，就会进入这个回调
        .then(asyncSetupResult => {
          // retry when the setup() promise resolves.
          // component may have been unmounted before resolve.
          if (
            instance.isUnmounted ||
            suspense.isUnmounted ||
            suspense.pendingId !== instance.suspenseId
          ) {
            return
          }
          // retry from this component
          instance.asyncResolved = true
          const { vnode } = instance
          if (__DEV__) {
            pushWarningContext(vnode)
          }
          // 处理组件 SetupResult
          handleSetupResult(instance, asyncSetupResult, false)
          if (hydratedEl) {
            // vnode may have been replaced if an update happened before the
            // async dep is resolved.
            vnode.el = hydratedEl
          }
          const placeholder = !hydratedEl && instance.subTree.el
          // 执行 setupRenderEffect，进行依赖收集
          setupRenderEffect(
            instance,
            vnode,
            // component may have been moved before resolve.
            // if this is not a hydration, instance.subTree will be the comment
            // placeholder.
            parentNode(hydratedEl || instance.subTree.el!)!,
            // anchor will not be used if this is hydration, so only need to
            // consider the comment placeholder case.
            hydratedEl ? null : next(instance.subTree),
            suspense,
            isSVG,
            optimized
          )
          if (placeholder) {
            remove(placeholder)
          }
          updateHOCHostEl(instance, vnode.el)
          if (__DEV__) {
            popWarningContext()
          }
          // only decrease deps count if suspense is not already resolved
          // 触发 suspense.resolve() 进行分支切换渲染
          if (isInPendingSuspense && --suspense.deps === 0) {
            suspense.resolve()
          }
        })
    },
    // 卸载整个 suspense，包括 activeBranch、pendingBranch
    unmount(parentSuspense, doRemove) {
      // 卸载方法，使用  unmount 卸载两个 activeBranch、pendingBranch 分支
      suspense.isUnmounted = true
      if (suspense.activeBranch) {
        unmount(
          suspense.activeBranch,
          parentComponent,
          parentSuspense,
          doRemove
        )
      }
      if (suspense.pendingBranch) {
        unmount(
          suspense.pendingBranch,
          parentComponent,
          parentSuspense,
          doRemove
        )
      }
    }
  }

  return suspense
}
// TODO
function hydrateSuspense(
  node: Node,
  vnode: VNode,
  parentComponent: ComponentInternalInstance | null,
  parentSuspense: SuspenseBoundary | null,
  isSVG: boolean,
  slotScopeIds: string[] | null,
  optimized: boolean,
  rendererInternals: RendererInternals,
  hydrateNode: (
    node: Node,
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => Node | null
): Node | null {
  /* eslint-disable no-restricted-globals */
  const suspense = (vnode.suspense = createSuspenseBoundary(
    vnode,
    parentSuspense,
    parentComponent,
    node.parentNode!,
    document.createElement('div'),
    null,
    isSVG,
    slotScopeIds,
    optimized,
    rendererInternals,
    true /* hydrating */
  ))
  // there are two possible scenarios for server-rendered suspense:
  // - success: ssr content should be fully resolved
  // - failure: ssr content should be the fallback branch.
  // however, on the client we don't really know if it has failed or not
  // attempt to hydrate the DOM assuming it has succeeded, but we still
  // need to construct a suspense boundary first
  const result = hydrateNode(
    node,
    (suspense.pendingBranch = vnode.ssContent!),
    parentComponent,
    suspense,
    slotScopeIds,
    optimized
  )
  if (suspense.deps === 0) {
    suspense.resolve()
  }
  return result
  /* eslint-enable no-restricted-globals */
}
// TODO
function normalizeSuspenseChildren(vnode: VNode) {
  const { shapeFlag, children } = vnode
  const isSlotChildren = shapeFlag & ShapeFlags.SLOTS_CHILDREN
  vnode.ssContent = normalizeSuspenseSlot(
    isSlotChildren ? (children as Slots).default : children
  )
  vnode.ssFallback = isSlotChildren
    ? normalizeSuspenseSlot((children as Slots).fallback)
    : createVNode(Comment)
}
// TODO
function normalizeSuspenseSlot(s: any) {
  let block: VNode[] | null | undefined
  if (isFunction(s)) {
    const trackBlock = isBlockTreeEnabled && s._c
    if (trackBlock) {
      // disableTracking: false
      // allow block tracking for compiled slots
      // (see ./componentRenderContext.ts)
      s._d = false
      openBlock()
    }
    s = s()
    if (trackBlock) {
      s._d = true
      block = currentBlock
      closeBlock()
    }
  }
  if (isArray(s)) {
    const singleChild = filterSingleRoot(s)
    if (__DEV__ && !singleChild) {
      warn(`<Suspense> slots expect a single root node.`)
    }
    s = singleChild
  }
  s = normalizeVNode(s)
  if (block && !s.dynamicChildren) {
    s.dynamicChildren = block.filter(c => c !== s)
  }
  return s
}
// TODO
export function queueEffectWithSuspense(
  fn: Function | Function[],
  suspense: SuspenseBoundary | null
): void {
  if (suspense && suspense.pendingBranch) {
    if (isArray(fn)) {
      suspense.effects.push(...fn)
    } else {
      suspense.effects.push(fn)
    }
  } else {
    queuePostFlushCb(fn)
  }
}

function setActiveBranch(suspense: SuspenseBoundary, branch: VNode) {
  // 将传入的分支设置为 suspense 的激活分支
  suspense.activeBranch = branch
  const { vnode, parentComponent } = suspense
  // 替换 vnode 上 el 为 当前分支 el
  const el = (vnode.el = branch.el)
  // in case suspense is the root node of a component,
  // recursively update the HOC el
  // 如果 suspense 是组件的根节点，请递归更新 HOC el
  if (parentComponent && parentComponent.subTree === vnode) {
    parentComponent.vnode.el = el
    updateHOCHostEl(parentComponent, el)
  }
}
