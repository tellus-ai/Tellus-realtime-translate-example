import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { BrowserMicrophone } from '../audio/BrowserMicrophone';
import { realtimeSpeechConfig } from '../config/realtimeSpeechConfig';
import { RealtimeTranslationSession } from '../realtime/RealtimeTranslationSession';
import type { StartConversationInput } from '../api/conversationApi';

export function useRealtimeTranslation() {
  const session = useMemo(
    () => new RealtimeTranslationSession(
      realtimeSpeechConfig,
      new BrowserMicrophone(),
      realtimeSpeechConfig.accessToken,
    ),
    [],
  );
  const snapshot = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getSnapshot(),
  );

  useEffect(() => () => {
    void session.stop();
  }, [session]);

  return {
    ...snapshot,
    start: useCallback((input: StartConversationInput) => session.start(input), [session]),
    pause: useCallback(() => session.pause(), [session]),
    resume: useCallback(() => session.resume(), [session]),
    stop: useCallback(() => session.stop(), [session]),
  };
}
