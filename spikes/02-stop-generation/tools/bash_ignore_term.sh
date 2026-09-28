#!/usr/bin/env bash
# 模拟工具：忽略 SIGTERM（SIG_IGN 会被子进程 sleep 继承），用于验证宽限期后升级为 SIGKILL。
# 参数 $1：PID 记录文件，记录本进程及其子进程，供 runner 事后确认全部已退出。
trap '' TERM
echo $$ >> "$1"
sleep 30 &
echo $! >> "$1"
wait
