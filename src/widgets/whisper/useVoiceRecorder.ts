/**
 * useVoiceRecorder – push-to-talk recording for the KI-Assistent.
 *
 * - stops on its own after `maxSeconds`
 * - drives a level meter without re-rendering: the current input level
 *   (0…1) is written as CSS variable `--assistant-level` on `levelRef`
 * - the microphone is released on stop, on errors and on unmount (24/7
 *   kiosk: a forgotten MediaStream keeps the mic busy until the next restart)
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface VoiceRecording {
  blob: Blob;
  /** The type the recorder actually produced (decides the upload file name). */
  mimeType: string;
  durationMs: number;
}

interface Options {
  maxSeconds: number;
  onComplete: (recording: VoiceRecording) => void;
  onError: (message: string) => void;
}

export interface VoiceRecorder {
  recording: boolean;
  /** Whole seconds since the start. */
  elapsedSeconds: number;
  levelRef: RefObject<HTMLDivElement | null>;
  start: () => Promise<void>;
  /** Finishes the recording and hands it to `onComplete`. */
  stop: () => void;
  /** Discards the recording. */
  cancel: () => void;
}

/** Preferred containers – OpenAI accepts all of them. */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

type AudioContextConstructor = typeof AudioContext;

export const voiceRecordingSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getUserMedia === 'function' &&
  typeof MediaRecorder !== 'undefined';

function pickMimeType(): string {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function microphoneError(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Kein Zugriff auf das Mikrofon – Berechtigung prüfen.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Kein Mikrofon gefunden.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Das Mikrofon ist belegt oder nicht bereit.';
    default:
      return 'Das Mikrofon konnte nicht geöffnet werden.';
  }
}

export function useVoiceRecorder({ maxSeconds, onComplete, onError }: Options): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const levelRef = useRef<HTMLDivElement | null>(null);

  const callbacks = useRef({ onComplete, onError });
  useLayoutEffect(() => {
    callbacks.current = { onComplete, onError };
  });

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Increments per start; a stale getUserMedia result or recorder event is ignored. */
  const sessionRef = useRef(0);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  /** Releases microphone, meter and timers – safe to call repeatedly. */
  const release = useCallback(() => {
    if (stopTimerRef.current !== null) clearTimeout(stopTimerRef.current);
    if (tickRef.current !== null) clearInterval(tickRef.current);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    stopTimerRef.current = null;
    tickRef.current = null;
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    levelRef.current?.style.setProperty('--assistant-level', '0');
    recorderRef.current = null;
    if (mountedRef.current) setRecording(false);
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    const Context: AudioContextConstructor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
    if (!Context) return;
    try {
      const context = new Context();
      audioContextRef.current = context;
      void context.resume().catch(() => undefined);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const draw = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        // RMS of speech is small – scale it so normal speaking fills most of the bar.
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        levelRef.current?.style.setProperty('--assistant-level', level.toFixed(3));
        frameRef.current = requestAnimationFrame(draw);
      };
      frameRef.current = requestAnimationFrame(draw);
    } catch {
      // The meter is a nicety – recording works without it.
    }
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else release();
  }, [release]);

  const cancel = useCallback(() => {
    sessionRef.current += 1;
    startingRef.current = false;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Already stopped by the browser.
      }
    }
    release();
  }, [release]);

  const start = useCallback(async () => {
    if (startingRef.current || recorderRef.current) return;
    if (!voiceRecordingSupported()) {
      callbacks.current.onError('Dieses Gerät unterstützt keine Sprachaufnahme.');
      return;
    }
    startingRef.current = true;
    const session = ++sessionRef.current;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      if (session === sessionRef.current) {
        startingRef.current = false;
        callbacks.current.onError(microphoneError(err));
      }
      return;
    }
    // Cancelled or unmounted while the permission prompt was open.
    if (session !== sessionRef.current || !mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    startingRef.current = false;
    streamRef.current = stream;

    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
    } catch {
      release();
      callbacks.current.onError('Die Aufnahme konnte nicht gestartet werden.');
      return;
    }
    recorderRef.current = recorder;
    const startedAt = Date.now();

    // A cancelled session was already released; its late events must not
    // touch a newer recording.
    recorder.onstop = () => {
      if (session !== sessionRef.current) return;
      const mimeType = recorder.mimeType || chunks[0]?.type || 'audio/webm';
      release();
      callbacks.current.onComplete({
        blob: new Blob(chunks, { type: mimeType }),
        mimeType,
        durationMs: Date.now() - startedAt,
      });
    };
    recorder.onerror = () => {
      if (session !== sessionRef.current) return;
      sessionRef.current += 1;
      release();
      callbacks.current.onError('Die Aufnahme ist fehlgeschlagen.');
    };

    setRecording(true);
    setElapsedSeconds(0);
    startMeter(stream);
    tickRef.current = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    stopTimerRef.current = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, maxSeconds * 1000);
  }, [maxSeconds, release, startMeter]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, [cancel]);

  return { recording, elapsedSeconds, levelRef, start, stop, cancel };
}
