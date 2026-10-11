import type { AudioRecordingFile } from './OggOpusRecording';

export async function downloadRecording(recording: AudioRecordingFile): Promise<string> {
  const response = await fetch(`/__tellus/recordings/${encodeURIComponent(recording.fileName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1' },
    body: recording.data,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message || '~/download에 저장하지 못했습니다. 로컬 개발 서버를 확인해 주세요.');
  }
  const result = await response.json();
  return result.path;
}
