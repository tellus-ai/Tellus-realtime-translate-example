import type { ClientVadSnapshot } from '../../electron/shared/realtimeTypes';
import './VADStyles.css';

export function VADToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="vad-option">
      <span>Voice Activity Detection</span>
      <span className="vad-toggle-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {enabled ? 'Use audio engine Silero VAD' : 'Use server VAD'}
      </span>
    </label>
  );
}

export function VADStatus({ snapshot }: { snapshot: ClientVadSnapshot }) {
  return (
    <p className="phase">
      VAD: {snapshot.enabled
        ? `${snapshot.ready ? 'Ready' : 'Loading model'} · ${snapshot.gate} · ${snapshot.level}`
        : 'Server VAD'}
    </p>
  );
}
