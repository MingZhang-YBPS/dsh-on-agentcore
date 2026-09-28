#!/usr/bin/env bash
# 构建 AgentCore NODE_22 直接代码部署包（linux/arm64）：适配器 + 锁定版本的 DSH 及全部依赖。
# AgentCore 会读取包内所有 .node / .so 的 ELF 头，任何非 arm64 的二进制都会导致 CREATE_FAILED，
# 因此安装时指定 --os/--cpu/--libc，并删除 node-pty 自带的其他平台 prebuild。
source "$(dirname "$0")/common.sh"

PKG="$BUILD_DIR/pkg"
rm -rf "$BUILD_DIR"; mkdir -p "$PKG"
rsync -a --exclude node_modules --exclude results --exclude aws --exclude ui --exclude .state --exclude build \
  "$SPIKE_DIR"/{package.json,package-lock.json,src,dsh} "$PKG"/
cd "$PKG"
# --ignore-scripts：koffi / node-pty 的 install 脚本会按宿主架构（x64）找 prebuild，找不到就尝试源码编译而失败；
# 运行时它们各自从 @koromix/koffi-linux-arm64 与 node-pty/prebuilds/linux-arm64 加载，不需要安装脚本。
# 唯一有实际作用的是 dsh-subprocess-local 的 postinstall（恢复 spawn-helper 的可执行位），在下面手工完成。
npm ci --omit=dev --os=linux --cpu=arm64 --libc=glibc --ignore-scripts --no-audit --no-fund --loglevel=error
h=node_modules/node-pty/prebuilds/linux-arm64/spawn-helper; [[ -f $h ]] && chmod 755 $h || true  # Linux prebuild 目前不含 spawn-helper（仅 macOS 需要）
# 入口必须是 .js；package.json 为 "type": "module"，所以这是 ESM
printf "import './src/adapter/index.mjs'\n" > app.js

rm -rf node_modules/node-pty/prebuilds/{darwin-*,win32-*,linux-x64}
find node_modules -name '.bin' -type d -prune -exec rm -rf {} +
links=$(find . -type l | wc -l)
[[ "$links" != 0 ]] && { echo "删除 $links 个符号链接"; find . -type l -delete; }

echo "== ELF 架构检查"
bad=$(find . -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' \) -print0 | xargs -0 -r file | grep ELF | grep -v 'aarch64' || true)
other=$(find . -type f -size +8k -print0 | xargs -0 -r file | grep 'ELF' | grep -v 'aarch64' || true)
if [[ -n "$bad$other" ]]; then echo "发现非 arm64 的 ELF："; echo "$bad"; echo "$other"; exit 1; fi
find . -type f \( -name '*.node' -o -name '*.so' \) | sed 's|^\./||' > "$BUILD_DIR/native-files.txt"
echo "   原生模块 $(wc -l < "$BUILD_DIR/native-files.txt") 个，全部为 aarch64"

chmod -R u+rwX,go+rX .
h=node_modules/node-pty/prebuilds/linux-arm64/spawn-helper; [[ -f $h ]] && chmod 755 $h || true  # Linux prebuild 目前不含 spawn-helper（仅 macOS 需要）
rm -f "$BUILD_DIR/adapter.zip"
zip -q -r -X "$BUILD_DIR/adapter.zip" .
echo "== 包大小：解压 $(du -sh "$PKG" | cut -f1)，zip $(du -h "$BUILD_DIR/adapter.zip" | cut -f1)"
