import { useState } from 'react';
import { realtimeSpeechConfig } from '../config/realtimeSpeechConfig';
import { useRealtimeTranslation } from '../hooks/useRealtimeTranslation';
import { ConnectionStatus } from './ConnectionStatus';
import { TranslationPanels } from './TranslationPanels';
import { VADStatus, VADToggle } from './VADControl';

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
  const audioSdkEnabled = realtimeSpeechConfig.audioSdkEnabled !== false;
  const clientVad = vadSelected && !audioSdkEnabled;
  const tokenConfigured = Boolean(realtimeSpeechConfig.accessToken);
  const active = ['preparing-audio', 'creating', 'configuring', 'connecting', 'recording', 'paused', 'reconnecting', 'stopping'].includes(realtime.phase);
  const busy = ['preparing-audio', 'creating', 'configuring', 'connecting', 'stopping'].includes(realtime.phase);

  return (
    <main className="example-shell">
      <header>
        <p className="eyebrow">Tellus Realtime Speech</p>
        <h1>Realtime Translation Example</h1>
        <p>Replace the components and CSS in this area to apply your own design.</p>
      </header>

      <section className="setup-panel">
        {!tokenConfigured && <p className="error" role="alert">Set API_KEY in web/.env.</p>}
        <label>
          Source Language
          <select value={sourceLanguage} disabled={active} onChange={(event) => setSourceLanguage(event.target.value)}>
            {LANGUAGES.map(([code, label]) => <option value={code} key={code}>{label}</option>)}
          </select>
        </label>
        <VADToggle enabled={clientVad} disabled={active} audioSdkEnabled={audioSdkEnabled} onChange={setVadSelected} />
        <label>
          Target Language
          <select value={targetLanguage} disabled={active} onChange={(event) => setTargetLanguage(event.target.value)}>
            {LANGUAGES.map(([code, label]) => <option value={code} key={code}>{label}</option>)}
          </select>
        </label>
      </section>

      <section className="control-panel">
        <button disabled={active || !tokenConfigured} onClick={() => void realtime.start({ sourceLanguage, targetLanguage, clientVad })}>
          Start
        </button>
        {realtime.phase === 'recording' ? (
          <button onClick={() => void realtime.pause()}>Pause</button>
        ) : (
          <button disabled={realtime.phase !== 'paused'} onClick={() => void realtime.resume()}>Resume</button>
        )}
        <button className="danger" disabled={!active || busy} onClick={() => void realtime.stop()}>Stop</button>
      </section>

      <ConnectionStatus result={realtime.resultConnection} audio={realtime.audioConnection} />
      <p className="phase">Status: {realtime.phase}</p>
      <p className="phase">Audio SDK: {audioSdkEnabled ? '사용 중' : '사용하지 않음'}</p>
      <VADStatus snapshot={realtime.vad} audioSdkEnabled={audioSdkEnabled} />
      {realtime.error && <p className="error" role="alert">{realtime.error}</p>}
      <TranslationPanels rows={realtime.rows} targetLanguage={targetLanguage} />
    </main>
  );
}
