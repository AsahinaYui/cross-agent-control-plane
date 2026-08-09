import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWindowsProxySettings,
  windowsSystemProxyEnvironment,
} from "../proxy.mjs";

test("parses a shared enabled Windows proxy", () => {
  const output = `
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       127.0.0.1:10809
  `;
  assert.deepEqual(parseWindowsProxySettings(output), {
    HTTP_PROXY: "http://127.0.0.1:10809",
    HTTPS_PROXY: "http://127.0.0.1:10809",
  });
});

test("does not override an explicit runtime proxy", () => {
  let queried = false;
  const env = { HTTPS_PROXY: "http://explicit.example:8080" };
  assert.deepEqual(
    windowsSystemProxyEnvironment(env, {
      platform: "win32",
      query: () => {
        queried = true;
        return { status: 0, stdout: "" };
      },
    }),
    {},
  );
  assert.equal(queried, false);
});

test("reads the enabled Windows proxy when no proxy env exists", () => {
  const result = windowsSystemProxyEnvironment(
    {},
    {
      platform: "win32",
      query: () => ({
        status: 0,
        stdout:
          "ProxyEnable REG_DWORD 0x1\r\nProxyServer REG_SZ http=127.0.0.1:10809;https=127.0.0.1:10809",
      }),
    },
  );
  assert.deepEqual(result, {
    HTTP_PROXY: "http://127.0.0.1:10809",
    HTTPS_PROXY: "http://127.0.0.1:10809",
    NO_PROXY: "127.0.0.1,localhost,::1",
  });
});
