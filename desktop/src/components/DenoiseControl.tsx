import type { DenoiseSnapshot } from '../../electron/shared/realtimeTypes';
import './DenoiseStyles.css';

export function DenoiseToggle({ snapshot, disabled, audioSdkEnabled, onChange }: {
  snapshot: DenoiseSnapshot;
  disabled: boolean;
  audioSdkEnabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const locked = disabled || snapshot.updating || !audioSdkEnabled;
  return (
    <label className="denoise-option" aria-disabled={locked} aria-busy={snapshot.updating}>
      <span>Noise Reduction (Denoise)</span>
      <span className="denoise-toggle-row">
        <input type="checkbox" aria-label="Audio SDK denoise" checked={snapshot.enabled && audioSdkEnabled}
          disabled={locked} onChange={(event) => { if (!locked) onChange(event.target.checked); }} />
        {audioSdkEnabled ? snapshot.updating ? 'Applying denoise…' : 'FastEnhancer · change while recording' : 'Audio SDK unavailable'}
      </span>
    </label>
  );
}

export function DenoiseStatus({ snapshot, audioSdkEnabled }: { snapshot: DenoiseSnapshot; audioSdkEnabled: boolean }) {
  return <>
    <p className="phase">Audio SDK denoise: {!audioSdkEnabled ? 'Unavailable' : snapshot.applied === null
      ? `Not started · ${snapshot.enabled ? 'On' : 'Off'} selected` : snapshot.applied ? 'On' : 'Off'}</p>
    {snapshot.error && <p className="error" role="alert">{snapshot.error}</p>}
  </>;
}
