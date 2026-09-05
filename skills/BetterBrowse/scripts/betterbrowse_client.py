#!/usr/bin/env python3
"""
BetterBrowse AI 桥接客户端。

仅使用 Python 标准库，通过 bridge.json 发现本机宿主，并使用 TCP + NDJSON
调用 BetterBrowse 扩展的共享 action 处理路径。
"""

from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Mapping, Sequence

CHUNK_CHARS = 200_000
DEFAULT_TIMEOUT_MS = 120_000
HANDSHAKE_TIMEOUT_MS = 10_000
MAX_PAGINATION_PAGES = 10_000
MAX_EXPORT_CHUNKS = 100_000
MAX_EXPORT_BYTES = 8 * 1024 * 1024 * 1024
MIN_PYTHON = (3, 9)
BOOLEAN_FLAGS = {"confirm", "force", "off", "stdin"}
VALUE_FLAGS = {"file", "output", "limit", "offset"}


class BridgeClientError(Exception):
    """携带稳定错误码的客户端异常。"""

    def __init__(self, code: str, message: str, data: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = dict(data or {})

    def envelope(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "success": False,
            "code": self.code,
            "error": self.message,
        }
        if self.data:
            result["data"] = self.data
        return result


def json_text(value: Any, *, pretty: bool = False) -> str:
    """生成 UTF-8 友好的 JSON 文本。"""

    if pretty:
        return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def print_json(value: Any) -> None:
    print(json_text(value, pretty=True))


def response_failed(response: Any) -> bool:
    """同时识别传输失败和 handler 返回的业务失败。"""

    if not isinstance(response, dict):
        return True
    if response.get("success") is False:
        return True
    data = response.get("data")
    return isinstance(data, dict) and data.get("success") is False


def normalize_response(response: dict[str, Any]) -> dict[str, Any]:
    """把 handler 的内层失败转换成一致的顶层失败信封。"""

    data = response.get("data")
    if response.get("success") is True and isinstance(data, dict) and data.get("success") is False:
        return {
            "success": False,
            "code": "BUSINESS_OPERATION_FAILED",
            "error": str(data.get("error") or "BetterBrowse 操作失败"),
            "data": {"result": data},
        }
    return response


def read_api_version(value: Any) -> int | None:
    """兼容读取历史 API 版本字段，新消息只写 apiVersion。"""

    if not isinstance(value, Mapping):
        return None
    raw = None
    for key in ("apiVersion", "proto", "protocol", "v"):
        if key in value:
            raw = value[key]
            break
    if isinstance(raw, bool):
        return None
    try:
        number = int(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number > 0 else None


def bridge_file_path(
    *,
    platform_name: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> Path:
    """返回与本机宿主一致的 bridge.json 路径。"""

    env = os.environ if environ is None else environ
    override = env.get("BB_BRIDGE_FILE")
    if override:
        return Path(override).expanduser()

    platform_value = sys.platform if platform_name is None else platform_name
    home = env.get("USERPROFILE") or env.get("HOME") or "."
    if platform_value.startswith("win"):
        base = env.get("LOCALAPPDATA") or str(Path(home) / "AppData" / "Local")
        return Path(base) / "BetterBrowse" / "bridge.json"

    base = env.get("XDG_STATE_HOME") or str(Path(home) / ".local" / "state")
    return Path(base) / "better-browse" / "bridge.json"


def read_timeout_ms(environ: Mapping[str, str] | None = None) -> int:
    env = os.environ if environ is None else environ
    raw = env.get("BB_BRIDGE_TIMEOUT_MS")
    if raw is None:
        return DEFAULT_TIMEOUT_MS
    try:
        value = int(raw)
    except ValueError as error:
        raise BridgeClientError(
            "TIMEOUT_INVALID",
            "BB_BRIDGE_TIMEOUT_MS 必须是正整数毫秒值",
            {"value": raw},
        ) from error
    if value <= 0:
        raise BridgeClientError(
            "TIMEOUT_INVALID",
            "BB_BRIDGE_TIMEOUT_MS 必须大于 0",
            {"value": raw},
        )
    return value


def load_bridge_info(path: Path | None = None) -> dict[str, Any]:
    """读取并校验宿主自发现文件。"""

    target = bridge_file_path() if path is None else path
    try:
        source = target.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise BridgeClientError(
            "BRIDGE_FILE_NOT_FOUND",
            f"未找到桥接自发现文件 {target}。请确认 BetterBrowse 选项页的「AI 桥接」开关已开启，并且本机宿主已经安装。",
            {"path": str(target)},
        ) from error
    except OSError as error:
        raise BridgeClientError(
            "BRIDGE_FILE_UNREADABLE",
            f"无法读取桥接自发现文件 {target}",
            {"path": str(target), "reason": str(error)},
        ) from error

    try:
        info = json.loads(source)
    except (json.JSONDecodeError, UnicodeError) as error:
        raise BridgeClientError(
            "BRIDGE_FILE_INVALID",
            "bridge.json 不是合法的 UTF-8 JSON",
            {"path": str(target), "reason": str(error)},
        ) from error
    if not isinstance(info, dict):
        raise BridgeClientError("BRIDGE_FILE_INVALID", "bridge.json 顶层必须是对象", {"path": str(target)})

    port = info.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65_535:
        raise BridgeClientError("BRIDGE_PORT_INVALID", "bridge.json 中的 port 不是有效端口", {"path": str(target)})

    token = info.get("token")
    if not isinstance(token, str) or len(token) != 64:
        raise BridgeClientError("BRIDGE_TOKEN_INVALID", "bridge.json 中的 token 格式无效", {"path": str(target)})
    try:
        int(token, 16)
    except ValueError as error:
        raise BridgeClientError("BRIDGE_TOKEN_INVALID", "bridge.json 中的 token 格式无效", {"path": str(target)}) from error

    api_version = read_api_version(info)
    if api_version is None:
        raise BridgeClientError("API_VERSION_INVALID", "bridge.json 中的 apiVersion 不是裸正整数", {"path": str(target)})

    result = dict(info)
    result["apiVersion"] = api_version
    result["bridgeFile"] = str(target)
    return result


def split_text(text: str, size: int = CHUNK_CHARS) -> list[str]:
    if size <= 0:
        raise ValueError("分块大小必须大于 0")
    return [text[index : index + size] for index in range(0, len(text), size)] or [""]


class BridgeSession:
    """单连接、串行请求的 BetterBrowse 桥接会话。"""

    def __init__(self, info: Mapping[str, Any], *, timeout_ms: int | None = None):
        self.info = dict(info)
        self.api_version = int(self.info["apiVersion"])
        self.timeout_ms = read_timeout_ms() if timeout_ms is None else timeout_ms
        self.sock: socket.socket | None = None
        self._buffer = bytearray()
        self._chunks: dict[str, dict[str, Any]] = {}
        self.hello: dict[str, Any] | None = None

    def __enter__(self) -> "BridgeSession":
        return self.connect()

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()

    def connect(self) -> "BridgeSession":
        try:
            self.sock = socket.create_connection(
                ("127.0.0.1", int(self.info["port"])),
                timeout=HANDSHAKE_TIMEOUT_MS / 1000,
            )
        except OSError as error:
            raise BridgeClientError(
                "HOST_UNREACHABLE",
                f"无法连接宿主侧信道 127.0.0.1:{self.info['port']}，宿主可能已经退出",
                {"port": self.info["port"], "reason": str(error)},
            ) from error

        try:
            self._send_line({"apiVersion": self.api_version, "token": self.info["token"]})
            hello = self._read_message(deadline=time.monotonic() + HANDSHAKE_TIMEOUT_MS / 1000)
        except BridgeClientError as error:
            self.close()
            if error.code == "REQUEST_TIMEOUT":
                raise BridgeClientError("HANDSHAKE_TIMEOUT", "握手超时：宿主未在时限内响应令牌校验") from error
            raise

        if not isinstance(hello, dict) or hello.get("ok") is not True:
            self.close()
            peer_version = read_api_version(hello)
            if peer_version is not None and peer_version != self.api_version:
                raise BridgeClientError(
                    "API_VERSION_MISMATCH",
                    str(hello.get("error") or f"API 版本不兼容：客户端 {self.api_version}，宿主 {peer_version}"),
                    {"apiVersion": self.api_version, "peerApiVersion": peer_version},
                )
            raise BridgeClientError(
                "HANDSHAKE_REJECTED",
                str(hello.get("error") if isinstance(hello, dict) else "宿主拒绝握手"),
                {"response": hello},
            )

        peer_version = read_api_version(hello)
        if peer_version != self.api_version:
            self.close()
            raise BridgeClientError(
                "API_VERSION_MISMATCH",
                f"API 版本不兼容：客户端 {self.api_version}，宿主 {peer_version}",
                {"apiVersion": self.api_version, "peerApiVersion": peer_version},
            )

        self.hello = hello
        if self.sock is not None:
            self.sock.settimeout(self.timeout_ms / 1000)
        return self

    def close(self) -> None:
        sock, self.sock = self.sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def _send_line(self, value: Any) -> None:
        if self.sock is None:
            raise BridgeClientError("CONNECTION_CLOSED", "宿主连接已经关闭")
        try:
            self.sock.sendall((json_text(value) + "\n").encode("utf-8"))
        except OSError as error:
            raise BridgeClientError(
                "REQUEST_SEND_FAILED",
                "发送请求失败，宿主连接已经断开",
                {"reason": str(error)},
            ) from error

    def _read_line(self, deadline: float) -> bytes:
        if self.sock is None:
            raise BridgeClientError("CONNECTION_CLOSED", "宿主连接已经关闭")
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self._buffer[:newline]).strip()
                del self._buffer[: newline + 1]
                if line:
                    return line
                continue

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BridgeClientError("REQUEST_TIMEOUT", "等待宿主响应超时")
            self.sock.settimeout(remaining)
            try:
                chunk = self.sock.recv(65_536)
            except socket.timeout as error:
                raise BridgeClientError("REQUEST_TIMEOUT", "等待宿主响应超时") from error
            except OSError as error:
                raise BridgeClientError(
                    "CONNECTION_CLOSED",
                    "等待响应时宿主连接异常关闭",
                    {"reason": str(error)},
                ) from error
            if not chunk:
                raise BridgeClientError("CONNECTION_CLOSED", "等待响应时宿主连接已经关闭")
            self._buffer.extend(chunk)

    def _read_message(self, *, deadline: float) -> dict[str, Any]:
        line = self._read_line(deadline)
        try:
            text = line.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise BridgeClientError("RESPONSE_UTF8_INVALID", "宿主响应不是合法 UTF-8", {"reason": str(error)}) from error
        try:
            message = json.loads(text)
        except json.JSONDecodeError as error:
            raise BridgeClientError("RESPONSE_JSON_INVALID", "宿主响应不是合法 JSON", {"reason": str(error)}) from error
        if not isinstance(message, dict):
            raise BridgeClientError("RESPONSE_INVALID", "宿主响应顶层必须是对象")
        return message

    def _consume_chunk(self, message: Mapping[str, Any]) -> dict[str, Any] | None:
        chunk = message.get("chunk")
        part = message.get("part")
        frame_id = message.get("id")
        if not isinstance(chunk, Mapping) or not isinstance(part, str) or not isinstance(frame_id, str) or not frame_id:
            raise BridgeClientError("CHUNK_INVALID", "宿主返回了无效的分块信封")

        peer_version = read_api_version(message)
        if peer_version != self.api_version:
            raise BridgeClientError(
                "API_VERSION_MISMATCH",
                f"API 版本不兼容：客户端 {self.api_version}，宿主 {peer_version}",
                {"apiVersion": self.api_version, "peerApiVersion": peer_version},
            )

        index = chunk.get("i")
        total = chunk.get("n")
        if isinstance(index, bool) or isinstance(total, bool) or not isinstance(index, int) or not isinstance(total, int):
            raise BridgeClientError("CHUNK_INVALID", "分块序号必须是整数")
        if total <= 0 or index < 0 or index >= total:
            raise BridgeClientError("CHUNK_INVALID", "分块序号超出范围", {"index": index, "total": total})

        entry = self._chunks.get(frame_id)
        if entry is None:
            entry = {"total": total, "parts": [None] * total, "received": 0}
            self._chunks[frame_id] = entry
        elif entry["total"] != total:
            raise BridgeClientError("CHUNK_INVALID", "同一响应的分块总数不一致", {"id": frame_id})

        existing = entry["parts"][index]
        if existing is None:
            entry["parts"][index] = part
            entry["received"] += 1
        elif existing != part:
            raise BridgeClientError("CHUNK_INVALID", "同一分块序号出现不同内容", {"id": frame_id, "index": index})

        if entry["received"] < total:
            return None

        del self._chunks[frame_id]
        joined = "".join(entry["parts"])
        try:
            result = json.loads(joined)
        except json.JSONDecodeError as error:
            raise BridgeClientError("CHUNK_JSON_INVALID", "分块重组后的响应不是合法 JSON", {"reason": str(error)}) from error
        if not isinstance(result, dict):
            raise BridgeClientError("RESPONSE_INVALID", "分块重组后的响应顶层必须是对象")
        result.setdefault("id", frame_id)
        return result

    def request(self, action: str, payload: Any = None) -> dict[str, Any]:
        if not isinstance(action, str) or not action:
            raise BridgeClientError("ACTION_REQUIRED", "action 必须是非空字符串")

        request_id = str(uuid.uuid4())
        envelope = {"id": request_id, "action": action, "payload": payload}
        text = json_text(envelope)
        if len(text) > CHUNK_CHARS:
            parts = split_text(text)
            for index, part in enumerate(parts):
                self._send_line(
                    {
                        "apiVersion": self.api_version,
                        "id": request_id,
                        "chunk": {"i": index, "n": len(parts)},
                        "part": part,
                    }
                )
        else:
            self._send_line(envelope)

        deadline = time.monotonic() + self.timeout_ms / 1000
        while True:
            message = self._read_message(deadline=deadline)
            if "chunk" in message:
                completed = self._consume_chunk(message)
                if completed is None:
                    continue
                message = completed

            response_id = message.get("id")
            if response_id != request_id:
                continue
            result = dict(message)
            result.pop("id", None)
            return result


def parse_cli_args(argv: Sequence[str]) -> tuple[list[str], dict[str, str | bool]]:
    """兼容旧参数形式，并支持 --name value。"""

    positional: list[str] = []
    flags: dict[str, str | bool] = {}
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--":
            positional.extend(argv[index + 1 :])
            break
        if arg.startswith("--") and len(arg) > 2:
            body = arg[2:]
            if "=" in body:
                name, value = body.split("=", 1)
                flags[name] = value
            elif body in BOOLEAN_FLAGS:
                flags[body] = True
            elif body in VALUE_FLAGS and index + 1 < len(argv) and not argv[index + 1].startswith("--"):
                index += 1
                flags[body] = argv[index]
            else:
                flags[body] = True
        else:
            positional.append(arg)
        index += 1
    return positional, flags


def require_arg(positional: Sequence[str], index: int, label: str) -> str:
    try:
        value = positional[index]
    except IndexError as error:
        raise BridgeClientError("ARGUMENT_REQUIRED", f"缺少参数：{label}") from error
    if not value:
        raise BridgeClientError("ARGUMENT_REQUIRED", f"参数不能为空：{label}")
    return value


def parse_int(value: Any, label: str, *, minimum: int | None = None, maximum: int | None = None) -> int:
    if isinstance(value, bool):
        raise BridgeClientError("ARGUMENT_INVALID", f"{label} 必须是整数")
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise BridgeClientError("ARGUMENT_INVALID", f"{label} 必须是整数", {"value": value}) from error
    if minimum is not None and number < minimum:
        raise BridgeClientError("ARGUMENT_INVALID", f"{label} 不能小于 {minimum}", {"value": value})
    if maximum is not None and number > maximum:
        raise BridgeClientError("ARGUMENT_INVALID", f"{label} 不能大于 {maximum}", {"value": value})
    return number


def read_argument_text(
    positional: Sequence[str],
    index: int,
    flags: Mapping[str, str | bool],
    label: str,
    *,
    required: bool = True,
) -> str | None:
    sources = int("file" in flags) + int(flags.get("stdin") is True)
    if sources > 1:
        raise BridgeClientError("INPUT_CONFLICT", "--file 和 --stdin 不能同时使用")
    if "file" in flags:
        if flags["file"] is True or not str(flags["file"]).strip():
            raise BridgeClientError("ARGUMENT_REQUIRED", "--file 必须指定文件路径")
        path = Path(str(flags["file"]))
        try:
            return path.read_text(encoding="utf-8")
        except OSError as error:
            raise BridgeClientError("INPUT_FILE_UNREADABLE", f"无法读取输入文件 {path}", {"reason": str(error)}) from error
    if flags.get("stdin") is True:
        return sys.stdin.read()
    if index < len(positional):
        return positional[index]
    if required:
        raise BridgeClientError("ARGUMENT_REQUIRED", f"缺少参数：{label}，也可以使用 --file 或 --stdin")
    return None


def parse_json_input(
    positional: Sequence[str],
    index: int,
    flags: Mapping[str, str | bool],
    label: str,
    *,
    required: bool = True,
) -> Any:
    text = read_argument_text(positional, index, flags, label, required=required)
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise BridgeClientError("JSON_INVALID", f"{label} 不是合法 JSON", {"reason": str(error)}) from error


def build_request(
    command: str,
    positional: Sequence[str],
    flags: Mapping[str, str | bool],
) -> dict[str, Any] | None:
    """把便利命令映射为插件 action。"""

    if command == "status":
        return {"action": "GET_AI_BRIDGE_STATUS", "payload": None}
    if command == "capabilities":
        return {"action": "GET_AI_CAPABILITIES", "payload": None, "filter": positional[0] if positional else None}
    if command == "call":
        action = require_arg(positional, 0, "ACTION")
        payload = parse_json_input(positional, 1, flags, "payload", required=False)
        return {"action": action, "payload": payload}
    if command == "stash-list":
        limit = parse_int(flags.get("limit", 200), "limit", minimum=1, maximum=200)
        return {"action": "GET_STASH_GROUP_SUMMARIES_PAGE", "payload": {"limit": limit}, "paginate": True}
    if command == "stash-search":
        keyword = positional[0] if positional else ""
        limit = parse_int(flags.get("limit", 100), "limit", minimum=1)
        return {"action": "SEARCH_STASH", "payload": {"keyword": keyword, "limit": limit}}
    if command == "group-show":
        return {
            "action": "GET_STASH_GROUP_PAGE",
            "payload": {
                "groupId": require_arg(positional, 0, "groupId"),
                "offset": parse_int(flags.get("offset", 0), "offset", minimum=0),
                "limit": parse_int(flags.get("limit", 50), "limit", minimum=1),
            },
        }
    if command == "stash-add":
        return {
            "action": "ADD_STASH_ITEM",
            "payload": {
                "groupId": require_arg(positional, 0, "groupId"),
                "item": {"url": require_arg(positional, 1, "url"), "title": positional[2] if len(positional) > 2 else ""},
            },
        }
    if command == "group-rename":
        return {
            "action": "UPDATE_STASH_GROUP",
            "payload": {"groupId": require_arg(positional, 0, "groupId"), "updates": {"title": require_arg(positional, 1, "标题")}},
        }
    if command == "group-star":
        return {
            "action": "UPDATE_STASH_GROUP",
            "payload": {"groupId": require_arg(positional, 0, "groupId"), "updates": {"starred": flags.get("off") is not True}},
        }
    if command == "group-lock":
        return {
            "action": "UPDATE_STASH_GROUP",
            "payload": {"groupId": require_arg(positional, 0, "groupId"), "updates": {"locked": flags.get("off") is not True}},
        }
    if command == "group-delete":
        return {
            "action": "DELETE_STASH_GROUP",
            "payload": {
                "groupId": require_arg(positional, 0, "groupId"),
                "force": flags.get("force") is True,
                "confirm": flags.get("confirm") is True,
            },
        }
    if command == "stash-remove":
        return {
            "action": "DELETE_STASH_ITEM",
            "payload": {"groupId": require_arg(positional, 0, "groupId"), "itemId": require_arg(positional, 1, "itemId")},
        }
    if command == "item-update":
        return {
            "action": "UPDATE_STASH_ITEM",
            "payload": {
                "groupId": require_arg(positional, 0, "groupId"),
                "itemId": require_arg(positional, 1, "itemId"),
                "updates": parse_json_input(positional, 2, flags, "updates"),
            },
        }
    if command == "group-restore":
        return {"action": "RESTORE_STASH_GROUP", "payload": {"groupId": require_arg(positional, 0, "groupId")}}
    if command == "item-restore":
        return {
            "action": "RESTORE_STASH_ITEM",
            "payload": {"groupId": require_arg(positional, 0, "groupId"), "itemId": require_arg(positional, 1, "itemId")},
        }
    if command == "stash-import":
        return {"action": "IMPORT_STASH_DATA", "payload": {"jsonString": read_argument_text(positional, 0, flags, "导入文本")}}
    if command == "stash-export":
        return {"action": "EXPORT_STASH_DATA", "payload": None}
    if command == "backup-export":
        output = flags.get("output") or (positional[0] if positional else None)
        return {"action": "READ_EXPORT_CHUNK", "payload": {"type": "full_backup"}, "streamExport": True, "outputFile": output}
    if command == "backup-import":
        return {
            "action": "RESTORE_FULL_BACKUP",
            "payload": {"jsonString": read_argument_text(positional, 0, flags, "备份 JSON"), "confirm": flags.get("confirm") is True},
        }
    if command == "backups":
        return {"action": "LIST_AUTO_BACKUPS", "payload": None}
    if command == "backup-restore":
        return {
            "action": "RESTORE_AUTO_BACKUP",
            "payload": {"createdAt": parse_int(require_arg(positional, 0, "createdAt"), "createdAt", minimum=0), "confirm": flags.get("confirm") is True},
        }
    if command == "backup-delete":
        return {
            "action": "DELETE_AUTO_BACKUP",
            "payload": {"createdAt": parse_int(require_arg(positional, 0, "createdAt"), "createdAt", minimum=0), "confirm": flags.get("confirm") is True},
        }
    if command == "config-get":
        return {"action": "GET_CONFIG", "payload": None}
    if command == "config-set":
        return {"action": "UPDATE_CONFIG", "payload": parse_json_input(positional, 0, flags, "配置增量")}
    if command == "config-reset":
        return {"action": "RESET_CONFIG", "payload": {"confirm": flags.get("confirm") is True}}
    if command == "rule-set":
        mode = require_arg(positional, 1, "模式")
        if mode not in {"auto", "current", "new"}:
            raise BridgeClientError("ARGUMENT_INVALID", "模式必须是 auto、current 或 new")
        return {"action": "SET_DOMAIN_RULE", "payload": {"domain": require_arg(positional, 0, "域名"), "mode": mode}}
    if command == "rule-remove":
        return {"action": "REMOVE_DOMAIN_RULE", "payload": {"domain": require_arg(positional, 0, "域名")}}
    if command == "rules-get":
        return {"action": "GET_DOMAIN_RULES", "payload": None}
    if command == "sync-now":
        return {"action": "RUN_SYNC_NOW", "payload": None}
    if command == "sync-status":
        return {"action": "GET_SYNC_STATUS", "payload": None}
    if command == "sync-credentials":
        return {"action": "SAVE_WEBDAV_CREDENTIALS", "payload": parse_json_input(positional, 0, flags, "凭据 JSON")}
    if command == "eval-tabs":
        return {"action": "EVALUATE_TABS", "payload": None}
    if command == "tab-count":
        return {"action": "GET_TAB_COUNT_INFO", "payload": None}
    return None


COMMAND_HELP = {
    "call": "call <ACTION> [payload JSON] [--file 文件|--stdin]",
    "stash-list": "stash-list [--limit=N]",
    "group-show": "group-show <groupId> [--offset=N] [--limit=N]",
    "backup-export": "backup-export [输出文件|--output 文件]",
    "backup-import": "backup-import [备份 JSON|--file 文件|--stdin] --confirm",
    "config-set": "config-set [partial JSON|--file 文件|--stdin]",
    "batch": "batch --file operations.json，文件顶层为 [{\"action\":...,\"payload\":...}]",
    "doctor": "doctor：检查 Python、bridge.json、宿主端口、握手和 API 版本",
}

HELP_TEXT = """BetterBrowse AI 桥接客户端

用法：python betterbrowse_client.py <命令> [参数]

诊断与能力：
  doctor                          本地诊断 bridge.json、宿主端口与握手
  status                          桥接连接状态与统一 API 版本
  capabilities [关键字]          获取全部能力或按关键字过滤
  call <ACTION> [payload JSON]    调用任意动作，可用 --file 或 --stdin
  batch --file <operations.json>  在一个会话中串行调用多条 action
  help [命令]                     显示帮助

收纳数据：
  stash-list [--limit=N]                         列出全部收纳组并自动续页
  stash-search <关键字> [--limit=N]              全局检索条目
  group-show <groupId> [--offset=N] [--limit=N]  分页读取组内条目
  stash-add <groupId> <url> [标题]                向组内添加条目
  stash-remove <groupId> <itemId>                 删除条目
  item-update <groupId> <itemId> <updates JSON>   编辑条目
  group-rename/group-star/group-lock/group-restore/item-restore/group-delete
  stash-import [文本|--file 文件|--stdin] / stash-export

备份：
  backup-export [输出文件|--output 文件]          分块导出；指定文件时逐块落盘
  backup-import [备份 JSON|--file 文件|--stdin] --confirm
  backups / backup-restore <createdAt> --confirm / backup-delete <createdAt> --confirm

配置、规则与同步：
  config-get / config-set [JSON|--file 文件|--stdin] / config-reset --confirm
  rules-get / rule-set <域名> <auto|current|new> / rule-remove <域名>
  sync-status / sync-now / sync-credentials [JSON|--file 文件|--stdin]
  eval-tabs / tab-count

成功退出码为 0，传输失败或业务失败为 1。WebDAV 凭据只写不可读；
不可逆操作必须显式携带 --confirm，最终由 BetterBrowse 插件强制校验。"""


def filter_capabilities(response: dict[str, Any], keyword: str | None) -> dict[str, Any]:
    if not keyword or response_failed(response):
        return response
    data = response.get("data")
    if not isinstance(data, dict):
        return response
    needle = keyword.casefold()
    filtered = dict(data)
    actions = data.get("actions")
    if isinstance(actions, list):
        filtered["actions"] = [item for item in actions if needle in json_text(item).casefold()]
    elif isinstance(actions, dict):
        filtered["actions"] = {key: value for key, value in actions.items() if needle in key.casefold() or needle in json_text(value).casefold()}
    result = dict(response)
    result["data"] = filtered
    return result


def execute_paginated(session: BridgeSession, built: Mapping[str, Any]) -> dict[str, Any]:
    items: list[Any] = []
    cursor: Any = None
    seen_cursors: set[str] = set()
    pages = 0
    while True:
        if pages >= MAX_PAGINATION_PAGES:
            return {
                "success": False,
                "code": "PAGINATION_LIMIT_EXCEEDED",
                "error": "分页数量超过客户端安全上限",
                "data": {"partial": True, "receivedPages": pages, "receivedItems": len(items)},
            }
        payload = dict(built["payload"])
        if cursor is not None:
            payload["cursor"] = cursor
        response = session.request(str(built["action"]), payload)
        if response_failed(response):
            return {
                "success": False,
                "code": "PAGINATION_FAILED",
                "error": f"读取第 {pages + 1} 页时失败",
                "data": {"partial": True, "receivedPages": pages, "receivedItems": len(items), "response": response},
            }
        data = response.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            return {
                "success": False,
                "code": "PAGINATION_RESPONSE_INVALID",
                "error": "分页响应缺少 items 数组",
                "data": {"partial": bool(items), "receivedPages": pages},
            }
        pages += 1
        items.extend(data["items"])
        cursor = data.get("nextCursor")
        if cursor:
            cursor_key = json_text(cursor)
            if cursor_key in seen_cursors:
                return {
                    "success": False,
                    "code": "PAGINATION_CURSOR_REPEATED",
                    "error": "分页游标重复，已停止读取以避免无限循环",
                    "data": {"partial": True, "receivedPages": pages, "receivedItems": len(items)},
                }
            seen_cursors.add(cursor_key)
            continue
        if data.get("hasMore") is True:
            return {
                "success": False,
                "code": "PAGINATION_CURSOR_MISSING",
                "error": "分页响应仍有后续数据，但没有返回 nextCursor",
                "data": {"partial": True, "receivedPages": pages, "receivedItems": len(items)},
            }
        return {"success": True, "data": items}


def iter_export_chunks(session: BridgeSession, payload: Mapping[str, Any]) -> Iterable[tuple[str, int]]:
    cursor: Any = None
    expected_revision: Any = None
    seen_cursors: set[str] = set()
    chunks_received = 0
    total_bytes = 0
    while True:
        if chunks_received >= MAX_EXPORT_CHUNKS:
            raise BridgeClientError("EXPORT_LIMIT_EXCEEDED", "导出分块数量超过客户端安全上限")
        request_payload = dict(payload)
        request_payload["cursor"] = cursor
        request_payload["expectedStashRevision"] = expected_revision
        response = session.request("READ_EXPORT_CHUNK", request_payload)
        if response_failed(response):
            raise BridgeClientError("EXPORT_FAILED", "分块导出失败", {"response": response})
        data = response.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("chunk"), str):
            raise BridgeClientError("EXPORT_RESPONSE_INVALID", "分块导出响应缺少 chunk 文本")
        chunk = data["chunk"]
        chunk_bytes = len(chunk.encode("utf-8"))
        chunks_received += 1
        total_bytes += chunk_bytes
        if total_bytes > MAX_EXPORT_BYTES:
            raise BridgeClientError(
                "EXPORT_SIZE_EXCEEDED",
                "导出内容超过客户端 8 GiB 安全上限",
                {"bytes": total_bytes},
            )
        next_cursor = data.get("nextCursor")
        if not chunk and next_cursor:
            raise BridgeClientError("EXPORT_STALLED", "导出返回空分块但仍有后续游标，已停止以避免无限循环")
        yield chunk, chunk_bytes
        expected_revision = data.get("stashRevision")
        if not next_cursor:
            break
        cursor_key = json_text(next_cursor)
        if cursor_key in seen_cursors:
            raise BridgeClientError("EXPORT_CURSOR_REPEATED", "导出游标重复，已停止以避免无限循环")
        seen_cursors.add(cursor_key)
        cursor = next_cursor


def execute_export(session: BridgeSession, built: Mapping[str, Any]) -> dict[str, Any]:
    output_file = built.get("outputFile")
    if not output_file:
        chunks: list[str] = []
        total_bytes = 0
        for chunk, chunk_bytes in iter_export_chunks(session, built["payload"]):
            chunks.append(chunk)
            total_bytes += chunk_bytes
        return {"success": True, "data": {"content": "".join(chunks), "bytes": total_bytes}}

    target = Path(str(output_file)).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    total_bytes = 0
    try:
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
        temp_path = Path(temp_name)
        with os.fdopen(descriptor, "wb") as output:
            for chunk, chunk_bytes in iter_export_chunks(session, built["payload"]):
                encoded = chunk.encode("utf-8")
                output.write(encoded)
                total_bytes += chunk_bytes
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_path, target)
        temp_path = None
        return {"success": True, "data": {"outputFile": str(target), "bytes": total_bytes}}
    except BridgeClientError:
        raise
    except OSError as error:
        raise BridgeClientError("EXPORT_WRITE_FAILED", f"写入备份文件失败：{target}", {"reason": str(error)}) from error
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


