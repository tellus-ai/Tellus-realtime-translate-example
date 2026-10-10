import type { ClientVadSnapshot } from '../../electron/shared/realtimeTypes';
import './VADStyles.css';

export function VADToggle({ enabled, disabled, audioSdkEnabled, onChange }: {
  enabled: boolean;
  disabled: boolean;
  audioSdkEnabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const locked = disabled || audioSdkEnabled;
  return (
    <label className="vad-option" aria-disabled={locked}>
      <span>Voice Activity Detection</span>
      <span className="vad-toggle-row">
        <input
          type="checkbox"
          aria-label="Voice Activity Detection"
          checked={enabled && !audioSdkEnabled}
          disabled={locked}
          onChange={(event) => { if (!locked) onChange(event.target.checked); }}
        />
        {audioSdkEnabled ? 'Disabled while using audio-sdk' : enabled ? 'Use Silero client VAD' : 'Use server VAD'}
      </span>
    </label>
  );
}

export function VADStatus({ snapshot, audioSdkEnabled }: { snapshot: ClientVadSnapshot; audioSdkEnabled: boolean }) {
  return (
    <p className="phase">
      Client VAD: {snapshot.enabled && !audioSdkEnabled
        ? `${snapshot.ready ? 'Ready' : 'Loading model'} · ${snapshot.gate} · ${snapshot.level}`
        : audioSdkEnabled ? 'Disabled (audio-sdk)' : 'Disabled'}
    </p>
  );
}
