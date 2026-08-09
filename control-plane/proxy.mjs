import { spawnSync } from "node:child_process";

const WINDOWS_INTERNET_SETTINGS =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

const hasProxyEnvironment = (env) =>
  [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ].some((key) => typeof env[key] === "string" && env[key].trim().length > 0);

const proxyUrl = (value, scheme = "http") => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${scheme}://${trimmed}`;
};

export function parseWindowsProxySettings(output) {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) return {};
  const raw = output.match(/ProxyServer\s+REG_\w+\s+([^\r\n]+)/i)?.[1]?.trim();
  if (!raw) return {};

  const routes = Object.fromEntries(
    raw
      .split(";")
      .map((entry) =>
        entry
          .split(/=(.*)/s)
          .slice(0, 2)
          .map((part) => part.trim()),
      )
      .filter(([name, value]) => name && value),
  );
  const shared = raw.includes("=") ? null : proxyUrl(raw);
  const http = proxyUrl(routes.http) ?? proxyUrl(routes.https) ?? shared;
  const https = proxyUrl(routes.https) ?? proxyUrl(routes.http) ?? shared;
  const all = proxyUrl(routes.socks, "socks5");
  return {
    ...(http ? { HTTP_PROXY: http } : {}),
    ...(https ? { HTTPS_PROXY: https } : {}),
    ...(all ? { ALL_PROXY: all } : {}),
  };
}

export function windowsSystemProxyEnvironment(
  env = process.env,
  { platform = process.platform, query = spawnSync } = {},
) {
  if (platform !== "win32" || hasProxyEnvironment(env)) return {};
  const result = query("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return {};
  const proxy = parseWindowsProxySettings(result.stdout);
  if (Object.keys(proxy).length === 0) return {};
  return {
    ...proxy,
    NO_PROXY: env.NO_PROXY ?? env.no_proxy ?? "127.0.0.1,localhost,::1",
  };
}
