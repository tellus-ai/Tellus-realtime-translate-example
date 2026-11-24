import { devServerOrigin } from '../config/exampleServer';
import type { AudioRecordingFile } from './OggOpusRecording';

export async function downloadRecording(recording: AudioRecordingFile): Promise<string> {
  const serverUrl = devServerOrigin();
  if (!serverUrl) throw new Error('Mac의 ~/download에 저장하려면 로컬 Expo 개발 서버에 연결해 주세요.');
  const response = await fetch(`${serverUrl}/__tellus/recordings/${encodeURIComponent(recording.fileName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1' },
    body: recording.data,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message || '~/download에 저장하지 못했습니다. Mac의 Expo 개발 서버를 확인해 주세요.');
  }
  const result = await response.json();
  return result.path;
}
