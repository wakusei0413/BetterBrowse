#!/bin/sh
# BetterBrowse AI 桥接本机宿主启动包装（由 Chrome Native Messaging 拉起，请勿手动运行）
# 透传 Chrome 注入的扩展来源参数（chrome-extension://<ID>/）
exec deno run -A --quiet "$(dirname "$0")/bb_native_host.js" "$@"
