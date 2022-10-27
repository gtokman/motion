import { easingDefinitionToFunction } from "../../../animation/utils/easing"
import { getValueTransition } from "../../../animation/utils/transitions"
import { transform } from "../../../utils/transform"
import {
    MapTimeToValue,
    TimelineSequence,
    UnresolvedTimeline,
    UnresolvedTracks,
    UnresolvedTrackSequence,
    UnresolvedValueSequence,
} from "../types"
import { calcNextTime } from "./calc-next-time"
import { defaultTransition } from "./defaults"
import { addKeyframes } from "./edit"
import { asKeyframesList } from "./keyframes"
import { defaultOffset, fillOffset } from "./offset"
import { compareByTime } from "./sort"

function getTrack(tracks: UnresolvedTracks, name: string) {
    if (!tracks[name]) tracks[name] = {}
    return tracks[name]
}

function getValueSequence(
    tracks: UnresolvedTracks,
    trackName: string,
    valueName: string
) {
    const track = getTrack(tracks, trackName)
    if (!track[valueName]) track[valueName] = []
    return track[valueName]
}

export function createUnresolvedTimeline(
    sequence: TimelineSequence
): UnresolvedTimeline {
    const timeline: UnresolvedTimeline = {
        duration: 0,
        tracks: {},
    }

    const labels = new Map<string, number>()

    let prevTime = 0
    let currentTime = 0

    /**
     * Build the timeline for each value by mapping over the defined
     * sequence and converting each segment into keyframes and offsets
     * with absolute time values.
     */
    for (let i = 0; i < sequence.length; i++) {
        const segment = sequence[i]

        /**
         * If this is a timeline label, mark it and skip the rest of
         * this iteration.
         */
        if (!Array.isArray(segment)) {
            labels.set(
                segment.name,
                calcNextTime(currentTime, prevTime, labels, segment.at)
            )
            continue
        }

        const [trackName, target, transition = {}] = segment

        /**
         * If a time position has been defined with need to resolve
         * it relative to the current time.
         */
        currentTime = calcNextTime(currentTime, prevTime, labels, transition.at)

        /**
         * Keep track of the maximum duration within this segment.
         * This will be applied to currentTime once the definition
         * has been parsed.
         */
        let maxDuration = 0

        for (const valueName in target) {
            const valueSequence = getValueSequence(
                timeline.tracks,
                trackName,
                valueName
            )
            const valueTransition = getValueTransition(transition, valueName)
            const valueKeyframes = asKeyframesList(target[valueName])

            const {
                duration = defaultTransition.duration,
                ease = defaultTransition.easing,
                delay = defaultTransition.delay,
                offset = defaultOffset(valueKeyframes.length),
            } = valueTransition

            const startTime = currentTime + delay
            const endTime = startTime + duration

            /**
             * If there's only one offset of 0, fill in a second with 1
             */
            if (offset.length === 1 && offset[0] === 0) {
                offset[1] = 1
            }

            /**
             * Fill our remaining offsets if fewer offsets than keyframes
             */
            const remainder = offset.length - valueKeyframes.length
            remainder > 0 && fillOffset(offset, remainder)

            /**
             * If only one value has been set, ie [1], push a null to the start of
             * the keyframe array. This will let us mark a keyframe at this point
             * that will later be hydrated with the previous value.
             */
            valueKeyframes.length === 1 && valueKeyframes.unshift(null)

            maxDuration = Math.max(delay + duration, maxDuration)
            timeline.duration = Math.max(endTime, timeline.duration)

            /**
             * Add keyframes, mapping offsets to absolute time.
             */
            addKeyframes(
                valueSequence,
                valueKeyframes,
                ease,
                offset,
                startTime,
                endTime
            )
        }

        prevTime = currentTime
        currentTime += maxDuration
    }

    /**
     * Sort keyframes by time
     */
    for (const trackName in timeline.tracks) {
        const track = timeline.tracks[trackName]
        for (const valueName in track) {
            track[valueName].sort(compareByTime)
        }
    }

    return timeline
}

type ReadValue = (key: string) => string | number | null | undefined

export function resolveTrack(
    track: UnresolvedValueSequence,
    valueName: string,
    readValue: ReadValue
) {
    for (let i = 0; i < track.length; i++) {
        if (track[i].value === null) {
            const resolvedValue =
                i === 0 ? readValue(valueName) : track[i - 1].value

            if (resolvedValue !== null && resolvedValue !== undefined) {
                track[i].value = resolvedValue
            }
        }
    }
}

export function createValueTransformers(
    track: UnresolvedTrackSequence,
    readValue: ReadValue
) {
    const transformers: { [key: string]: MapTimeToValue } = {}

    for (const valueName in track) {
        let isResolved = true
        const valueTrack = track[valueName]
        resolveTrack(valueTrack, valueName, readValue)

        const values: Array<string | number> = []
        const times: number[] = []
        const easings = []

        for (let i = 0; i < valueTrack.length; i++) {
            const { at, value, easing } = valueTrack[i]

            if (value === null || !isResolved) {
                isResolved = false
                continue
            }

            values.push(value)
            times.push(at)

            const easingFunction = easingDefinitionToFunction(
                easing || (defaultTransition.easing as any)
            )
            easings.push(easingFunction)
        }

        /**
         * The final easing function is redundant.
         */
        easings.pop()

        if (isResolved) {
            transformers[valueName] = transform(times, values, {
                ease: easings,
            })
        }
    }

    return transformers
}