#!/usr/bin/env bash
# 停止本机开发环境（dev.mjs、适配器、dsh web 子进程）：按监听端口找到进程，再连同 dsh 子进程一起结束。
# 端口：网关 ${GATEWAY_PORT:-8000}、适配器 18080、dsh web 13080（与 src/test/dev.mjs 的默认值一致）。
ports="${GATEWAY_PORT:-8000} 18080 13080"
pids=""
for p in $ports; do
  pids="$pids $(ss -ltnpH "sport = :$p" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2)"
done
pids=$(echo $pids | tr ' ' '\n' | sort -u | tr '\n' ' ')
[[ -z "${pids// /}" ]] && { echo "nothing running"; exit 0; }
kill $pids 2>/dev/null
for _ in 1 2 3 4 5 6; do
  sleep 1
  alive=$(ps -o pid= -p $pids 2>/dev/null | tr '\n' ' ')
  [[ -z "${alive// /}" ]] && { echo "stopped: $pids"; exit 0; }
done
kill -9 $alive 2>/dev/null
echo "killed: $alive"
