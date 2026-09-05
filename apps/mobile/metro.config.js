const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const config = getDefaultConfig(__dirname);
// Shared protocol code has no runtime dependencies; watch only that source tree.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../../packages/kybern-client")];
module.exports = config;
