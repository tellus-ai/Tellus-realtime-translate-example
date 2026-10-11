import Constants from 'expo-constants';
import { TurboModuleRegistry } from 'react-native';
import { downloadRecording } from '../src/audio/downloadRecording';

jest.mock('expo-constants', () => ({
  __esModule: true, default: { expoConfig: { name: 'Test', slug: 'test', hostUri: 'localhost:8081' } },
}));
jest.mock('react-native', () => ({ TurboModuleRegistry: { get: jest.fn() } }));

const fetchMock = jest.fn();
const originalFetch = global.fetch;
beforeEach(() => {
  fetchMock.mockReset();
  jest.mocked(TurboModuleRegistry.get).mockReturnValue(null);
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

it('sends exact SDK recording bytes to the Mac instead of the app container', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ path: '/Users/lucas/download/tellus-recording-test.ogg' }) });
  const recording = { fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1, 2, 3]) };
  await expect(downloadRecording(recording)).resolves.toBe('/Users/lucas/download/tellus-recording-test.ogg');
  expect(fetchMock).toHaveBeenCalledWith('http://localhost:8081/__tellus/recordings/tellus-recording-test.ogg', {
    method: 'POST', headers: { 'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1' }, body: recording.data,
  });
});

it('uses the connected Mac host on physical devices', async () => {
  jest.replaceProperty(Constants, 'expoConfig', { name: 'Test', slug: 'test', hostUri: '192.168.1.8:8088' });
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ path: '/Users/lucas/download/test.ogg' }) });
  await downloadRecording({ fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1]) });
  expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.1.8:8088/__tellus/recordings/tellus-recording-test.ogg');
});

it('uses the actual bundle server in native builds that do not include Expo hostUri', async () => {
  jest.replaceProperty(Constants, 'expoConfig', { name: 'Test', slug: 'test' });
  jest.mocked(TurboModuleRegistry.get).mockReturnValue({ getConstants: () => ({ scriptURL: 'http://localhost:8081/.expo/.virtual-metro-entry.bundle?platform=ios' }) });
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ path: '/Users/lucas/download/test.ogg' }) });
  await downloadRecording({ fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1]) });
  expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8081/__tellus/recordings/tellus-recording-test.ogg');
});

it('does not treat an embedded production bundle as a Mac server', async () => {
  jest.replaceProperty(Constants, 'expoConfig', { name: 'Test', slug: 'test' });
  jest.mocked(TurboModuleRegistry.get).mockReturnValue({ getConstants: () => ({ scriptURL: 'file:///app/main.jsbundle' }) });
  await expect(downloadRecording({ fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1]) }))
    .rejects.toThrow('로컬 Expo 개발 서버');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('explains that a local Expo server is needed when no Mac host is configured', async () => {
  jest.replaceProperty(Constants, 'expoConfig', { name: 'Test', slug: 'test' });
  await expect(downloadRecording({ fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1]) }))
    .rejects.toThrow('로컬 Expo 개발 서버');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('preserves captured bytes for retry after a host write error', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Disk is full.' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ path: '/Users/lucas/download/test.ogg' }) });
  const recording = { fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1, 2, 3]) };
  await expect(downloadRecording(recording)).rejects.toThrow('Disk is full.');
  await expect(downloadRecording(recording)).resolves.toContain('/download/');
  expect([...recording.data]).toEqual([1, 2, 3]);
});

it('reports an unavailable download writer without saving to the device instead', async () => {
  fetchMock.mockResolvedValue({ ok: false, json: async () => { throw new Error('Not JSON'); } });
  await expect(downloadRecording({ fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1]) }))
    .rejects.toThrow('Mac의 Expo 개발 서버');
});
