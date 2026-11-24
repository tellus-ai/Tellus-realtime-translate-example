import { readFileSync } from 'fs';
import { join } from 'path';

// The plugin is plain CommonJS that Expo loads during prebuild.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addSceneDelegate, addSceneManifest } = require('../plugins/withUIScene') as {
  addSceneDelegate(contents: string): string;
  addSceneManifest(infoPlist: Record<string, unknown>): Record<string, unknown>;
};

// The part of the Expo SDK 55 AppDelegate.swift template that the plugin changes.
const TEMPLATE = `class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

const iosHost = join(__dirname, '../ios/TellusRealtimeTranslationExample');

describe('withUIScene', () => {
  it('starts React Native from a SceneDelegate instead of didFinishLaunching', () => {
    const contents = addSceneDelegate(TEMPLATE);
    expect(contents).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
    expect(contents).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate');
    expect(contents).toContain('UIWindow(windowScene: windowScene)');
    expect(contents.match(/factory\.startReactNative\(/g)).toHaveLength(1);
  });

  it('hands links and life-cycle callbacks to AppDelegate, where Expo modules and React Native expect them', () => {
    const contents = addSceneDelegate(TEMPLATE);
    // The link that opened the app is in the connection options, not in the launch options.
    expect(contents).toContain('launchOptions[.url] = url');
    for (const call of [
      'application(UIApplication.shared, open: context.url',
      'application(UIApplication.shared, continue: userActivity',
      'applicationDidBecomeActive(UIApplication.shared)',
      'applicationWillResignActive(UIApplication.shared)',
      'applicationWillEnterForeground(UIApplication.shared)',
      'applicationDidEnterBackground(UIApplication.shared)',
    ]) {
      expect(contents).toContain(call);
    }
  });

  it('changes an already changed AppDelegate.swift no further', () => {
    const once = addSceneDelegate(TEMPLATE);
    expect(addSceneDelegate(once)).toBe(once);
  });

  it('stops the prebuild when the template no longer starts React Native where it expects', () => {
    expect(() => addSceneDelegate('class AppDelegate: ExpoAppDelegate {}\n')).toThrow(/withUIScene/);
  });

  it('declares one window scene with the SceneDelegate, next to the existing Info.plist keys', () => {
    const plist = addSceneManifest({ CFBundleName: 'Example' });
    expect(plist).toEqual({
      CFBundleName: 'Example',
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [{
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          }],
        },
      },
    });
  });

  it('is already applied to the iOS host in this repository', () => {
    const appDelegate = readFileSync(join(iosHost, 'AppDelegate.swift'), 'utf8');
    expect(addSceneDelegate(appDelegate)).toBe(appDelegate);
    const infoPlist = readFileSync(join(iosHost, 'Info.plist'), 'utf8');
    expect(infoPlist).toContain('<key>UIApplicationSceneManifest</key>');
    expect(infoPlist).toContain('<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>');
  });

  it('is registered in app.json, so a fresh prebuild applies it too', () => {
    const appJson = JSON.parse(readFileSync(join(__dirname, '../app.json'), 'utf8'));
    expect(appJson.expo.plugins).toContain('./plugins/withUIScene');
  });
});
