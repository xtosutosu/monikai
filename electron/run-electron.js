const { spawn } = require('child_process');
const path = require('path');

// Launch Electron explicitly and remove ELECTRON_RUN_AS_NODE if set in user env.
const electronBinary = require('electron');
const env = { ...process.env };
if ('ELECTRON_RUN_AS_NODE' in env) {
  delete env.ELECTRON_RUN_AS_NODE;
}

const args = ['.'];
const child = spawn(electronBinary, args, {
  stdio: 'inherit',
  windowsHide: false,
  env,
  cwd: path.join(__dirname, '..'),
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
