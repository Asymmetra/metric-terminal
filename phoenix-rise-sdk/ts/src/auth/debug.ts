const readDebugFlag = (): boolean => {
  if (typeof window === "undefined") {
    return process.env.PHOENIX_DEBUG_AUTH === "1";
  }
  const globalFlag = (
    window as typeof window & {
      __PHOENIX_DEBUG_AUTH__?: boolean;
    }
  ).__PHOENIX_DEBUG_AUTH__;
  if (globalFlag) return true;
  try {
    const legacy = window.localStorage?.getItem("phoenix-debug-auth") === "1";
    if (legacy) return true;
    return window.localStorage?.getItem("phoenix.debug.auth") === "1";
  } catch {
    return false;
  }
};

export const isAuthDebugEnabled = (): boolean => readDebugFlag();

export const debugAuth = (
  message: string,
  details?: Record<string, unknown>
): void => {
  if (!readDebugFlag()) return;
  if (details) {
    console.debug(`[phoenix-auth] ${message}`, details);
    return;
  }
  console.debug(`[phoenix-auth] ${message}`);
};
