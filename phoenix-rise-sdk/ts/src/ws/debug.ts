const readWsDebugFlag = (): boolean => {
  if (typeof window === "undefined") {
    return process.env.PHOENIX_DEBUG_WS === "1";
  }

  const globalFlag = (
    window as typeof window & {
      __PHOENIX_DEBUG_WS__?: boolean;
    }
  ).__PHOENIX_DEBUG_WS__;
  if (globalFlag) return true;

  try {
    const localStorage = window.localStorage;
    if (!localStorage) return false;

    const flags = [
      localStorage.getItem("phoenix.ws.debug"),
      localStorage.getItem("phoenix.debug.ws"),
      localStorage.getItem("phoenix-debug-ws"),
    ];

    return flags.some((value) => value === "1");
  } catch {
    return false;
  }
};

export const isWsDebugEnabled = (): boolean => readWsDebugFlag();

export const debugWs = (
  message: string,
  details?: Record<string, unknown>
): void => {
  if (!readWsDebugFlag()) return;
  if (details) {
    console.debug(`[phoenix-rise-ws] ${message}`, details);
    return;
  }
  console.debug(`[phoenix-rise-ws] ${message}`);
};
