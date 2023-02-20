import {
  VNode,
  normalizeVNode,
  Text,
  Comment,
  Static,
  Fragment,
  VNodeHook,
  createVNode,
  createTextVNode,
  invokeVNodeHook
} from './vnode'
import { flushPostFlushCbs } from './scheduler'
import { ComponentInternalInstance } from './component'
import { invokeDirectiveHook } from './directives'
import { warn } from './warning'
import { PatchFlags, ShapeFlags, isReservedProp, isOn } from '@vue/shared'
import { RendererInternals } from './renderer'
import { setRef } from './rendererTemplateRef'
import {
  SuspenseImpl,
  SuspenseBoundary,
  queueEffectWithSuspense
} from './components/Suspense'
import { TeleportImpl, TeleportVNode } from './components/Teleport'
import { isAsyncWrapper } from './apiAsyncComponent'

export type RootHydrateFunction = (
  vnode: VNode<Node, Element>,
  container: (Element | ShadowRoot) & { _vnode?: VNode }
) => void

const enum DOMNodeTypes {
  ELEMENT = 1,
  TEXT = 3,
  COMMENT = 8
}

let hasMismatch = false

const isSVGContainer = (container: Element) =>
  /svg/.test(container.namespaceURI!) && container.tagName !== 'foreignObject'

const isComment = (node: Node): node is Comment =>
  node.nodeType === DOMNodeTypes.COMMENT

