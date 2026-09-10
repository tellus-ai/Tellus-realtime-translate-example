import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { StartConversationInput } from '../api/conversationApi';
import { NativeMicrophone } from '../audio/NativeMicrophone';
import { realtimeSpeechConfig } from '../config/realtimeSpeechConfig';
import { RealtimeTranslationSession } from '../realtime/RealtimeTranslationSession';

export function useRealtimeTranslation() {
  const session = useMemo(
    () => new RealtimeTranslationSession(
      realtimeSpeechConfig,
      new NativeMicrophone(),
      realtimeSpeechConfig.accessToken,
    ),
    [],
  );
  const snapshot = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getSnapshot(),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active' && session.getSnapshot().phase === 'recording') {
        void session.pause();
      }
    });
    return () => subscription.remove();
  }, [session]);

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
