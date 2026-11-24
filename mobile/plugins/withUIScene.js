// iOS 27 stops an app that is built with its SDK unless the app adopts the UIScene life cycle
// (the crash names _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption). The Expo SDK 55
// template still starts React Native in AppDelegate. This plugin moves that start into a
// SceneDelegate and declares the scene in Info.plist, on every `expo prebuild`.
// The iOS host in this repository is kept in the same state (tests/withUIScene.test.ts checks it).
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const START_IN_APP_DELEGATE = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

const STARTS_IN_SCENE = '    // React Native starts in SceneDelegate, in the window of the scene (plugins/withUIScene.js).\n';

const SCENE_DELEGATE = `
// iOS 27 stops an app that is built with its SDK unless the app adopts the UIScene life cycle.
// Added by plugins/withUIScene.js. React Native starts here, in the window of the scene. The scene
// callbacks go on to AppDelegate, where Expo modules and React Native expect them.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate,
          let factory = appDelegate.reactNativeFactory else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    // The link that opened the app comes with the scene, not with the launch options. React Native
    // reads it from the launch options for Linking.getInitialURL().
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    } else if let activity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) {
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ] as [String: Any]
    }
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      _ = appDelegate?.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = appDelegate?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }
}
`;

const MARKER = 'class SceneDelegate: UIResponder, UIWindowSceneDelegate';

function addSceneDelegate(contents) {
  if (contents.includes(MARKER)) return contents;
  if (!contents.includes(START_IN_APP_DELEGATE)) {
    throw new Error('withUIScene: AppDelegate.swift does not start React Native the way the Expo SDK 55 template does. Update plugins/withUIScene.js for the new template.');
  }
  return contents.replace(START_IN_APP_DELEGATE, STARTS_IN_SCENE) + SCENE_DELEGATE;
}

function addSceneManifest(infoPlist) {
  return {
    ...infoPlist,
    UIApplicationSceneManifest: {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
        }],
      },
    },
  };
}

function withUIScene(config) {
  const withDelegate = withAppDelegate(config, (next) => {
    if (next.modResults.language !== 'swift') {
      throw new Error('withUIScene: only a Swift AppDelegate is supported.');
    }
    next.modResults.contents = addSceneDelegate(next.modResults.contents);
    return next;
  });
  return withInfoPlist(withDelegate, (next) => {
    next.modResults = addSceneManifest(next.modResults);
    return next;
  });
}

module.exports = withUIScene;
module.exports.addSceneDelegate = addSceneDelegate;
module.exports.addSceneManifest = addSceneManifest;
