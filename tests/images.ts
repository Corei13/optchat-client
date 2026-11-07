// Reply images (fake engine, no real workspace): a talk entry whose meta.images holds an optchat-file image the engine
// copied to a blob (and one it refused) shows the image under the reply: the feed lays out img.<blob> and fetches
// /engine/blob/<sha> once. The app runs hidden in the background (open -g -j, OPTCHAT_TEST_BACKGROUND: no activate),
// headless (frames laid out by the app), so the front app never changes.
//   deno run -A tests/images.ts [png]     (build the dev bundle first: shells/mac/release/bundle.sh)
import { ROOT, sleep } from "./lib/cua.ts";

const PORT = 18797, WS = "test-gpui-g"; // a test workspace name; it lives only on the fake engine
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };

// a 320×200 png (no fixture file): crc32 + zlib through CompressionStream
async function png(w: number, h: number): Promise<Uint8Array> {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Uint8Array) => { const td = new Uint8Array([...new TextEncoder().encode(type), ...data]); return new Uint8Array([...u32(data.length), ...td, ...u32(crc(td))]); };
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (1 + w * 3) + 1 + x * 3; raw[o] = x < w / 2 ? 30 : 220; raw[o + 1] = 160; raw[o + 2] = y < h / 2 ? 60 : 200; }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", new Uint8Array([...u32(w), ...u32(h), 8, 2, 0, 0, 0])), ...chunk("IDAT", z), ...chunk("IEND", new Uint8Array())]);
}

const dir = await Deno.makeTempDir({ prefix: "optchat-img-" });
const img = Deno.args[0] ?? `${dir}/reply.png`;
if (!Deno.args[0]) Deno.writeFileSync(img, await png(320, 200));
Deno.writeTextFileSync(`${dir}/tokens.json`, JSON.stringify({ [WS]: "fake-token" }));
const front = () => new TextDecoder().decode(new Deno.Command("lsappinfo", { args: ["front"] }).outputSync().stdout).trim();
const front0 = front();

const eng = new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-lock", `${ROOT}/tests/lib/fake-engine.ts`, String(PORT), WS, `--image=${img}`], stdout: "null", stderr: "null" }).spawn();
await sleep(1200);
const probes = `${dir}/probes.json`;
const env: Record<string, string> = {
  OPTCHAT_HEADLESS: "1", OPTCHAT_TEST_HOOKS: "1", OPTCHAT_TEST_BACKGROUND: "1", OPTCHAT_TEST_NO_GLOBAL: "1",
  OPTCHAT_LOCAL_TOKEN_FILE: `${dir}/no-local-token`, OPTCHAT_PROBES: probes, OPTCHAT_PREFS_DIR: dir, OPTCHAT_TOKEN_DIR: dir,
  OPTCHAT_TEST_TOKENS: `${dir}/tokens.json`, OPTCHAT_ENGINE: `http://127.0.0.1:${PORT}`, OPTCHAT_ENGINE_NAME: "fake", OPTCHAT_CONNECT: WS,
};
const args = ["-n", "-g", "-j", "-W", "--stderr", `${dir}/stderr.txt`];
for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
args.push(`${ROOT}/dist-dev/OptChat Dev.app`);
const app = new Deno.Command("open", { args, stdout: "null", stderr: "null" }).spawn();
const read = (p: string) => { try { return JSON.parse(Deno.readTextFileSync(p)); } catch { return null; } };
const waitFor = async (f: () => unknown, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(150); } return false; };
try {
  const blob = (await (await fetch(`http://127.0.0.1:${PORT}/test/blobs`)).json()).sha as string;
  check(await waitFor(() => read(`${probes}.state.json`)?.ready && read(`${probes}.state.json`)?.loaded, 30_000), "app up on the fake engine (hidden, background)");
  const key = `img.${blob.slice(0, 12)}`;
  check(await waitFor(() => read(probes)?.[key], 10_000), `the reply's image is laid out (${key})`);
  await sleep(1500);
  const hits = (await (await fetch(`http://127.0.0.1:${PORT}/test/blobs`)).json()).hits;
  check(hits >= 1, `the app fetched the blob (${hits}×)`);
  const p = read(probes)?.[key];
  check(!!p && p[2] >= 300 && p[2] <= 340 && p[3] >= 190 && p[3] <= 210, `the image box fits the 320×200 png: ${JSON.stringify(p)}`);
  check(front() === front0, `the front app did not change (${front()})`);
} finally {
  const pr = await new Deno.Command("pgrep", { args: ["-f", `${ROOT}/dist-dev/OptChat Dev.app/Contents/MacOS/`] }).output();
  for (const pid of new TextDecoder().decode(pr.stdout).split("\n").filter(Boolean)) await new Deno.Command("kill", { args: [pid] }).output();
  await Promise.race([app.status, sleep(5000)]);
  try { eng.kill("SIGKILL"); } catch { /* gone */ }
  try { Deno.removeSync(dir, { recursive: true }); } catch { /* gone */ }
}
console.log(failures ? `${failures} FAILED` : "all ok");
Deno.exit(failures ? 1 : 0);
