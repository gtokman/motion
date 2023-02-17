import { VariantLabels } from "../../motion/types"
import {
    Target,
    TargetAndTransition,
    TargetResolver,
    TargetWithKeyframes,
    Transition,
} from "../../types"
import type { VisualElement } from "../VisualElement"
import { AnimationTypeState } from "./animation-state"
import { AnimationType } from "./types"
import { setTarget } from "./setters"
import { resolveVariant } from "./resolve-dynamic-variants"
import { transformPropOrder, transformProps } from "../html/utils/transform"
import { isWillChangeMotionValue } from "../../value/use-will-change/is"
import { optimizedAppearDataAttribute } from "../../animation/optimized-appear/data-id"
import { createMotionValueAnimation } from "../../animation"
import { sync } from "../../frameloop"
import { sampleDelta } from "../../animation/waapi/create-accelerated-animation"
import { buildTransform } from "../html/utils/build-transform"
import { ResolvedValues } from "../types"
import { getValueAsType } from "../dom/value-types/get-as-type"
import { numberValueTypes } from "../dom/value-types/number"

export type AnimationDefinition =
    | VariantLabels
    | TargetAndTransition
    | TargetResolver

export type AnimationOptions = {
    delay?: number
    transitionOverride?: Transition
    custom?: any
    type?: AnimationType
}

export type MakeTargetAnimatable<T = unknown> = (
    visualElement: VisualElement<T>,
    target: TargetWithKeyframes,
    origin?: Target,
    transitionEnd?: Target
) => {
    target: TargetWithKeyframes
    transitionEnd?: Target
}

export function animateVisualElement(
    visualElement: VisualElement,
    definition: AnimationDefinition,
    options: AnimationOptions = {}
) {
    visualElement.notify("AnimationStart", definition)
    let animation: Promise<any>

    if (Array.isArray(definition)) {
        const animations = definition.map((variant) =>
            animateVariant(visualElement, variant, options)
        )
        animation = Promise.all(animations)
    } else if (typeof definition === "string") {
        animation = animateVariant(visualElement, definition, options)
    } else {
        const resolvedDefinition =
            typeof definition === "function"
                ? resolveVariant(visualElement, definition, options.custom)
                : definition
        animation = animateTarget(visualElement, resolvedDefinition, options)
    }

    return animation.then(() =>
        visualElement.notify("AnimationComplete", definition)
    )
}

function animateVariant(
    visualElement: VisualElement,
    variant: string,
    options: AnimationOptions = {}
) {
    const resolved = resolveVariant(visualElement, variant, options.custom)
    let { transition = visualElement.getDefaultTransition() || {} } =
        resolved || {}

    if (options.transitionOverride) {
        transition = options.transitionOverride
    }

    /**
     * If we have a variant, create a callback that runs it as an animation.
     * Otherwise, we resolve a Promise immediately for a composable no-op.
     */

    const getAnimation = resolved
        ? () => animateTarget(visualElement, resolved, options)
        : () => Promise.resolve()

    /**
     * If we have children, create a callback that runs all their animations.
     * Otherwise, we resolve a Promise immediately for a composable no-op.
     */
    const getChildAnimations =
        visualElement.variantChildren && visualElement.variantChildren.size
            ? (forwardDelay = 0) => {
                  const {
                      delayChildren = 0,
                      staggerChildren,
                      staggerDirection,
                  } = transition

                  return animateChildren(
                      visualElement,
                      variant,
                      delayChildren + forwardDelay,
                      staggerChildren,
                      staggerDirection,
                      options
                  )
              }
            : () => Promise.resolve()

    /**
     * If the transition explicitly defines a "when" option, we need to resolve either
     * this animation or all children animations before playing the other.
     */
    const { when } = transition
    if (when) {
        const [first, last] =
            when === "beforeChildren"
                ? [getAnimation, getChildAnimations]
                : [getChildAnimations, getAnimation]

        return first().then(last)
    } else {
        return Promise.all([getAnimation(), getChildAnimations(options.delay)])
    }
}

/**
 * @internal
 */
