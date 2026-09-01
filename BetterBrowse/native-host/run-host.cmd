@echo off
rem BetterBrowse AI bridge native messaging host launcher (spawned by Chrome).
rem KEEP THIS FILE PURE ASCII: cmd.exe parses batch files in the ANSI codepage,
rem so UTF-8 Chinese comments break parsing on GBK systems and the host never
rem starts. Chinese documentation lives in bb_native_host.js (file header) and
rem docs/03-ai-skill-bridge.md.
deno run -A --quiet "%~dp0bb_native_host.js" %*
