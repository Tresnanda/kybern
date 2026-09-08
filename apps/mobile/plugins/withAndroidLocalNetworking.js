// Daemons can be reached directly over a LAN or an encrypted Tailscale route.
// Android's release default blocks these http:// and ws:// endpoints even
// though Expo Go and debug builds allow them. HTTPS/WSS remain supported.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withAndroidLocalNetworking(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) throw new Error("Android application manifest is missing");
    application.$["android:usesCleartextTraffic"] = "true";
    return config;
  });
};
