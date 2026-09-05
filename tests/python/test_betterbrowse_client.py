"""BetterBrowse Python 桥接客户端的标准库单元与协议测试。"""

from __future__ import annotations

import importlib.util
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENT_PATH = REPO_ROOT / "skills" / "BetterBrowse" / "scripts" / "betterbrowse_client.py"
SPEC = importlib.util.spec_from_file_location("betterbrowse_client", CLIENT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载客户端模块：{CLIENT_PATH}")
client = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(client)


class RecordingSession:
    """按预设响应顺序记录请求的轻量会话。"""

    def __init__(self, responses: list[dict[str, Any]]):
        self.responses = list(responses)
        self.requests: list[tuple[str, Any]] = []

    def request(self, action: str, payload: Any = None) -> dict[str, Any]:
        self.requests.append((action, payload))
        if not self.responses:
            raise AssertionError("测试响应已耗尽")
        return self.responses.pop(0)


class FakeTcpHost:
    """实现令牌握手、请求重组和响应分块的测试 TCP 宿主。"""

    def __init__(self, api_version: int = 1):
        self.api_version = api_version
        self.token = "ab" * 32
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]
        self.handshake: dict[str, Any] | None = None
        self.requests: list[dict[str, Any]] = []
        self.error: BaseException | None = None
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self) -> "FakeTcpHost":
        self.thread.start()
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        try:
            self.listener.close()
        except OSError:
            pass
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise AssertionError("fake TCP host 未按时退出")
        if self.error is not None:
            raise self.error

    def info(self) -> dict[str, Any]:
        return {"port": self.port, "token": self.token, "apiVersion": self.api_version}

    @staticmethod
    def _write_line(output: Any, value: Any) -> None:
        output.write((client.json_text(value) + "\n").encode("utf-8"))
        output.flush()

    def _read_request(self, source: Any) -> dict[str, Any]:
        first = json.loads(source.readline().decode("utf-8"))
        if "chunk" not in first:
            return first
        frame_id = first["id"]
        total = first["chunk"]["n"]
        parts: list[str | None] = [None] * total
        current = first
        while True:
            self._assert_chunk_api_field(current)
            parts[current["chunk"]["i"]] = current["part"]
            if all(part is not None for part in parts):
                return json.loads("".join(part for part in parts if part is not None))
            current = json.loads(source.readline().decode("utf-8"))
            self.assert_equal(frame_id, current["id"])

    def _assert_chunk_api_field(self, frame: dict[str, Any]) -> None:
        self.assert_equal(self.api_version, frame.get("apiVersion"))
        for historical in ("proto", "protocol", "v"):
            if historical in frame:
                raise AssertionError(f"新分块消息不应写历史字段 {historical}")

    @staticmethod
    def assert_equal(expected: Any, actual: Any) -> None:
        if expected != actual:
            raise AssertionError(f"期望 {expected!r}，实际 {actual!r}")

    def _serve(self) -> None:
        try:
            conn, _address = self.listener.accept()
            with conn, conn.makefile("rwb", buffering=0) as stream:
                self.handshake = json.loads(stream.readline().decode("utf-8"))
                self._write_line(
                    stream,
                    {
                        "ok": True,
                        "apiVersion": self.api_version,
                        "extensionId": "a" * 32,
                        "host": "fake",
                    },
                )

                ordinary = self._read_request(stream)
                self.requests.append(ordinary)
                self._write_line(stream, {"id": ordinary["id"], "success": True, "data": ordinary["payload"]})

                large_request = self._read_request(stream)
                self.requests.append(large_request)
                response = {"success": True, "data": {"text": "大" * (client.CHUNK_CHARS + 37)}}
                response_text = client.json_text(response)
                parts = client.split_text(response_text)
                for index, part in enumerate(parts):
                    self._write_line(
                        stream,
                        {
                            "apiVersion": self.api_version,
                            "id": large_request["id"],
                            "chunk": {"i": index, "n": len(parts)},
                            "part": part,
                        },
                    )
        except BaseException as error:
            self.error = error
        finally:
            try:
                self.listener.close()
            except OSError:
                pass


