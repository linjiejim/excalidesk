#!/bin/zsh
# 打发布包：不带测试场景的 .app + .dmg（hdiutil 直接打，不驱动 Finder）→ release/
# 用法：scripts/release.sh；网络慢时可加 CARGO_NET_OFFLINE=true 用本机缓存的 crate
set -e
cd "${0:A:h}/.."
VERSION=$(node -p "require('./package.json').version")
ARCH=$(uname -m)
EXCALIDESK_RELEASE=1 npx tauri build --bundles app
APP=src-tauri/target/release/bundle/macos/Excalidesk.app
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
mkdir -p release
hdiutil create -volname "Excalidesk $VERSION" -srcfolder "$STAGE" -ov -format UDZO "release/Excalidesk_${VERSION}_${ARCH}.dmg"
rm -rf "$STAGE"
ls -la release
