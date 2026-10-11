import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadRecording } from '../electron/audio/downloadRecording';

describe('desktop recording download', () => {
  it('saves exact audio bytes inside ~/download and does not overwrite an existing recording', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tellus-download-test-'));
    try {
      const directory = join(root, 'download');
      const recording = { fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1, 2, 3]) };
      const destination = await downloadRecording(root, recording);
      expect(destination).toBe(join(directory, recording.fileName));
      expect([...await readFile(destination)]).toEqual([1, 2, 3]);
      await expect(downloadRecording(root, { ...recording, data: new Uint8Array([4]) })).rejects.toMatchObject({ code: 'EEXIST' });
      expect([...await readFile(destination)]).toEqual([1, 2, 3]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects paths masquerading as filenames', async () => {
    await expect(downloadRecording('/tmp', { fileName: '../outside.ogg', data: new Uint8Array([1]) })).rejects.toThrow('Invalid recording filename');
  });
});
