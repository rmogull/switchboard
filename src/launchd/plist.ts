/**
 * launchd user-agent plist generation (spec §10/§11). The dispatcher is kept
 * alive by launchd: RunAtLoad + KeepAlive so it starts at login and restarts on
 * crash. Paths are absolute and the environment is explicit — launchd agents run
 * with a minimal PATH, so we inject one that can find claude/codex/tmux/signal-cli.
 */
export interface PlistOptions {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  runAtLoad?: boolean;
  keepAlive?: boolean;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function arrayBlock(items: string[]): string {
  return items.map((a) => `      <string>${xmlEscape(a)}</string>`).join("\n");
}

function dictBlock(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(
      ([k, v]) =>
        `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`,
    )
    .join("\n");
}

export function renderPlist(o: PlistOptions): string {
  const runAtLoad = o.runAtLoad ?? true;
  const keepAlive = o.keepAlive ?? true;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${arrayBlock(o.programArguments)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${dictBlock(o.env)}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(o.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <${runAtLoad ? "true" : "false"}/>
  <key>KeepAlive</key>
  <${keepAlive ? "true" : "false"}/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(o.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(o.stderrPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}
