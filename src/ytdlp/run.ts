const stderrTail = 500;

/**
 * Runs yt-dlp and returns what it printed. Aborting the signal kills the process and rejects
 * straight away with the signal's reason, without waiting for any child process yt-dlp
 * started (such as ffmpeg) to close its output.
 */
export async function ytdlp(binary: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();

  const process = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", signal });
  const finished = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  finished.catch(() => undefined); // if the abort wins, nobody is left to hear about a late failure

  const [stdout, stderr, exitCode] = await Promise.race([finished, aborted]);

  if (exitCode !== 0) {
    throw new Error(`yt-dlp: exited with code ${exitCode}: ${stderr.trim().slice(-stderrTail)}`);
  }

  return stdout;
}
