#!/usr/bin/env bash
# 构建 AgentCore NODE_22 直接代码部署包（linux/arm64 zip）：
#   1. esbuild 把适配器（services/adapter/src/cli.ts 及其依赖的工作区包、ws、SigV4 相关 SDK）打包成单个 app.js（ESM）；
#   2. 按 services/adapter/runtime/package-lock.json 安装锁定版本的 DSH（arm64/glibc 变体，--ignore-scripts）；
#   3. 删除非 arm64 的 prebuild、.bin 与符号链接；校验全部 ELF 为 aarch64、压缩包小于 250 MB。
# AgentCore 会检查包内所有 .node / .so 的 ELF 头，任何非 arm64 的二进制都会导致 CREATE_FAILED（Spike 06）。
# 输出：$ADAPTER_BUILD_DIR/adapter.zip（默认 ~/.cache/dsh-poc/adapter-build；放在原生文件系统上，WSL 的 DrvFs 很慢）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${ADAPTER_BUILD_DIR:-$HOME/.cache/dsh-poc/adapter-build}"
PKG="$OUT/pkg"
MAX_ZIP_BYTES=$((250 * 1024 * 1024))
# ADAPTER_ARCH=x64 只用于在本机（x86_64）冒烟测试打包产物，部署必须是 arm64
ARCH="${ADAPTER_ARCH:-arm64}"
case "$ARCH" in arm64) ELF=aarch64 ;; x64) ELF=x86-64 ;; *) echo "ADAPTER_ARCH 只能是 arm64 或 x64" >&2; exit 1 ;; esac

rm -rf "$PKG" "$OUT/adapter.zip"
mkdir -p "$PKG/dsh"

echo "== 1/4 esbuild 打包适配器"
"$ROOT/node_modules/.bin/esbuild" "$ROOT/services/adapter/src/cli.ts" \
  --bundle --platform=node --target=node22 --format=esm --outfile="$PKG/app.js" \
  --conditions=source --external:@deepseek-ai/dsh --legal-comments=none --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
cp "$ROOT"/services/adapter/dsh/*.cordis.yml "$PKG/dsh/"
cp "$ROOT/services/adapter/runtime/package.json" "$ROOT/services/adapter/runtime/package-lock.json" "$PKG/"

echo "== 2/4 安装锁定版本的 DSH（linux/$ARCH/glibc）"
(cd "$PKG" && npm ci --omit=dev --os=linux --cpu="$ARCH" --libc=glibc --ignore-scripts --no-audit --no-fund --loglevel=error)
# dsh-subprocess-local 的 postinstall 只是恢复 spawn-helper 的可执行位；Linux prebuild 目前不含 spawn-helper
h="$PKG/node_modules/node-pty/prebuilds/linux-$ARCH/spawn-helper"; [[ -f $h ]] && chmod 755 "$h" || true

echo "== 3/4 清理与 ELF 架构检查"
find "$PKG/node_modules/node-pty/prebuilds" -mindepth 1 -maxdepth 1 ! -name "linux-$ARCH" -exec rm -rf {} + 2>/dev/null || true
find "$PKG/node_modules" -name '.bin' -type d -prune -exec rm -rf {} +
find "$PKG" -type l -delete
bad="$(find "$PKG" -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -size +8k \) -print0 | xargs -0 -r file | grep ELF | grep -v "$ELF" || true)"
if [[ -n "$bad" ]]; then echo "发现非 $ARCH 的 ELF：" >&2; echo "$bad" >&2; exit 1; fi
echo "   原生模块 $(find "$PKG" -type f \( -name '*.node' -o -name '*.so' \) | wc -l) 个，全部为 $ELF"
node --check "$PKG/app.js"  # 语法检查（不启动服务）

echo "== 4/4 打包"
chmod -R u+rwX,go+rX "$PKG"
# 可重复构建：固定所有文件的时间戳并按路径排序打包。输入不变时 zip 字节不变 → CDK 资产哈希不变 →
# Runtime 不产生新版本（Spike 08：Runtime 的任何变更都会清空全部用户的 session storage）
find "$PKG" -exec touch -h -d @315532800 {} +
(cd "$PKG" && find . \( -type f -o -type l \) | LC_ALL=C sort | zip -q -X -@ "$OUT/adapter.zip")
size="$(stat -c %s "$OUT/adapter.zip")"
[[ "$size" -lt "$MAX_ZIP_BYTES" ]] || { echo "adapter.zip 超过 250 MB：$size" >&2; exit 1; }
sha="$(sha256sum "$OUT/adapter.zip" | cut -d' ' -f1)"
echo "$sha" > "$OUT/adapter.zip.sha256"
echo "   解压 $(du -sh "$PKG" | cut -f1)，zip $((size / 1024 / 1024)) MB，sha256 ${sha:0:12}…"
echo "$OUT/adapter.zip"
