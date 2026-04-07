export const toWebSocketUrl = (
  baseUrl: string,
  path: string = "/v1/ws"
): string => {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};
