#!/usr/bin/env node
// Minimal stand-in for the opencode CLI, for smoke tests only.
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('0.0.0-fake'); process.exit(0); }
if (a[0] === 'models') { console.log('opencode/fake-lite\nopencode-go/fake-go\nanthropic/fake'); process.exit(0); }
if (a[0] === 'run') {
  fs.writeFileSync('hello.txt', 'written by fake opencode\n');
  console.log('FAKE RUN args=' + JSON.stringify(a.slice(2)));
  console.log('PROMPT_START ' + a[1].split('\n')[0]);
  process.exit(0);
}
process.exit(2);
