import { invariant } from "hey-listen"
import { complex } from "style-value-types"
import { VisualElement } from "../"
import { TargetWithKeyframes, Variant } from "../../../types"
import { isNumericalString } from "../../../utils/is-numerical-string"
import { resolveFinalValueInKeyframes } from "../../../utils/resolve-value"
import { motionValue } from "../../../value"
import { findValueType } from "../../dom/utils/value-types"
import { AnimationDefinition } from "./animation"
import { resolveVariant } from "./variants"

type SetterOptions = {
    priority?: number
    custom?: any
}

/**
 * Set VisualElement's MotionValue, creating a new MotionValue for it if
 * it doesn't exist.
 */
function setMotionValue(
    visualElement: VisualElement,
    key: string,
    value: string | number
) {
    if (visualElement.hasValue(key)) {
        visualElement.getValue(key)!.set(value)
    } else {
        visualElement.addValue(key, motionValue(value))
    }
}

/**
 *
 */
export function setTarget(
    visualElement: VisualElement,
    definition: Variant,
    { priority }: SetterOptions = {}
) {
    let { target = {}, transitionEnd = {} } = resolveVariant(
        visualElement,
        definition
    )

    // TODO Reinstate Framer transform values functionality
    // target = transformValues({...target, ...transitionEnd})
    target = { ...target, ...transitionEnd }

    for (const key in target) {
        const value = resolveFinalValueInKeyframes(target[key])
        setMotionValue(visualElement, key, value as string | number)

        if (!priority) visualElement.baseTarget[key] = value
    }
}

/**
 *
//  */
function setVariants(visualElement: VisualElement, variantLabels: string[]) {
    /**
     *
     */
    const reversedLabels = [...variantLabels].reverse()

    reversedLabels.forEach((key) => {
        setTarget(visualElement, visualElement.getVariant(key))

        visualElement.variantChildren?.forEach((child) => {
            // TODO: Fish variants and custom from visualElement config
            setVariants(child, variantLabels)
        })
    })
}

export function setValues(
    visualElement: VisualElement,
    definition: AnimationDefinition
) {
    if (Array.isArray(definition)) {
        return setVariants(visualElement, definition)
    } else if (typeof definition === "string") {
        return setVariants(visualElement, [definition])
    } else {
        setTarget(visualElement, definition)
    }
}

export function checkTargetForNewValues(
    visualElement: VisualElement,
    target: TargetWithKeyframes
) {
    const newValueKeys = Object.keys(target).filter((key) =>
        visualElement.hasValue(key)
    )
    const numNewValues = newValueKeys.length
    if (!numNewValues) return

    for (let i = 0; i < numNewValues; i++) {
        const key = newValueKeys[i]
        const targetValue = target[key]
        let value: string | number | null = null

        // If this is a keyframes value, we can attempt to use the first value in the
        // array as that's going to be the first value of the animation anyway
        if (Array.isArray(targetValue)) {
            value = targetValue[0]
        }

        // If it isn't a keyframes or the first keyframes value was set as `null`, read the
        // value from the DOM. It might be worth investigating whether to check props (for SVG)
        // or props.style (for HTML) if the value exists there before attempting to read.
        if (value === null) {
            const readValue = visualElement.readNativeValue(key)
            value = readValue !== undefined ? readValue : target[key]

            invariant(
                value !== null,
                `No initial value for "${key}" can be inferred. Ensure an initial value for "${key}" is defined on the component.`
            )
        }

        if (typeof value === "string" && isNumericalString(value)) {
            // If this is a number read as a string, ie "0" or "200", convert it to a number
            value = parseFloat(value)
        } else if (!findValueType(value) && complex.test(targetValue)) {
            // If value is not recognised as animatable, ie "none", create an animatable version origin based on the target
            value = complex.getAnimatableNone(targetValue as string)
        }

        visualElement.addValue(key, motionValue(value))
        visualElement.baseTarget[key] = value
    }
}
