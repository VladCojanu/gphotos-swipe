import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
const execute = promisify(execFile);
async function apple(code) {
  const { stdout } = await execute('osascript', ['-e', code], { timeout: 10000 });
  return stdout.trim();
}
const bundle = resolve('dist/live-ordering-probe.js');
await build({ entryPoints: ['scripts/probe-ordering.js'], outfile: bundle, bundle: true, format: 'esm', target: 'chrome120' });
const findTab = `tell application "Google Chrome"
repeat with w in windows
repeat with t in tabs of w
if URL of t starts with "chrome-extension://" and URL of t contains "/review.html" then return (id of w as text) & ":" & (id of t as text)
end repeat
end repeat
end tell`;
try {
  const tab = await apple(findTab);
  if (!/^\d+:\d+$/.test(tab)) throw new Error('Open the installed extension review tab first.');
  const [windowId, tabId] = tab.split(':');
  const js = code => `tell application "Google Chrome"\ntell tab id ${tabId} of window id ${windowId}\nreturn execute javascript ${JSON.stringify(code)}\nend tell\nend tell`;
  await apple(js(`(()=>{delete document.documentElement.dataset.swipeOrderingProbe;const script=document.createElement('script');script.type='module';script.src=new URL('live-ordering-probe.js?run=${Date.now()}',location.href).href;document.head.append(script);return 'Started';})()`));
  const deadline = Date.now() + 10 * 60 * 1000;
  let lastStage = '';
  while (Date.now() < deadline) {
    const value = await apple(js("document.documentElement.dataset.swipeOrderingProbe || '{}'"));
    const result = JSON.parse(value);
    if (result.stage && result.stage !== lastStage) { console.log(result.stage); lastStage = result.stage; }
    if (result.running === false) {
      await mkdir('artifacts', { recursive: true });
      const report = JSON.stringify(result, null, 2) + '\n';
      await writeFile('artifacts/live-ordering-report.json', report);
      await writeFile(`artifacts/live-ordering-${new Date().toISOString().replaceAll(':', '-')}.json`, report);
      console.log(JSON.stringify(result, null, 2));
      if (!result.pass) process.exitCode = 1;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (Date.now() >= deadline) throw new Error('Live probe timed out; it may still be finishing its read-only requests in Chrome.');
} finally { await unlink(bundle).catch(() => {}); }
