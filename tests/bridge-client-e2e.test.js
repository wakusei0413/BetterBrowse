import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { API_VERSION } from "../BetterBrowse/src/constants/api-version.js";

const 仓库根目录 = fromFileUrl(new URL("../", import.meta.url));
const 宿主脚本 = join(
  仓库根目录,
  "BetterBrowse",
  "native-host",
  "bb_native_host.js",
);
const Python客户端 = join(
  仓库根目录,
  "skills",
  "BetterBrowse",
  "scripts",
  "betterbrowse_client.py",
);
const 扩展编号 = "a".repeat(32);
const 分块字符数 = 200_000;
const 编码器 = new TextEncoder();
const 解码器 = new TextDecoder();

function 编码原生帧(value) {
  const payload = 编码器.encode(JSON.stringify(value));
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, 4);
  return frame;
}

class 原生帧读取器 {
  constructor(stream) {
    this.reader = stream.getReader();
    this.buffer = new Uint8Array(0);
  }

  async 读取一帧() {
    while (this.buffer.length < 4) await this.#读取更多();
    const length = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength,
    ).getUint32(0, true);
    while (this.buffer.length < 4 + length) await this.#读取更多();
    const payload = this.buffer.slice(4, 4 + length);
    this.buffer = this.buffer.slice(4 + length);
    return JSON.parse(解码器.decode(payload));
  }

  async #读取更多() {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new Error("宿主 stdout 在原生帧完成前关闭");
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
  }
}

async function 等待条件(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function 读取业务请求(reader) {
  while (true) {
    const message = await reader.读取一帧();
    if (
      typeof message?.reqId === "string" && typeof message?.action === "string"
    ) return message;
  }
}

function 启动Python客户端(args, env) {
  return new Deno.Command(Deno.env.get("PYTHON") || "python", {
    args: [Python客户端, ...args],
    cwd: 仓库根目录,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

async function 读取客户端结果(process) {
  const output = await process.output();
  const stdout = 解码器.decode(output.stdout);
  const stderr = 解码器.decode(output.stderr);
  assertEquals(output.code, 0, `Python 客户端失败：${stderr || stdout}`);
  return JSON.parse(stdout);
}

async function 写扩展响应(writer, request, body) {
  await writer.write(编码原生帧({ reqId: request.reqId, ...body }));
}

async function 写扩展分块响应(writer, request, body) {
  const text = JSON.stringify(body);
  const total = Math.ceil(text.length / 分块字符数);
  assert(total > 1, "测试响应必须触发扩展到宿主的分块链路");
  for (let index = 0; index < total; index++) {
    await writer.write(编码原生帧({
      apiVersion: API_VERSION,
      id: request.reqId,
      chunk: { i: index, n: total },
      part: text.slice(index * 分块字符数, (index + 1) * 分块字符数),
    }));
  }
}

Deno.test({
  name: "真实本机宿主与 Python 客户端完成普通请求和大响应链路",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const 临时根目录 = await Deno.makeTempDir({ prefix: "bb-bridge-e2e-" });
    const localAppData = join(临时根目录, "local-app-data");
    const xdgStateHome = join(临时根目录, "xdg-state");
    const home = join(临时根目录, "home");
    await Promise.all([
      Deno.mkdir(localAppData, { recursive: true }),
      Deno.mkdir(xdgStateHome, { recursive: true }),
      Deno.mkdir(home, { recursive: true }),
    ]);
    const bridgeFile = Deno.build.os === "windows"
      ? join(localAppData, "BetterBrowse", "bridge.json")
      : join(xdgStateHome, "better-browse", "bridge.json");
    const 隔离环境 = {
      LOCALAPPDATA: localAppData,
      XDG_STATE_HOME: xdgStateHome,
      HOME: home,
      USERPROFILE: home,
      BB_BRIDGE_FILE: bridgeFile,
      BB_BRIDGE_TIMEOUT_MS: "10000",
    };

    const host = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--quiet",
        宿主脚本,
        `chrome-extension://${扩展编号}/`,
        "--parent-window=0",
      ],
      cwd: 仓库根目录,
      env: 隔离环境,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const writer = host.stdin.getWriter();
    const reader = new 原生帧读取器(host.stdout);

    try {
      await 等待条件(
        async () => {
          try {
            return (await Deno.stat(bridgeFile)).isFile;
          } catch {
            return false;
          }
        },
        `宿主未写入隔离 bridge.json：${bridgeFile}`,
      );

      await writer.write(
        编码原生帧({ internal: "hello", apiVersion: API_VERSION }),
      );
      const ready = await reader.读取一帧();
      assertEquals(ready, {
        internal: "ready",
        apiVersion: API_VERSION,
        compatible: true,
        extensionId: 扩展编号,
      });

      const ordinaryProcess = 启动Python客户端(
        ["call", "TEST_NORMAL", '{"message":"普通请求"}'],
        隔离环境,
      );
      const ordinaryRequest = await 读取业务请求(reader);
      assertEquals(ordinaryRequest.action, "TEST_NORMAL");
      assertEquals(ordinaryRequest.payload, { message: "普通请求" });
      await 写扩展响应(writer, ordinaryRequest, {
        success: true,
        data: { echoed: ordinaryRequest.payload },
      });
      assertEquals(await 读取客户端结果(ordinaryProcess), {
        success: true,
        data: { echoed: { message: "普通请求" } },
      });

      const largeProcess = 启动Python客户端(["call", "TEST_LARGE"], 隔离环境);
      const largeRequest = await 读取业务请求(reader);
      assertEquals(largeRequest.action, "TEST_LARGE");
      const largeText = "大响应内容".repeat(50_001);
      await 写扩展分块响应(writer, largeRequest, {
        success: true,
        data: { text: largeText },
      });
      const largeResult = await 读取客户端结果(largeProcess);
      assertEquals(largeResult.success, true);
      assertEquals(largeResult.data.text, largeText);

      const bridgeInfo = JSON.parse(await Deno.readTextFile(bridgeFile));
      assertEquals(bridgeInfo.apiVersion, API_VERSION);
      assertEquals(bridgeInfo.extensionId, 扩展编号);
      assertEquals(
        PathLikeParent(bridgeFile),
        PathLikeParent(
          Deno.build.os === "windows"
            ? join(localAppData, "BetterBrowse", "占位")
            : join(xdgStateHome, "better-browse", "占位"),
        ),
      );
    } finally {
      try {
        await writer.close();
      } catch {
        // 宿主已退出时无需重复关闭。
      }
      await 等待条件(
        async () => {
          try {
            await Deno.stat(bridgeFile);
            return false;
          } catch (error) {
            return error instanceof Deno.errors.NotFound;
          }
        },
        "宿主 stdin EOF 后未清理隔离 bridge.json",
      );
      const exited = await Promise.race([
        host.status.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (!exited) {
        try {
          host.kill("SIGKILL");
        } catch {
          // 进程已自然退出时无需处理。
        }
        await host.status;
      }
      await Deno.remove(临时根目录, { recursive: true });
    }
  },
});

function PathLikeParent(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(0, normalized.lastIndexOf("/"));
}
