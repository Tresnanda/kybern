// Android has no dark app-icon slot like iOS, but adaptive icons resolve their
// resources against the current configuration. Night-qualified copies of the
// background color and foreground make launchers that honor dark mode show a
// light mark on a dark tile. Themed (monochrome) icons come from app.json.
const fs = require("fs");
const path = require("path");
const {
  withAndroidColorsNight,
  withDangerousMod,
  AndroidConfig,
} = require("expo/config-plugins");

const NIGHT_BACKGROUND = "#181818";
const DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];

module.exports = function withAndroidNightIcon(config) {
  config = withAndroidColorsNight(config, (config) => {
    config.modResults = AndroidConfig.Colors.assignColorValue(
      config.modResults,
      { name: "iconBackground", value: NIGHT_BACKGROUND },
    );
    return config;
  });
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const source = path.join(config.modRequest.projectRoot, "assets/android-icon/night");
      const res = path.join(config.modRequest.platformProjectRoot, "app/src/main/res");
      for (const density of DENSITIES) {
        const folder = path.join(res, `mipmap-night-${density}`);
        await fs.promises.mkdir(folder, { recursive: true });
        await fs.promises.copyFile(
          path.join(source, `ic_launcher_foreground-${density}.png`),
          path.join(folder, "ic_launcher_foreground.png"),
        );
      }
      return config;
    },
  ]);
};
