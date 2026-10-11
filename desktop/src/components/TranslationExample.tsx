import { useState } from 'react';
import { realtimeSpeechConfig } from '../config/realtimeSpeechConfig';
import { useRealtimeTranslation } from '../hooks/useRealtimeTranslation';
import { ConnectionStatus } from './ConnectionStatus';
import { TranslationPanels } from './TranslationPanels';
import { VADStatus, VADToggle } from './VADControl';
import { DenoiseStatus, DenoiseToggle } from './DenoiseControl';

const LANGUAGES = [
  ['ko-KR', '한국어 (Korean)'],
  ['en-US', 'English'],
  ['zh-CN', '中文 (Chinese)'],
  ['ja-JP', '日本語 (Japanese)'],
  ['vi-VN', 'Tiếng Việt (Vietnamese)'],
  ['ru-RU', 'Русский (Russian)'],
  ['de-DE', 'Deutsch (German)'],
  ['th-TH', 'ไทย (Thai)'],
  ['pl-PL', 'Polski (Polish)'],
  ['es-ES', 'Español (Spanish)'],
  ['fr-FR', 'Français (French)'],
] as const;

export function TranslationExample() {
  const realtime = useRealtimeTranslation();
  const [sourceLanguage, setSourceLanguage] = useState('ko-KR');
  const [targetLanguage, setTargetLanguage] = useState('en-US');
  const [vadSelected, setVadSelected] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const audioSdkEnabled = realtimeSpeechConfig.audioSdkEnabled !== false;
  const clientVad = vadSelected && !audioSdkEnabled;
  const tokenConfigured = realtimeSpeechConfig.accessTokenConfigured;
  const active = ['preparing-audio', 'creating', 'configuring', 'connecting', 'recording', 'paused', 'reconnecting', 'stopping'].includes(realtime.phase);
  const busy = ['preparing-audio', 'creating', 'configuring', 'connecting', 'stopping'].includes(realtime.phase);

  async function downloadAudio() {
    setDownloading(true);
    setDownloadMessage(null);
    setDownloadError(null);
    try { setDownloadMessage(`저장 완료: ${await realtime.downloadAudio()}`); }
    catch (error) { setDownloadError(error instanceof Error ? error.message : String(error)); }
    finally { setDownloading(false); }
  }

  return (
    <main className="example-shell">
      <header>
        <p className="eyebrow">Tellus Realtime Speech</p>
        <h1>Realtime Translation Example</h1>
        <p>Replace the components and CSS in this area to apply your own design.</p>
      </header>

      <section className="setup-panel">
        {!tokenConfigured && <p className="error" role="alert">Set API_KEY in desktop/.env and restart the app.</p>}
        <label>
          Source Language
          <select value={sourceLanguage} disabled={active} onChange={(event) => setSourceLanguage(event.target.value)}>
            {LANGUAGES.map(([code, label]) => <option value={code} key={code}>{label}</option>)}
          </select>
        </label>
        <VADToggle enabled={clientVad} disabled={active} audioSdkEnabled={audioSdkEnabled} onChange={setVadSelected} />
        <DenoiseToggle snapshot={realtime.denoise} disabled={busy || realtime.phase === 'reconnecting'} audioSdkEnabled={audioSdkEnabled}
          onChange={(enabled) => void realtime.setDenoiseEnabled(enabled)} />
        <label>
          Target Language
          <select value={targetLanguage} disabled={active} onChange={(event) => setTargetLanguage(event.target.value)}>
            {LANGUAGES.map(([code, label]) => <option value={code} key={code}>{label}</option>)}
          </select>
        </label>
      </section>

      <section className="control-panel">
        <button disabled={active || downloading || realtime.denoise.updating || !tokenConfigured} onClick={() => {
          setDownloadMessage(null); setDownloadError(null);
          void realtime.start({ sourceLanguage, targetLanguage, clientVad });
        }}>
          Start
        </button>
        {realtime.phase === 'recording' ? (
          <button onClick={() => void realtime.pause()}>Pause</button>
        ) : (
          <button disabled={realtime.phase !== 'paused'} onClick={() => void realtime.resume()}>Resume</button>
        )}
        <button className="danger" disabled={!active || busy} onClick={() => void realtime.stop()}>Stop</button>
        <button disabled={active || !realtime.recordingAvailable || downloading} onClick={() => void downloadAudio()}>
          {downloading ? 'Saving…' : 'Download Audio'}
        </button>
      </section>

      <p className="phase">Stop 후 SDK 캡처 음성을 ~/download 폴더에 Ogg(Opus) 파일로 저장합니다.</p>
      {downloadMessage && <p className="phase" role="status">{downloadMessage}</p>}
      {downloadError && <p className="error" role="alert">{downloadError}</p>}

      <ConnectionStatus result={realtime.resultConnection} audio={realtime.audioConnection} />
      <p className="phase">Status: {realtime.phase}</p>
      <p className="phase">Audio SDK: {audioSdkEnabled ? '사용 중' : '사용하지 않음'}</p>
      <DenoiseStatus snapshot={realtime.denoise} audioSdkEnabled={audioSdkEnabled} />
      <VADStatus snapshot={realtime.vad} audioSdkEnabled={audioSdkEnabled} />
      {realtime.error && <p className="error" role="alert">{realtime.error}</p>}
      <TranslationPanels rows={realtime.rows} targetLanguage={targetLanguage} />
    </main>
  );
}
