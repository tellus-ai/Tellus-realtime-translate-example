import Constants from 'expo-constants';
import { TurboModuleRegistry } from 'react-native';
import { devServerOrigin, exampleApiBaseUrl } from '../src/config/exampleServer';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { name: 'Test', slug: 'test' } } }));
jest.mock('react-native', () => ({ TurboModuleRegistry: { get: jest.fn() } }));

const bundleServer = (scriptURL: string) => ({ getConstants: () => ({ scriptURL }) });

beforeEach(() => {
  jest.mocked(TurboModuleRegistry.get).mockReturnValue(null);
});
afterEach(() => jest.restoreAllMocks());

describe('exampleApiBaseUrl', () => {
  it('uses the routes of the Expo development server that served the bundle', () => {
    jest.mocked(TurboModuleRegistry.get).mockReturnValue(bundleServer('http://192.168.1.8:8081/index.bundle?platform=ios'));
    expect(exampleApiBaseUrl('')).toBe('http://192.168.1.8:8081/__tellus/api');
  });

  it('falls back to the Expo host when the bundle URL is not known', () => {
    jest.replaceProperty(Constants, 'expoConfig', { name: 'Test', slug: 'test', hostUri: 'localhost:8081' });
    expect(exampleApiBaseUrl('')).toBe('http://localhost:8081/__tellus/api');
  });

  it('prefers TELLUS_EXAMPLE_API_URL, for a build that does not run against Metro', () => {
    jest.mocked(TurboModuleRegistry.get).mockReturnValue(bundleServer('http://localhost:8081/index.bundle'));
    expect(exampleApiBaseUrl('https://backend.example.test/tellus')).toBe('https://backend.example.test/tellus');
  });

  it('is empty for an embedded bundle without TELLUS_EXAMPLE_API_URL', () => {
    jest.mocked(TurboModuleRegistry.get).mockReturnValue(bundleServer('file:///app/main.jsbundle'));
    expect(devServerOrigin()).toBeUndefined();
    expect(exampleApiBaseUrl('')).toBe('');
  });
});
