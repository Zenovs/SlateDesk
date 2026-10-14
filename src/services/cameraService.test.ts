/**
 * cameraService – one shared stream per camera: ref counting, serialised
 * getUserMedia, aborts and fallbacks (with a fake navigator.mediaDevices).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CameraServiceModule = typeof import('./cameraService');

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stopped = false;
  readonly deviceId: string;
  readonly label: string;

  constructor(deviceId: string) {
    super();
    this.deviceId = deviceId;
    this.label = `Kamera ${deviceId}`;
  }

  stop(): void {
    this.readyState = 'ended';
    this.stopped = true;
  }

  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId };
  }

  /** Unplugged: the browser ends the track and fires 'ended'. */
  unplug(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeStream {
  readonly track: FakeTrack;

  constructor(track: FakeTrack) {
    this.track = track;
  }

  getTracks(): FakeTrack[] {
    return [this.track];
  }

  getVideoTracks(): FakeTrack[] {
    return [this.track];
  }
}

interface FakeCameras {
  devices: string[];
  opened: FakeTrack[];
  maxConcurrentOpens: number;
  /** Error to throw for a device id (instead of opening it). */
  failWith: Map<string, DOMException>;
  getUserMedia: ReturnType<typeof vi.fn>;
}

function installFakeCameras(devices: string[], openDelayMs = 5): FakeCameras {
  let concurrent = 0;
  const fake: FakeCameras = {
    devices,
    opened: [],
    maxConcurrentOpens: 0,
    failWith: new Map(),
    getUserMedia: vi.fn(),
  };
  fake.getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
    concurrent += 1;
    fake.maxConcurrentOpens = Math.max(fake.maxConcurrentOpens, concurrent);
    try {
      await new Promise((resolve) => setTimeout(resolve, openDelayMs));
      const video = constraints.video as MediaTrackConstraints;
      const exact = (video.deviceId as { exact?: string } | undefined)?.exact;
      const id = exact ?? fake.devices[0];
      if (!id || !fake.devices.includes(id)) {
        throw new DOMException('Requested device not found', exact ? 'OverconstrainedError' : 'NotFoundError');
      }
      const failure = fake.failWith.get(id);
      if (failure) throw failure;
      const track = new FakeTrack(id);
      fake.opened.push(track);
      return new FakeStream(track) as unknown as MediaStream;
    } finally {
      concurrent -= 1;
    }
  });
  const events = new EventTarget();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: fake.getUserMedia,
      enumerateDevices: async () =>
        fake.devices.map((deviceId) => ({ kind: 'videoinput', deviceId, label: `Kamera ${deviceId}`, groupId: '' })),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  return fake;
}

let service: CameraServiceModule;

