import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('This installer is for macOS only.');

const label = 'com.duo-radar.checker';
const userDirectory = join(homedir(), '.duo-radar');
const agentDirectory = join(homedir(), 'Library', 'LaunchAgents');
const agentPath = join(agentDirectory, `${label}.plist`);
const checkerPath = join(dirname(fileURLToPath(import.meta.url)), 'home-checker.js');
const logPath = join(userDirectory, 'checker.log');
const target = `gui/${process.getuid()}`;
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const run = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });

if (process.argv.includes('--remove')) {
  run(['bootout', target, agentPath]);
  await rm(agentPath, { force: true });
  console.log('Duo Radar automatic checks stopped. The saved dashboard password remains in your user profile.');
  process.exit(0);
}

try { await access(join(userDirectory, 'admin-token')); }
catch { throw new Error('First run npm run home -- --once and enter your dashboard password.'); }

await mkdir(userDirectory, { recursive: true, mode: 0o700 });
await mkdir(agentDirectory, { recursive: true });
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(checkerPath)}</string></array>
  <key>WorkingDirectory</key><string>${xml(dirname(dirname(checkerPath)))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;
await writeFile(agentPath, plist, { mode: 0o644 });
run(['bootout', target, agentPath]);
const result = run(['bootstrap', target, agentPath]);
if (result.status !== 0) throw new Error(`Could not start the Mac background checker: ${result.stderr.trim()}`);
console.log('Duo Radar will start when you log in and restart if it stops.');
console.log(`Checks are recorded in ${logPath}`);
console.log('Keep your Mac awake and connected to the internet for continuous alerts.');
