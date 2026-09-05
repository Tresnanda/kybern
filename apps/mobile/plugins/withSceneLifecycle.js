// Adopts the UIKit scene-based life cycle in the generated iOS project.
//
// Apps linked against the iOS 27 SDK must declare a UIApplicationSceneManifest
// or UIKit stops them at launch (Apple TN3187). Expo SDK 57's template still
// starts React Native from the AppDelegate window, so this plugin moves that
// into a SceneDelegate and forwards URL opens to the existing linking hooks.
// Remove once Expo ships `ExpoAppSceneDelegate` (expo/expo#46733) in SDK 57.

const { withAppDelegate, withInfoPlist } = require("@expo/config-plugins");

const SCENE_CONFIGURATION = `  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
`;

const SCENE_DELEGATE = `class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory else {
      return
    }
    let nextWindow = UIWindow(windowScene: windowScene)
    window = nextWindow
    appDelegate.window = nextWindow
    factory.startReactNative(withModuleName: "main", in: nextWindow, launchOptions: appDelegate.launchOptions)
    if !connectionOptions.urlContexts.isEmpty {
      self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    }
    for activity in connectionOptions.userActivities {
      _ = appDelegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let context = URLContexts.first, let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
    if let source = context.options.sourceApplication { options[.sourceApplication] = source }
    if let annotation = context.options.annotation { options[.annotation] = annotation }
    _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`;

const STARTUP_BLOCK =
  /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif/;

function patchAppDelegate(contents) {
  if (contents.includes("class SceneDelegate")) return contents;
  if (!STARTUP_BLOCK.test(contents)) {
    throw new Error("withSceneLifecycle: the AppDelegate React Native startup block was not found; the Expo template changed.");
  }
  let next = contents.replace(STARTUP_BLOCK, "    self.launchOptions = launchOptions");
  next = next.replace("  var window: UIWindow?\n", "  var window: UIWindow?\n  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n");
  const linking = "\n  // Linking API";
  if (!next.includes(linking)) throw new Error("withSceneLifecycle: the AppDelegate linking section was not found.");
  next = next.replace(linking, `\n${SCENE_CONFIGURATION}${linking}`);
  const marker = "\nclass ReactNativeDelegate: ExpoReactNativeFactoryDelegate";
  if (!next.includes(marker)) throw new Error("withSceneLifecycle: ReactNativeDelegate was not found.");
  return next.replace(marker, `\n${SCENE_DELEGATE}${marker}`);
}

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate" },
        ],
      },
    };
    return c;
  });
  return withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") throw new Error("withSceneLifecycle needs a Swift AppDelegate.");
    c.modResults.contents = patchAppDelegate(c.modResults.contents);
    return c;
  });
};
