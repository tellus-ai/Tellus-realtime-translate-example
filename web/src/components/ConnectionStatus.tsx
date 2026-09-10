import type { ConnectionStatus as Status } from '../realtime/types';

export function ConnectionStatus({ result, audio }: { result: Status; audio: Status }) {
  return (
    <div className="connection-status" aria-label="Connection status">
      <span data-status={result}>Result: {result}</span>
      <span data-status={audio}>Audio: {audio}</span>
    </div>
  );
}