function animateTarget(
    visualElement: VisualElement,
    definition: TargetAndTransition,
    { delay = 0, transitionOverride, type }: AnimationOptions = {}
): Promise<any> {
    let {
        transition = visualElement.getDefaultTransition(),
        transitionEnd,
        ...target
    } = visualElement.makeTargetAnimatable(definition)

    const willChange = visualElement.getValue("willChange")

    if (transitionOverride) transition = transitionOverride

    const animations: Promise<any>[] = []

    const animationTypeState =
        type &&
        visualElement.animationState &&
        visualElement.animationState.getState()[type]

    const collectedTransforms: string[] = []

    const startTime = performance.now()

    for (const key in target) {
        const value = visualElement.getValue(key)
        const valueTarget = target[key]

        if (
            !value ||
            valueTarget === undefined ||
            (animationTypeState &&
                shouldBlockAnimation(animationTypeState, key))
        ) {
            continue
        }

        const isTransform = transformProps.has(key)

        const valueTransition = { delay, elapsed: 0, ...transition }

        /**
         * If this is the first time a value is being animated, check
         * to see if we're handling off from an existing animation.
         */
        if (window.HandoffAppearAnimations && !value.hasAnimated) {
            const appearId =
                visualElement.getProps()[optimizedAppearDataAttribute]

            if (appearId) {
                valueTransition.elapsed = window.HandoffAppearAnimations(
                    appearId,
                    key,
                    value,
                    sync
                )
            }
        }

        let animation = value.start(
            createMotionValueAnimation(
                key,
                value,
                valueTarget,
                visualElement.shouldReduceMotion && isTransform
                    ? { type: false }
                    : valueTransition
            )
        )

        if (isWillChangeMotionValue(willChange)) {
            willChange.add(key)

            animation = animation.then(() => willChange.remove(key))
        }

        animations.push(animation)

        if (value.keyframes) {
            collectedTransforms.push(key)
        }
    }

    if (collectedTransforms.length) {
        let maxKeyframes = 0
        const frameTransform: ResolvedValues = {}
        const valueKeyframeOffset: ResolvedValues = {}

        for (let i = 0; i < transformPropOrder.length; i++) {
            const transformName = transformPropOrder[i]
            const value = visualElement.getValue(transformName)

            if (!value) continue

            const keyframeOffset =
                collectedTransforms.indexOf(transformName) === -1
                    ? Math.round((startTime - value.startedAt!) / sampleDelta)
                    : 0

            maxKeyframes = Math.max(
                maxKeyframes,
                value.keyframes.length - keyframeOffset
            )
            valueKeyframeOffset[transformName] = keyframeOffset
        }

        const transformKeyframes: string[] = []
        for (let i = 0; i < maxKeyframes; i++) {
            for (const key in valueKeyframeOffset) {
                const keyframeOffset = valueKeyframeOffset[key]
                const value = visualElement.getValue(key)
                const valueType = numberValueTypes[key]

                if (value!.keyframes) {
                    const keyframeIndex = Math.min(
                        value!.keyframes.length - 1,
                        (keyframeOffset as number) + i
                    )
                    frameTransform[key] = getValueAsType(
                        value!.keyframes[keyframeIndex],
                        valueType
                    )
                } else {
                    frameTransform[key] = value?.get()
                }
                // console.log(key, value!.keyframes[keyframeIndex], keyframeIndex)
            }
            transformKeyframes.push(
                buildTransform(
                    frameTransform,
                    visualElement.options,
                    false,
                    visualElement.props.transformTemplate
                )
            )
        }

        visualElement.getValue("transform", transformKeyframes[0])
        animations.push(
            animateTarget(visualElement, {
                transform: transformKeyframes,
                transition: {
                    duration: ((maxKeyframes - 1) * sampleDelta) / 1000,
                    ease: "linear",
                },
            })
        )
    }

    return Promise.all(animations).then(() => {
        transitionEnd && setTarget(visualElement, transitionEnd)
    })
}

function animateChildren(
    visualElement: VisualElement,
    variant: string,
    delayChildren = 0,
    staggerChildren = 0,
    staggerDirection = 1,
    options: AnimationOptions
) {
    const animations: Promise<any>[] = []

    const maxStaggerDuration =
        (visualElement.variantChildren!.size - 1) * staggerChildren

    const generateStaggerDuration =
        staggerDirection === 1
            ? (i = 0) => i * staggerChildren
            : (i = 0) => maxStaggerDuration - i * staggerChildren

    Array.from(visualElement.variantChildren!)
        .sort(sortByTreeOrder)
        .forEach((child, i) => {
            child.notify("AnimationStart", variant)
            animations.push(
                animateVariant(child, variant, {
                    ...options,
                    delay: delayChildren + generateStaggerDuration(i),
                }).then(() => child.notify("AnimationComplete", variant))
            )
        })

    return Promise.all(animations)
}

export function stopAnimation(visualElement: VisualElement) {
    visualElement.values.forEach((value) => value.stop())
}

export function sortByTreeOrder(a: VisualElement, b: VisualElement) {
    return a.sortNodePosition(b)
}

/**
 * Decide whether we should block this animation. Previously, we achieved this
 * just by checking whether the key was listed in protectedKeys, but this
 * posed problems if an animation was triggered by afterChildren and protectedKeys
 * had been set to true in the meantime.
 */
function shouldBlockAnimation(
    { protectedKeys, needsAnimating }: AnimationTypeState,
    key: string
) {
    const shouldBlock =
        protectedKeys.hasOwnProperty(key) && needsAnimating[key] !== true

    needsAnimating[key] = false
    return shouldBlock
}