beforeEach(async () => {
  vi.resetModules();
  service = await import('./cameraService');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('acquireCamera', () => {
  it('opens a camera once and stops it with the last release', async () => {
    const fake = installFakeCameras(['a']);
    const [first, second] = await Promise.all([service.acquireCamera(''), service.acquireCamera('')]);

    expect(fake.getUserMedia).toHaveBeenCalledTimes(1);
    expect(first.stream).toBe(second.stream);

    first.release();
    first.release(); // idempotent – must not drop the second holder's reference
    expect(fake.opened[0].stopped).toBe(false);
    second.release();
    expect(fake.opened[0].stopped).toBe(true);
  });

  it('never opens two cameras at the same time', async () => {
    const fake = installFakeCameras(['a', 'b']);
    const leases = await Promise.all([service.acquireCamera('a'), service.acquireCamera('b')]);

    expect(fake.getUserMedia).toHaveBeenCalledTimes(2);
    expect(fake.maxConcurrentOpens).toBe(1);
    for (const lease of leases) lease.release();
  });

  it('shares an open camera with the default camera and with requests for its device id', async () => {
    const fake = installFakeCameras(['a', 'b']);
    const chosen = await service.acquireCamera('b');
    const byDefault = await service.acquireCamera('');
    const sameId = await service.acquireCamera('b');

    expect(fake.getUserMedia).toHaveBeenCalledTimes(1);
    expect(byDefault.stream).toBe(chosen.stream);
    expect(sameId.stream).toBe(chosen.stream);
    for (const lease of [chosen, byDefault, sameId]) lease.release();
    expect(fake.opened[0].stopped).toBe(true);
  });

  it('does not open a camera for a request aborted while waiting', async () => {
    const fake = installFakeCameras(['a']);
    const controller = new AbortController();
    const pending = service.acquireCamera('', controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(fake.getUserMedia).not.toHaveBeenCalled();
  });

  it('rejects at once when aborted while opening and switches the camera off again', async () => {
    const fake = installFakeCameras(['a'], 200);
    const controller = new AbortController();
    const pending = service.acquireCamera('', controller.signal);
    await vi.waitFor(() => expect(fake.getUserMedia).toHaveBeenCalledTimes(1), { interval: 1 });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    await vi.waitFor(() => expect(fake.opened[0]?.stopped).toBe(true));
  });

  it('falls back to another camera when the chosen one is not connected', async () => {
    installFakeCameras(['a']);
    const lease = await service.acquireCamera('missing');

    expect(lease.fallback).toBe(true);
    expect(lease.deviceId).toBe('a');
    lease.release();
  });

  it('maps getUserMedia errors to German messages', async () => {
    const fake = installFakeCameras(['a']);
    fake.failWith.set('a', new DOMException('Permission denied', 'NotAllowedError'));
    await expect(service.acquireCamera('')).rejects.toMatchObject({ kind: 'denied', message: expect.stringContaining('verweigert') });

    fake.failWith.set('a', new DOMException('Could not start video source', 'NotReadableError'));
    await expect(service.acquireCamera('')).rejects.toMatchObject({ kind: 'busy', message: expect.stringContaining('belegt') });

    fake.devices = [];
    await expect(service.acquireCamera('')).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('reports an unplugged camera and opens it anew on the next acquire', async () => {
    const fake = installFakeCameras(['a']);
    const lease = await service.acquireCamera('');
    const ended = vi.fn();
    lease.onEnded(ended);

    fake.opened[0].unplug();
    expect(ended).toHaveBeenCalledTimes(1);

    const next = await service.acquireCamera('');
    expect(fake.getUserMedia).toHaveBeenCalledTimes(2);
    expect(next.stream).not.toBe(lease.stream);
    lease.release();
    next.release();
    expect(fake.opened[1].stopped).toBe(true);
  });
});

describe('CameraSession', () => {
  it('keeps one lease while wanted, reopens on a new device and releases when no longer wanted', async () => {
    const fake = installFakeCameras(['a', 'b']);
    const onChange = vi.fn();
    const session = new service.CameraSession(onChange);

    session.update(true, 'a');
    expect(session.current.status).toBe('starting');
    await vi.waitFor(() => expect(session.current.status).toBe('on'));
    expect(onChange).toHaveBeenCalled();

    session.update(true, 'b');
    expect(fake.opened[0].stopped).toBe(true);
    await vi.waitFor(() => expect(session.current.label).toBe('Kamera b'));

    session.dispose();
    expect(session.current.status).toBe('off');
    expect(fake.opened[1].stopped).toBe(true);
  });

  it('shows the error and retries on request', async () => {
    const fake = installFakeCameras(['a']);
    fake.failWith.set('a', new DOMException('Could not start video source', 'NotReadableError'));
    const session = new service.CameraSession(() => {});

    session.update(true, '');
    await vi.waitFor(() => expect(session.current.status).toBe('error'));
    expect(session.current.error).toContain('belegt');

    fake.failWith.clear();
    session.retry();
    await vi.waitFor(() => expect(session.current.status).toBe('on'));
    session.dispose();
  });
});