// Note: hydration is DOM-specific
// But we have to place it in core due to tight coupling with core - splitting
// it out creates a ton of unnecessary complexity.
// Hydration also depends on some renderer internal logic which needs to be
// passed in via arguments.
export function createHydrationFunctions(
  rendererInternals: RendererInternals<Node, Element>
) {
  // 从渲染器内置对象中获取辅助函数（包括挂在、创建、移动、删除节点等）
  const {
    mt: mountComponent,
    p: patch,
    o: {
      patchProp,
      createText,
      nextSibling,
      parentNode,
      remove,
      insert,
      createComment
    }
  } = rendererInternals

  // 水合方法，也是整个水合流程的入口，它将在SSR客户端mount时被调用
  const hydrate: RootHydrateFunction = (vnode, container) => {
    // 处理模板容器存不在子节点的情况（可能在服务端生成是发生问题导致），进行全量 patch
    if (!container.hasChildNodes()) {
      __DEV__ &&
        warn(
          `Attempting to hydrate existing markup but container is empty. ` +
            `Performing full mount instead.`
        )
      patch(null, vnode, container)
      flushPostFlushCbs()
      container._vnode = vnode
      return
    }
    // 同构匹配缺失标志
    hasMismatch = false
    // 从容器下第一个节点开始 水合节点
    hydrateNode(container.firstChild!, vnode, null, null, null)
    flushPostFlushCbs()
    // 存储 vnode 树
    container._vnode = vnode
    if (hasMismatch && !__TEST__) {
      // this error should show up in production
      console.error(`Hydration completed but contains mismatches.`)
    }
  }

  const hydrateNode = (
    node: Node, // 真实的 dom 节点
    vnode: VNode, // vnode
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized = false
  ): Node | null => {
    // 是否是 fragment
    const isFragmentStart = isComment(node) && node.data === '['
    // 处理同构缺失的函数，当水合过程中，同构失败（服务端客户端结构不符合，调用次函数进行报错）
    const onMismatch = () =>
      handleMismatch(
        node,
        vnode,
        parentComponent,
        parentSuspense,
        slotScopeIds,
        isFragmentStart
      )

    const { type, ref, shapeFlag, patchFlag } = vnode
    let domType = node.nodeType
    // 将当前 dom 节点 挂到 vnode.el 上 （与 spa 一样，vnode需要与真实 dom 有联系）
    vnode.el = node

    // 节点编译的 patchFlag 为 BAIL，则退出 dynamicChildren 优化路径
    // see: packages/shared/src/patchFlags.ts
    if (patchFlag === PatchFlags.BAIL) {
      optimized = false
      vnode.dynamicChildren = null
    }

    let nextNode: Node | null = null
    // 根据 vnode 类型 分别处理
    switch (type) {
      // vnode 为文本节点
      case Text:
        // node 不为 文本节点
        if (domType !== DOMNodeTypes.TEXT) {
          // #5728 empty text node inside a slot can cause hydration failure
          // because the server rendered HTML won't contain a text node
          // vnode 没有子节点（文本）
          if (vnode.children === '') {
            // 在当前的 node 的 parent node 中创建一个空的文本
            insert((vnode.el = createText('')), parentNode(node)!, node)
            // 将 nextNode 指向
            nextNode = node
          } else {
            // 匹配错误，此时 vnode 为文本节点且有子节点（文本），而 node 不是文本节点
            nextNode = onMismatch()
          }
        } else {
          // node 是文本节点，但不等于 vnode 的 children
          if ((node as Text).data !== vnode.children) {
            // 直接警告，匹配缺失
            hasMismatch = true
            __DEV__ &&
              warn(
                `Hydration text mismatch:` +
                  `\n- Client: ${JSON.stringify((node as Text).data)}` +
                  `\n- Server: ${JSON.stringify(vnode.children)}`
              )
            // 将 node 替换为 vnode 内容，即客户端渲染内容优先级更高
            ;(node as Text).data = vnode.children as string
          }
          // nextNode 指向下一个节点
          nextNode = nextSibling(node)
        }
        break
      case Comment:
        // vnode 节点类型为注释，（ node 类型不为注释，或是 Fragment，则匹配缺失）
        // 处理警告
        if (domType !== DOMNodeTypes.COMMENT || isFragmentStart) {
          nextNode = onMismatch()
        } else {
          // nextNode 指向下一个节点，注释节点不需要什么处理
          nextNode = nextSibling(node)
        }
        break
      case Static:
        // vnode 是纯静态的，而 node 是 Fragment，则将node移动下一个节点，
        // 并更新 domType， 再进行处理
        if (isFragmentStart) {
          // entire template is static but SSRed as a fragment
          node = nextSibling(node)!
          domType = node.nodeType
        }
        // node 类型为 元素 或文本
        if (domType === DOMNodeTypes.ELEMENT || domType === DOMNodeTypes.TEXT) {
          // determine anchor, adopt content
          // 确定锚点为此node
          nextNode = node
          // if the static vnode has its content stripped during build,
          // adopt it from the server-rendered HTML.
          // 静态节点可能会被静态提升（甚至提升为纯字符串）（TODO: ?）,
          // 那需要从服务端渲染的 html 中获取内容
          const needToAdoptContent = !(vnode.children as string).length
          // vnode 上记录了静态节点数量
          for (let i = 0; i < vnode.staticCount!; i++) {
            if (needToAdoptContent)
              // 拼接内容到 vnode 的 children
              vnode.children +=
                nextNode.nodeType === DOMNodeTypes.ELEMENT
                  ? (nextNode as Element).outerHTML
                  : (nextNode as Text).data
            // 遍历结束，记录锚点
            if (i === vnode.staticCount! - 1) {
              vnode.anchor = nextNode
            }
            // 每次遍历 持续移动 node
            nextNode = nextSibling(nextNode)!
          }
          // 如果是 Fragment，还要再向下移动一哈 （ ']'）
          return isFragmentStart ? nextSibling(nextNode) : nextNode
        } else {
          // node 不是文本 或 纯静态节点，报错匹配缺失
          onMismatch()
        }
        break
      case Fragment:
        // 如果 vnode 是 Fragment，而 node 不是 '['
        // 报错匹配缺失
        if (!isFragmentStart) {
          nextNode = onMismatch()
        } else {
          // 水合 Fragment TODO
          nextNode = hydrateFragment(
            node as Comment,
            vnode,
            parentComponent,
            parentSuspense,
            slotScopeIds,
            optimized
          )
        }
        break
      default:
        // vnode 是普通元素
        if (shapeFlag & ShapeFlags.ELEMENT) {
          // node 不是普通元素 或 vnode 与 node 的 tag不匹配
          // 报错匹配缺失
          if (
            domType !== DOMNodeTypes.ELEMENT ||
            (vnode.type as string).toLowerCase() !==
              (node as Element).tagName.toLowerCase()
          ) {
            nextNode = onMismatch()
          } else {
            // 水合元素
            nextNode = hydrateElement(
              node as Element,
              vnode,
              parentComponent,
              parentSuspense,
              slotScopeIds,
              optimized
            )
          }
          // vnode 是组件
        } else if (shapeFlag & ShapeFlags.COMPONENT) {
          // when setting up the render effect, if the initial vnode already
          // has .el set, the component will perform hydration instead of mount
          // on its sub-tree.
          // 在处理组件时的渲染函数副作用时，如果 vnode 的对应 el 已经被设置，那么组件
          // 将不再挂在 subtree 而是去执行水合

          // 设置 css 作用域 id
          vnode.slotScopeIds = slotScopeIds
          // 根据当前 node 的 parent 设置组件的 container
          const container = parentNode(node)!
          // 挂载组件， 组件挂载时，TODO$$：水合相关的过程应该散落在各个运行时中
          mountComponent(
            vnode,
            container,
            null,
            parentComponent,
            parentSuspense,
            isSVGContainer(container),
            optimized
          )

          // component may be async, so in the case of fragments we cannot rely
          // on component's rendered output to determine the end of the fragment
          // instead, we do a lookahead to find the end anchor node.

          // 如果组件是异步的，且 node 是 fragment，
          // 那没办法靠组件渲染的节点的 nextSibling 来确定 nextNode
          // 所以这里是不是异步组件，我们都遍历 node 来查找确定（locateClosingAsyncAnchor）
          nextNode = isFragmentStart
            ? locateClosingAsyncAnchor(node)
            : nextSibling(node)

          // #4293 teleport as component root
          // 如果 nextNode 指向了 teleport end 注释处理
          // 继续向下一个节点
          if (
            nextNode &&
            isComment(nextNode) &&
            nextNode.data === 'teleport end'
          ) {
            nextNode = nextSibling(nextNode)
          }

          // #3787
          // if component is async, it may get moved / unmounted before its
          // inner component is loaded, so we need to give it a placeholder
          // vnode that matches its adopted DOM.
          // 如果组件是异步的，则在加载其内部组件之前，它可能会被移动或卸载，
          // 因此我们需要为其提供一个与其采用的 DOM 匹配的占位符 vnode。
          // #3787 场景中，ssr 水合时子组件中异步组件还没加载，此时被且走了
          // 导致切换时报错，因为切走会 patch，但是异步组件又没加载，没有vnode，所以导致了报错
          if (isAsyncWrapper(vnode)) {
            let subTree
            if (isFragmentStart) {
              subTree = createVNode(Fragment)
              subTree.anchor = nextNode
                ? nextNode.previousSibling
                : container.lastChild
            } else {
              subTree =
                node.nodeType === 3 ? createTextVNode('') : createVNode('div')
            }
            subTree.el = node
            vnode.component!.subTree = subTree
          }
        } else if (shapeFlag & ShapeFlags.TELEPORT) {
          // vnode 是 teleport 而 node 不是注释，则报错匹配缺失
          if (domType !== DOMNodeTypes.COMMENT) {
            nextNode = onMismatch()
          } else {
            // vnode 是 teleport 传送门，则调用其 hydrate 特殊处理 TODO
            nextNode = (vnode.type as typeof TeleportImpl).hydrate(
              node,
              vnode as TeleportVNode,
              parentComponent,
              parentSuspense,
              slotScopeIds,
              optimized,
              rendererInternals,
              hydrateChildren
            )
          }
        } else if (__FEATURE_SUSPENSE__ && shapeFlag & ShapeFlags.SUSPENSE) {
          // vnode 是 suspense 悬挂，则调用其 hydrate 特殊处理 TODO
          nextNode = (vnode.type as typeof SuspenseImpl).hydrate(
            node,
            vnode,
            parentComponent,
            parentSuspense,
            isSVGContainer(parentNode(node)!),
            slotScopeIds,
            optimized,
            rendererInternals,
            hydrateNode
          )
        } else if (__DEV__) {
          warn('Invalid HostVNode type:', type, `(${typeof type})`)
        }
    }

    // vnode 存在 ref，则处理相关逻辑（模板上的 ref，设置dom啊这些）
    if (ref != null) {
      setRef(ref, null, parentSuspense, vnode)
    }
    // 返回 nextNode，有些类型（元素、组件...）会在水合过程中递归调用 hydrateNode
    // 所以需 nextNode 作为处理锚点
    return nextNode
  }

  const hydrateElement = (
    el: Element,
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    // 是否开启优化逻辑（fast path）
    optimized = optimized || !!vnode.dynamicChildren
    const { type, props, patchFlag, shapeFlag, dirs } = vnode
    // #4006 for form elements with non-string v-model value bindings
    // e.g. <option :value="obj">, <input type="checkbox" :true-value="1">
    const forcePatchValue = (type === 'input' && dirs) || type === 'option'
    // skip props & children if this is hoisted static nodes
    // #5405 in dev, always hydrate children for HMR
    // dev 水合子节点总是能够热更新的，
    // 如果 vnode 不是被静态提升的节点，进行钩子绑定和 props 处理
    if (__DEV__ || forcePatchValue || patchFlag !== PatchFlags.HOISTED) {
      // 触发指令钩子
      if (dirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'created')
      }
      // props
      // 处理 props
      if (props) {
        // 非优化 || 含有动态 key || 具有事件
        if (
          forcePatchValue ||
          !optimized ||
          patchFlag & (PatchFlags.FULL_PROPS | PatchFlags.HYDRATE_EVENTS)
        ) {
          // 遍历 props，对元素进行属性绑定, 包括各种属性、事件绑定
          // packages/runtime-dom/src/patchProp.ts
          for (const key in props) {
            if (
              (forcePatchValue && key.endsWith('value')) ||
              (isOn(key) && !isReservedProp(key))
            ) {
              patchProp(
                el,
                key,
                null,
                props[key],
                false,
                undefined,
                parentComponent
              )
            }
          }
        } else if (props.onClick) {
          // Fast path for click listeners (which is most often) to avoid
          // iterating through props.
          // 在快速路径下，vnode 具有点击事件是非常常见的，
          // 这里直接判断，并取出来进行 patchProps
          patchProp(
            el,
            'onClick',
            null,
            props.onClick,
            false,
            undefined,
            parentComponent
          )
        }
      }
      // vnode / directive hooks
      // vnode 钩子钩子或指令钩子
      let vnodeHooks: VNodeHook | null | undefined
      // 组件钩子 onBeforeMount
      if ((vnodeHooks = props && props.onVnodeBeforeMount)) {
        invokeVNodeHook(vnodeHooks, parentComponent, vnode)
      }
      // 指令钩子 beforeMount
      if (dirs) {
        invokeDirectiveHook(vnode, null, parentComponent, 'beforeMount')
      }
      // 组件钩子、指令钩子 onMounted
      if ((vnodeHooks = props && props.onVnodeMounted) || dirs) {
        queueEffectWithSuspense(() => {
          vnodeHooks && invokeVNodeHook(vnodeHooks, parentComponent, vnode)
          dirs && invokeDirectiveHook(vnode, null, parentComponent, 'mounted')
        }, parentSuspense)
      }
      // children
      // vnode 的类型为 `子节点数组` 且内容不是文本或静态提升字符串
      if (
        shapeFlag & ShapeFlags.ARRAY_CHILDREN &&
        // skip if element has innerHTML / textContent
        !(props && (props.innerHTML || props.textContent))
      ) {
        // 水合子节点
        let next = hydrateChildren(
          el.firstChild,
          vnode,
          el,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        )
        let hasWarned = false
        // next 代表子节点数组处理完后，服务端渲染的节点是否还有没处理的节点
        // 即客户端的 vnode 树已经水合完，但是服务端渲染的 dom 树还有节点
        // 那么就匹配失败，将多余的节点删除，以客户端优先
        while (next) {
          hasMismatch = true
          if (__DEV__ && !hasWarned) {
            warn(
              `Hydration children mismatch in <${vnode.type as string}>: ` +
                `server rendered element contains more child nodes than client vdom.`
            )
            hasWarned = true
          }
          // The SSRed DOM contains more nodes than it should. Remove them.
          const cur = next
          next = next.nextSibling
          remove(cur)
        }
      } else if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
        // 如果 vnode 是 '子节点文本'
        // 文本不一致就替换并报错匹配缺失
        if (el.textContent !== vnode.children) {
          hasMismatch = true
          __DEV__ &&
            warn(
              `Hydration text content mismatch in <${
                vnode.type as string
              }>:\n` +
                `- Client: ${el.textContent}\n` +
                `- Server: ${vnode.children as string}`
            )
          el.textContent = vnode.children as string
        }
      }
    }
    return el.nextSibling
  }

  const hydrateChildren = (
    node: Node | null,
    parentVNode: VNode,
    container: Element,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean
  ): Node | null => {
    optimized = optimized || !!parentVNode.dynamicChildren
    const children = parentVNode.children as VNode[]
    const l = children.length
    let hasWarned = false
    for (let i = 0; i < l; i++) {
      const vnode = optimized
        ? children[i]
        : (children[i] = normalizeVNode(children[i]))
      if (node) {
        node = hydrateNode(
          node,
          vnode,
          parentComponent,
          parentSuspense,
          slotScopeIds,
          optimized
        )
      } else if (vnode.type === Text && !vnode.children) {
        continue
      } else {
        hasMismatch = true
        if (__DEV__ && !hasWarned) {
          warn(
            `Hydration children mismatch in <${container.tagName.toLowerCase()}>: ` +
              `server rendered element contains fewer child nodes than client vdom.`
          )
          hasWarned = true
        }
        // the SSRed DOM didn't contain enough nodes. Mount the missing ones.
        patch(
          null,
          vnode,
          container,
          null,
          parentComponent,
          parentSuspense,
          isSVGContainer(container),
          slotScopeIds
        )
      }
    }
    return node
  }

  const hydrateFragment = (
    node: Comment,
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    optimized: boolean
  ) => {
    const { slotScopeIds: fragmentSlotScopeIds } = vnode
    if (fragmentSlotScopeIds) {
      slotScopeIds = slotScopeIds
        ? slotScopeIds.concat(fragmentSlotScopeIds)
        : fragmentSlotScopeIds
    }

    const container = parentNode(node)!
    const next = hydrateChildren(
      nextSibling(node)!,
      vnode,
      container,
      parentComponent,
      parentSuspense,
      slotScopeIds,
      optimized
    )
    if (next && isComment(next) && next.data === ']') {
      return nextSibling((vnode.anchor = next))
    } else {
      // fragment didn't hydrate successfully, since we didn't get a end anchor
      // back. This should have led to node/children mismatch warnings.
      hasMismatch = true
      // since the anchor is missing, we need to create one and insert it
      insert((vnode.anchor = createComment(`]`)), container, next)
      return next
    }
  }

  const handleMismatch = (
    node: Node,
    vnode: VNode,
    parentComponent: ComponentInternalInstance | null,
    parentSuspense: SuspenseBoundary | null,
    slotScopeIds: string[] | null,
    isFragment: boolean
  ): Node | null => {
    hasMismatch = true
    __DEV__ &&
      warn(
        `Hydration node mismatch:\n- Client vnode:`,
        vnode.type,
        `\n- Server rendered DOM:`,
        node,
        node.nodeType === DOMNodeTypes.TEXT
          ? `(text)`
          : isComment(node) && node.data === '['
          ? `(start of fragment)`
          : ``
      )
    vnode.el = null

    if (isFragment) {
      // remove excessive fragment nodes
      const end = locateClosingAsyncAnchor(node)
      while (true) {
        const next = nextSibling(node)
        if (next && next !== end) {
          remove(next)
        } else {
          break
        }
      }
    }

    const next = nextSibling(node)
    const container = parentNode(node)!
    remove(node)

    patch(
      null,
      vnode,
      container,
      next,
      parentComponent,
      parentSuspense,
      isSVGContainer(container),
      slotScopeIds
    )
    return next
  }

  const locateClosingAsyncAnchor = (node: Node | null): Node | null => {
    let match = 0
    while (node) {
      node = nextSibling(node)
      if (node && isComment(node)) {
        if (node.data === '[') match++
        if (node.data === ']') {
          if (match === 0) {
            return nextSibling(node)
          } else {
            match--
          }
        }
      }
    }
    return node
  }

  return [hydrate, hydrateNode] as const
}
