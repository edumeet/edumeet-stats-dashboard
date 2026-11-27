/**
 * Recording / recorder-service client events (not in base WebRTC ClientEventTypes).
 * Payloads remain loosely typed until parsed via parseClientEventPayload.
 */

export const RecordingClientEventTypes = {
  RECORDER_SERVICE_STATE_CHANGE: 'RECORDER_SERVICE_STATE_CHANGE',
  RECORDING_SESSION_CREATED: 'RECORDING_SESSION_CREATED',
  RECORDING_SESSION_CLOSED: 'RECORDING_SESSION_CLOSED',
  RECORDING_SESSION_START_RECORDING: 'RECORDING_SESSION_START_RECORDING',
  RECORDING_SESSION_STOP_RECORDING: 'RECORDING_SESSION_STOP_RECORDING',
  RECORDING_SESSION_COUNTDOWN_ENDS: 'RECORDING_SESSION_COUNTDOWN_ENDS',
  RECORDING_SESSION_UPDATE_PRODUCERS: 'RECORDING_SESSION_UPDATE_PRODUCERS',
  RECORDING_SESSION_ADD_RECORDING_TRACK: 'RECORDING_SESSION_ADD_RECORDING_TRACK',
  RECORDING_SESSION_START_RECORDING_TRACK: 'RECORDING_SESSION_START_RECORDING_TRACK',
  RECORDING_SESSION_REMOVE_RECORDING_TRACK: 'RECORDING_SESSION_REMOVE_RECORDING_TRACK',
  RECORDING_SESSION_STOP_RECORDING_TRACK: 'RECORDING_SESSION_STOP_RECORDING_TRACK',
  RECORDING_SESSION_RECORDING_TRACK_PREROLLED: 'RECORDING_SESSION_RECORDING_TRACK_PREROLLED',
  RECORDING_TRACK_STATE_CHANGED: 'RECORDING_TRACK_STATE_CHANGED',
  RECORDING_TRACK_AUDIO_RECORDING_STARTED: 'RECORDING_TRACK_AUDIO_RECORDING_STARTED',
  RECORDING_TRACK_AUDIO_RECORDING_STOPPED: 'RECORDING_TRACK_AUDIO_RECORDING_STOPPED',
  RECORDING_TRACK_VIDEO_RECORDING_STARTED: 'RECORDING_TRACK_VIDEO_RECORDING_STARTED',
  RECORDING_TRACK_VIDEO_RECORDING_STOPPED: 'RECORDING_TRACK_VIDEO_RECORDING_STOPPED',
  STREAM_RECORDING_ID_CHANGED: 'STREAM_RECORDING_ID_CHANGED',
} as const;

export type RecordingClientEventType =
  (typeof RecordingClientEventTypes)[keyof typeof RecordingClientEventTypes];

const RECORDING_PREFIXES = ['RECORDING_', 'RECORDER_'] as const;

export function isRecordingClientEventType(type: string): boolean {
  return RECORDING_PREFIXES.some((p) => type.startsWith(p));
}

export function isKnownRecordingClientEventType(
  type: string,
): type is RecordingClientEventType {
  return (Object.values(RecordingClientEventTypes) as string[]).includes(type);
}

/** Longest state name or identifier taken from a payload; the real ones are far shorter. */
const PAYLOAD_STRING_MAX = 256;

/**
 * A payload field used as a state name or an identifier, if it is one.
 *
 * The payload is whatever the client sent, so `payload.takeId as string` is a
 * wish: the value may be a number, an array or an object. Only a string is
 * returned, cut to a sane length; anything else counts as absent.
 */
export function payloadString(
  payload: Record<string, unknown> | null | undefined,
  field: string,
): string | undefined {
  const value = payload?.[field];
  return typeof value === 'string' ? value.slice(0, PAYLOAD_STRING_MAX) : undefined;
}

/** Timeline / chart color for STREAM_RECORDING_ID_CHANGED markers. */
export const STREAM_RECORDING_ID_COLOR = '#ec4899';

/** A point in time where the recording id backing a producer's stream changed. */
export interface StreamRecordingIdEvent {
  timestamp: number;
  newId?: string;
  source?: string;
}

export function extractStreamRecordingIdEvents(
  events: Array<{ timestamp: Date; type: string; payload: Record<string, unknown> }>,
): StreamRecordingIdEvent[] {
  return events
    .filter((e) => e.type === RecordingClientEventTypes.STREAM_RECORDING_ID_CHANGED)
    .map((e) => ({
      timestamp: e.timestamp.getTime(),
      newId: payloadString(e.payload, 'newId'),
      source: payloadString(e.payload, 'source'),
    }));
}
