import subprocess
import sys
import os
import time

# Get the directory where the exe is located
exe_dir = os.path.dirname(sys.executable)

# Start backend in background
backend_process = subprocess.Popen(
    [sys.executable, 'server.py'],
    cwd=os.path.join(exe_dir, 'backend'),
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
)

# Wait a moment for backend to start
time.sleep(3)

# Start frontend (Electron)
frontend_process = subprocess.Popen(
    ['npm', 'run', 'start'],
    cwd=exe_dir,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
)

# Keep the launcher running until user closes it
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    backend_process.terminate()
    frontend_process.terminate()
    backend_process.wait()
    frontend_process.wait()