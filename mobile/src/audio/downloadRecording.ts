import Constants from 'expo-constants';
import { TurboModuleRegistry } from 'react-native';
import type { AudioRecordingFile } from './OggOpusRecording';

export async function downloadRecording(recording: AudioRecordingFile): Promise<string> {
  const host = Constants.expoConfig?.hostUri;
  const scriptUrl = TurboModuleRegistry.get<{ getConstants(): { scriptURL: string } }>('SourceCode')?.getConstants().scriptURL;
  const serverUrl = scriptUrl?.match(/^https?:\/\/[^/]+/)?.[0] || (host ? `http://${host}` : undefined);
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
