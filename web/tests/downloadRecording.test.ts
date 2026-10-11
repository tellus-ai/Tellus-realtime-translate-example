import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadRecording } from '../src/audio/downloadRecording';

afterEach(() => { vi.unstubAllGlobals(); });

describe('web recording download to the Mac', () => {
  it('sends exact Ogg bytes to the local writer and returns the ~/download path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ path: '/Users/lucas/download/tellus-recording-test.ogg' }) });
    vi.stubGlobal('fetch', fetchMock);
    const recording = { fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1, 2, 3]) };
    await expect(downloadRecording(recording)).resolves.toBe('/Users/lucas/download/tellus-recording-test.ogg');
    expect(fetchMock).toHaveBeenCalledWith('/__tellus/recordings/tellus-recording-test.ogg', {
      method: 'POST', headers: { 'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1' }, body: recording.data,
    });
  });

  it('keeps the recording available for retry after a host write error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Disk is full.' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ path: '/Users/lucas/download/test.ogg' }) });
    vi.stubGlobal('fetch', fetchMock);
    const recording = { fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1, 2, 3]) };
    await expect(downloadRecording(recording)).rejects.toThrow('Disk is full.');
    await expect(downloadRecording(recording)).resolves.toContain('/download/');
    expect([...recording.data]).toEqual([1, 2, 3]);
  });

  it('reports when the local server does not provide the recording writer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => { throw new Error('Not JSON'); } }));
    await expect(downloadRecording({ fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1]) }))
      .rejects.toThrow('로컬 개발 서버');
  });

  it('reports connection failures without falling back to another download location', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection failed')));
    await expect(downloadRecording({ fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1]) }))
      .rejects.toThrow('Connection failed');
  });
});
