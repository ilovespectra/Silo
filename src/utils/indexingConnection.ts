export function describeIndexingConnectionError(cause: unknown) {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const message = raw.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
  if (
    /No handler registered|not a function|unavailable.*bridge|progress API unavailable/i.test(
      message,
    )
  )
    return {
      message,
      action:
        "Quit Silo completely and reopen it. The running Electron backend or preload does not support the progress API; refreshing the window is not enough.",
    };
  if (/destroyed|closed|disconnected|IPC|channel/i.test(message))
    return {
      message,
      action:
        "The desktop connection was interrupted. Reopen Silo if it does not recover automatically.",
    };
  return {
    message,
    action:
      "The backend could not return indexing progress. If retries continue failing, restart Silo and check its runtime diagnostics. Indexing may still be running.",
  };
}
