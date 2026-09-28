#!/usr/bin/env bash
# 模拟工具：派生子进程与孙进程（子 shell → sleep），用于验证按进程组整体终止。
# 参数 $1：PID 记录文件。
echo $$ >> "$1"
( sleep 30 & echo $! >> "$1"; sleep 30 & echo $! >> "$1"; wait ) &
echo $! >> "$1"
bash -c 'sleep 30 & echo $! >> "$0"; wait' "$1" &
echo $! >> "$1"
wait