def load_batch(flags: Mapping[str, str | bool]) -> list[dict[str, Any]]:
    if "file" not in flags:
        raise BridgeClientError("ARGUMENT_REQUIRED", "batch 必须使用 --file 指定操作文件")
    source = read_argument_text([], 0, flags, "批处理文件")
    try:
        operations = json.loads(source or "")
    except json.JSONDecodeError as error:
        raise BridgeClientError("JSON_INVALID", "批处理文件不是合法 JSON", {"reason": str(error)}) from error
    if not isinstance(operations, list) or not operations:
        raise BridgeClientError("BATCH_INVALID", "批处理文件顶层必须是非空数组")
    result: list[dict[str, Any]] = []
    for index, item in enumerate(operations):
        if not isinstance(item, dict) or not isinstance(item.get("action"), str) or not item["action"]:
            raise BridgeClientError("BATCH_INVALID", f"第 {index + 1} 条操作缺少 action")
        result.append({"action": item["action"], "payload": item.get("payload")})
    return result


def execute_batch(session: BridgeSession, operations: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for index, item in enumerate(operations):
        response = session.request(str(item["action"]), item.get("payload"))
        results.append({"index": index, "action": item["action"], "response": response})
        if response_failed(response):
            return {
                "success": False,
                "code": "BATCH_FAILED",
                "error": f"批处理第 {index + 1} 条操作失败",
                "data": {"completed": index, "results": results},
            }
    return {"success": True, "data": {"completed": len(results), "results": results}}


def process_alive(pid: Any) -> bool | None:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False
    except Exception:
        # Windows 的部分 Python 构建不支持用 os.kill(pid, 0) 探测进程。
        return None


def run_doctor() -> dict[str, Any]:
    path = bridge_file_path()
    checks: dict[str, Any] = {
        "python": {
            "version": ".".join(str(item) for item in sys.version_info[:3]),
            "minimum": ".".join(str(item) for item in MIN_PYTHON),
            "executable": sys.executable,
            "ok": sys.version_info >= MIN_PYTHON,
        },
        "bridgeFile": {"path": str(path), "exists": path.is_file()},
    }
    if sys.version_info < MIN_PYTHON:
        return {
            "success": False,
            "code": "PYTHON_VERSION_UNSUPPORTED",
            "error": "BetterBrowse 客户端需要 Python 3.9 或更高版本",
            "data": checks,
        }
    try:
        info = load_bridge_info(path)
        checks["bridgeFile"].update({"valid": True})
        checks["host"] = {
            "pid": info.get("pid"),
            "processAlive": process_alive(info.get("pid")),
            "port": info["port"],
            "apiVersion": info["apiVersion"],
        }
        with BridgeSession(info) as session:
            checks["host"].update(
                {
                    "reachable": True,
                    "handshake": True,
                    "peerApiVersion": read_api_version(session.hello),
                    "extensionId": session.hello.get("extensionId") if session.hello else info.get("extensionId"),
                }
            )
            status_response = normalize_response(session.request("GET_AI_BRIDGE_STATUS", None))
            if response_failed(status_response):
                raise BridgeClientError(
                    "EXTENSION_UNREACHABLE",
                    "宿主握手成功，但无法通过 Native Messaging 调用 BetterBrowse 扩展",
                    {"response": status_response},
                )
            checks["extension"] = status_response.get("data")
        return {"success": True, "data": checks}
    except BridgeClientError as error:
        checks["failure"] = error.envelope()
        return {
            "success": False,
            "code": error.code,
            "error": error.message,
            "data": checks,
        }


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    command = args[0] if args else "help"
    rest = args[1:] if args else []

    try:
        if sys.version_info < MIN_PYTHON:
            raise BridgeClientError("PYTHON_VERSION_UNSUPPORTED", "BetterBrowse 客户端需要 Python 3.9 或更高版本")

        if command in {"help", "--help"}:
            positional, _flags = parse_cli_args(rest)
            if positional and positional[0] in COMMAND_HELP:
                print(COMMAND_HELP[positional[0]])
            else:
                print(HELP_TEXT)
            return 0

        if command == "doctor":
            response = run_doctor()
            print_json(response)
            return 1 if response_failed(response) else 0

        positional, flags = parse_cli_args(rest)
        if command == "batch":
            operations = load_batch(flags)
            info = load_bridge_info()
            with BridgeSession(info) as session:
                response = execute_batch(session, operations)
            print_json(response)
            return 1 if response_failed(response) else 0

        built = build_request(command, positional, flags)
        if built is None:
            raise BridgeClientError("COMMAND_UNKNOWN", f"未知命令：{command}（运行 help 查看用法）")

        info = load_bridge_info()
        with BridgeSession(info) as session:
            if built.get("paginate"):
                response = execute_paginated(session, built)
            elif built.get("streamExport"):
                response = execute_export(session, built)
            else:
                response = session.request(str(built["action"]), built.get("payload"))
                response = filter_capabilities(response, built.get("filter"))

        response = normalize_response(response)
        print_json(response)
        return 1 if response_failed(response) else 0
    except BridgeClientError as error:
        print_json(error.envelope())
        return 1
    except KeyboardInterrupt:
        print_json({"success": False, "code": "INTERRUPTED", "error": "操作已中断"})
        return 130
    except Exception as error:  # 顶层兜底，避免 traceback 污染 stdout。
        print_json({"success": False, "code": "CLIENT_INTERNAL_ERROR", "error": "客户端发生未处理错误", "data": {"reason": str(error)}})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
