import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioRecordingFile } from './OggOpusRecording';

export async function downloadRecording(homeDirectory: string, recording: AudioRecordingFile): Promise<string> {
  if (!/^tellus-recording-[A-Za-z0-9-]+\.ogg$/.test(recording.fileName)) throw new Error('Invalid recording filename.');
  const downloadsDirectory = join(homeDirectory, 'download');
  await mkdir(downloadsDirectory, { recursive: true });
  const destination = join(downloadsDirectory, recording.fileName);
  await writeFile(destination, recording.data, { flag: 'wx' });
  return destination;
}