class PathAndApiTests(unittest.TestCase):
    def test_bridge_path_override_and_platform_defaults(self) -> None:
        self.assertEqual(
            Path("~/custom/bridge.json").expanduser(),
            client.bridge_file_path(environ={"BB_BRIDGE_FILE": "~/custom/bridge.json"}),
        )
        self.assertEqual(
            Path("D:/State") / "BetterBrowse" / "bridge.json",
            client.bridge_file_path(platform_name="win32", environ={"LOCALAPPDATA": "D:/State"}),
        )
        self.assertEqual(
            Path("/tmp/state") / "better-browse" / "bridge.json",
            client.bridge_file_path(platform_name="linux", environ={"XDG_STATE_HOME": "/tmp/state"}),
        )
        self.assertEqual(
            Path("/home/test") / ".local" / "state" / "better-browse" / "bridge.json",
            client.bridge_file_path(platform_name="darwin", environ={"HOME": "/home/test"}),
        )

    def test_api_version_reads_current_and_historical_fields(self) -> None:
        for field in ("apiVersion", "proto", "protocol", "v"):
            self.assertEqual(7, client.read_api_version({field: "7"}))
        for invalid in (None, {}, {"apiVersion": True}, {"apiVersion": 0}, {"apiVersion": "x"}):
            self.assertIsNone(client.read_api_version(invalid))

    def test_load_bridge_info_normalizes_historical_api_field(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bridge.json"
            path.write_text(
                json.dumps({"port": 12345, "token": "cd" * 32, "protocol": 3}),
                encoding="utf-8",
            )
            info = client.load_bridge_info(path)
        self.assertEqual(3, info["apiVersion"])
        self.assertEqual(str(path), info["bridgeFile"])


class ArgumentAndMappingTests(unittest.TestCase):
    def test_cli_flags_support_equals_separate_values_and_boolean_flags(self) -> None:
        positional, flags = client.parse_cli_args(
            ["group", "--limit", "50", "--offset=2", "--confirm", "--", "--literal"]
        )
        self.assertEqual(["group", "--literal"], positional)
        self.assertEqual({"limit": "50", "offset": "2", "confirm": True}, flags)

    def test_convenience_commands_map_to_expected_actions(self) -> None:
        cases = [
            ("status", [], {}, "GET_AI_BRIDGE_STATUS"),
            ("capabilities", ["同步"], {}, "GET_AI_CAPABILITIES"),
            ("call", ["CUSTOM", "{\"x\":1}"], {}, "CUSTOM"),
            ("stash-list", [], {"limit": "25"}, "GET_STASH_GROUP_SUMMARIES_PAGE"),
            ("stash-search", ["词"], {}, "SEARCH_STASH"),
            ("group-show", ["g1"], {}, "GET_STASH_GROUP_PAGE"),
            ("stash-add", ["g1", "https://example.com", "标题"], {}, "ADD_STASH_ITEM"),
            ("group-rename", ["g1", "新标题"], {}, "UPDATE_STASH_GROUP"),
            ("group-star", ["g1"], {"off": True}, "UPDATE_STASH_GROUP"),
            ("group-lock", ["g1"], {}, "UPDATE_STASH_GROUP"),
            ("group-delete", ["g1"], {"confirm": True}, "DELETE_STASH_GROUP"),
            ("stash-remove", ["g1", "i1"], {}, "DELETE_STASH_ITEM"),
            ("item-update", ["g1", "i1", "{\"title\":\"新\"}"], {}, "UPDATE_STASH_ITEM"),
            ("group-restore", ["g1"], {}, "RESTORE_STASH_GROUP"),
            ("item-restore", ["g1", "i1"], {}, "RESTORE_STASH_ITEM"),
            ("stash-import", ["https://example.com | 示例"], {}, "IMPORT_STASH_DATA"),
            ("stash-export", [], {}, "EXPORT_STASH_DATA"),
            ("backup-export", ["backup.json"], {}, "READ_EXPORT_CHUNK"),
            ("backup-import", ["{}"], {"confirm": True}, "RESTORE_FULL_BACKUP"),
            ("backups", [], {}, "LIST_AUTO_BACKUPS"),
            ("backup-restore", ["123"], {"confirm": True}, "RESTORE_AUTO_BACKUP"),
            ("backup-delete", ["123"], {"confirm": True}, "DELETE_AUTO_BACKUP"),
            ("config-get", [], {}, "GET_CONFIG"),
            ("config-set", ["{\"tabThreshold\":20}"], {}, "UPDATE_CONFIG"),
            ("config-reset", [], {"confirm": True}, "RESET_CONFIG"),
            ("rule-set", ["example.com", "new"], {}, "SET_DOMAIN_RULE"),
            ("rule-remove", ["example.com"], {}, "REMOVE_DOMAIN_RULE"),
            ("rules-get", [], {}, "GET_DOMAIN_RULES"),
            ("sync-now", [], {}, "RUN_SYNC_NOW"),
            ("sync-status", [], {}, "GET_SYNC_STATUS"),
            ("sync-credentials", ["{\"username\":\"u\"}"], {}, "SAVE_WEBDAV_CREDENTIALS"),
            ("eval-tabs", [], {}, "EVALUATE_TABS"),
            ("tab-count", [], {}, "GET_TAB_COUNT_INFO"),
        ]
        for command, positional, flags, expected_action in cases:
            with self.subTest(command=command):
                built = client.build_request(command, positional, flags)
                self.assertIsNotNone(built)
                self.assertEqual(expected_action, built["action"])

    def test_mapping_preserves_parameters_and_confirmation_bits(self) -> None:
        deletion = client.build_request("group-delete", ["g1"], {"force": True, "confirm": True})
        self.assertEqual({"groupId": "g1", "force": True, "confirm": True}, deletion["payload"])
        page = client.build_request("group-show", ["g1"], {"offset": "4", "limit": "9"})
        self.assertEqual({"groupId": "g1", "offset": 4, "limit": 9}, page["payload"])
        exported = client.build_request("backup-export", [], {"output": "out.json"})
        self.assertTrue(exported["streamExport"])
        self.assertEqual("out.json", exported["outputFile"])


class ChunkAndTcpTests(unittest.TestCase):
    def test_split_text_and_chunk_reassembly_restore_response_id(self) -> None:
        self.assertEqual(["ab", "cd", "e"], client.split_text("abcde", 2))
        session = client.BridgeSession(
            {"port": 1, "token": "00" * 32, "apiVersion": 1}, timeout_ms=1000
        )
        response_text = client.json_text({"success": True, "data": {"value": "甲乙"}})
        parts = client.split_text(response_text, 5)
        completed = None
        for index in reversed(range(len(parts))):
            completed = session._consume_chunk(
                {
                    "apiVersion": 1,
                    "id": "req-1",
                    "chunk": {"i": index, "n": len(parts)},
                    "part": parts[index],
                }
            )
        self.assertEqual("req-1", completed["id"])
        self.assertEqual("甲乙", completed["data"]["value"])

    def test_fake_tcp_host_handshake_requests_and_large_response(self) -> None:
        with FakeTcpHost() as host:
            with client.BridgeSession(host.info(), timeout_ms=5000) as session:
                ordinary = session.request("PING", {"value": 1})
                large_payload = {"text": "请" * (client.CHUNK_CHARS + 50)}
                large = session.request("BIG_REQUEST", large_payload)

        self.assertEqual({"apiVersion": 1, "token": host.token}, host.handshake)
        self.assertNotIn("proto", host.handshake)
        self.assertEqual("PING", host.requests[0]["action"])
        self.assertEqual(large_payload, host.requests[1]["payload"])
        self.assertEqual({"success": True, "data": {"value": 1}}, ordinary)
        self.assertEqual("大" * (client.CHUNK_CHARS + 37), large["data"]["text"])


class PaginationExportAndBatchTests(unittest.TestCase):
    def test_stash_list_collects_multiple_pages_and_passes_cursor(self) -> None:
        session = RecordingSession(
            [
                {"success": True, "data": {"items": [{"id": 1}], "nextCursor": "c2", "hasMore": True}},
                {"success": True, "data": {"items": [{"id": 2}], "hasMore": False}},
            ]
        )
        built = client.build_request("stash-list", [], {"limit": "10"})
        response = client.execute_paginated(session, built)
        self.assertEqual({"success": True, "data": [{"id": 1}, {"id": 2}]}, response)
        self.assertEqual(
            [
                ("GET_STASH_GROUP_SUMMARIES_PAGE", {"limit": 10}),
                ("GET_STASH_GROUP_SUMMARIES_PAGE", {"limit": 10, "cursor": "c2"}),
            ],
            session.requests,
        )

    def test_stash_list_reports_partial_failure(self) -> None:
        session = RecordingSession(
            [
                {"success": True, "data": {"items": [1, 2], "nextCursor": "c2"}},
                {"success": False, "error": "读取失败"},
            ]
        )
        response = client.execute_paginated(
            session, {"action": "GET_STASH_GROUP_SUMMARIES_PAGE", "payload": {"limit": 2}}
        )
        self.assertFalse(response["success"])
        self.assertEqual("PAGINATION_FAILED", response["code"])
        self.assertEqual(1, response["data"]["receivedPages"])
        self.assertEqual(2, response["data"]["receivedItems"])

    def test_backup_export_combines_multiple_chunks_and_tracks_revision(self) -> None:
        session = RecordingSession(
            [
                {"success": True, "data": {"chunk": "{\"名称\":", "nextCursor": "c2", "stashRevision": 8}},
                {"success": True, "data": {"chunk": "\"备份\"}", "nextCursor": None, "stashRevision": 8}},
            ]
        )
        response = client.execute_export(
            session, {"payload": {"type": "full_backup"}, "outputFile": None}
        )
        expected_content = "{\"名称\":\"备份\"}"
        self.assertEqual(expected_content, response["data"]["content"])
        self.assertEqual(len(expected_content.encode("utf-8")), response["data"]["bytes"])
        self.assertEqual(8, session.requests[1][1]["expectedStashRevision"])
        self.assertEqual("c2", session.requests[1][1]["cursor"])

    def test_backup_export_writes_atomically_to_file(self) -> None:
        session = RecordingSession(
            [
                {"success": True, "data": {"chunk": "第一块", "nextCursor": "next", "stashRevision": 2}},
                {"success": True, "data": {"chunk": "第二块", "nextCursor": None, "stashRevision": 2}},
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "nested" / "backup.json"
            response = client.execute_export(
                session,
                {"payload": {"type": "full_backup"}, "outputFile": str(target)},
            )
            self.assertEqual("第一块第二块", target.read_text(encoding="utf-8"))
            self.assertEqual(str(target.resolve()), response["data"]["outputFile"])
            self.assertEqual([], list(target.parent.glob("*.tmp")))

    def test_batch_stops_after_first_failure(self) -> None:
        session = RecordingSession(
            [
                {"success": True, "data": 1},
                {"success": True, "data": {"success": False, "error": "业务失败"}},
                {"success": True, "data": 3},
            ]
        )
        response = client.execute_batch(
            session,
            [
                {"action": "ONE", "payload": {"n": 1}},
                {"action": "TWO", "payload": {"n": 2}},
                {"action": "THREE", "payload": {"n": 3}},
            ],
        )
        self.assertFalse(response["success"])
        self.assertEqual("BATCH_FAILED", response["code"])
        self.assertEqual(1, response["data"]["completed"])
        self.assertEqual(["ONE", "TWO"], [action for action, _payload in session.requests])

    def test_stash_list_stops_on_repeated_cursor(self) -> None:
        session = RecordingSession(
            [
                {"success": True, "data": {"items": [1], "nextCursor": "loop"}},
                {"success": True, "data": {"items": [2], "nextCursor": "loop"}},
            ]
        )
        response = client.execute_paginated(
            session, {"action": "GET_STASH_GROUP_SUMMARIES_PAGE", "payload": {"limit": 1}}
        )
        self.assertFalse(response["success"])
        self.assertEqual("PAGINATION_CURSOR_REPEATED", response["code"])
        self.assertEqual(2, response["data"]["receivedPages"])

    def test_backup_export_stops_on_repeated_cursor(self) -> None:
        session = RecordingSession(
            [
                {"success": True, "data": {"chunk": "a", "nextCursor": "loop", "stashRevision": 1}},
                {"success": True, "data": {"chunk": "b", "nextCursor": "loop", "stashRevision": 1}},
            ]
        )
        with self.assertRaises(client.BridgeClientError) as raised:
            client.execute_export(session, {"payload": {"type": "full_backup"}, "outputFile": None})
        self.assertEqual("EXPORT_CURSOR_REPEATED", raised.exception.code)


class ResponseAndDoctorTests(unittest.TestCase):
    def test_normalize_response_promotes_inner_business_failure(self) -> None:
        normalized = client.normalize_response(
            {"success": True, "data": {"success": False, "error": "指定备份不存在"}}
        )
        self.assertEqual("BUSINESS_OPERATION_FAILED", normalized["code"])
        self.assertFalse(normalized["success"])
        self.assertEqual("指定备份不存在", normalized["error"])

    def test_doctor_fails_when_extension_action_is_unavailable(self) -> None:
        original_load = client.load_bridge_info
        original_session = client.BridgeSession

        class FakeSession:
            hello = {"ok": True, "apiVersion": 1, "extensionId": "a" * 32}

            def __enter__(self) -> "FakeSession":
                return self

            def __exit__(self, *_args: Any) -> None:
                return None

            def request(self, action: str, payload: Any = None) -> dict[str, Any]:
                self.last_action = action
                self.last_payload = payload
                return {"success": False, "error": "扩展未就绪"}

        def fake_load(_path: Any = None) -> dict[str, Any]:
            return {"port": 1, "token": "ab" * 32, "apiVersion": 1, "pid": 1}

        client.load_bridge_info = fake_load  # type: ignore[assignment]
        client.BridgeSession = lambda *_args, **_kwargs: FakeSession()  # type: ignore[assignment]
        try:
            response = client.run_doctor()
        finally:
            client.load_bridge_info = original_load  # type: ignore[assignment]
            client.BridgeSession = original_session  # type: ignore[assignment]
        self.assertFalse(response["success"])
        self.assertEqual("EXTENSION_UNREACHABLE", response["code"])


if __name__ == "__main__":
    unittest.main()
