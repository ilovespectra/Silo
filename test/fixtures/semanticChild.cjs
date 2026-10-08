// Model-free child used to exercise real process death and IPC supervision.
function terminateLikeNativeCrash(signal) {
  // Windows reports forced process termination as a nonzero exit code rather
  // than a POSIX signal. Keep the failure fatal while matching that contract.
  if (process.platform === "win32") {
    process.exit(1);
    return;
  }
  process.kill(process.pid, signal);
}

process.on("message", (request) => {
  if (request.type === "image" && request.filePath?.endsWith("trap.heic")) {
    process.stderr.write(
      "native decoder failed at /private/secret/photo.heic\n" +
        "x".repeat(2500) +
        "\n/private/secret/last.heic\n",
    );
    terminateLikeNativeCrash("SIGTRAP");
    return;
  }
  if (request.text === "disconnect") {
    process.disconnect();
    return;
  }
  if (request.text === "crash" || request.text?.endsWith("\ncrash")) {
    terminateLikeNativeCrash("SIGKILL");
    return;
  }
  if (request.text === "hold") return;
  if (request.text === "malformed") {
    process.send({ id: request.id, values: [1] });
    return;
  }
  process.send({
    id: request.id,
    values:
      request.type === "preload"
        ? []
        : Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
  });
});
process.on("disconnect", () => process.exit(0));
