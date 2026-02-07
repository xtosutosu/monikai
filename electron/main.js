const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Use ANGLE D3D11 backend - more stable on Windows while keeping WebGL working
// This fixes "GPU state invalid after WaitForGetOffsetInRange" error
app.commandLine.appendSwitch('use-angle', 'd3d11');
app.commandLine.appendSwitch('enable-features', 'Vulkan');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow;
let pythonProcess;

// Global error handler
process.on('uncaughtException', (error) => {
    dialog.showErrorBox('An Uncaught Exception was encountered', error.message);
    app.quit();
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        icon: path.join(__dirname, '../public/icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // For simple IPC/Socket.IO usage
        },
        backgroundColor: '#000000',
        frame: false, // Frameless for custom UI
        titleBarStyle: 'hidden',
        show: false, // Don't show until ready
    });

    // In dev, load Vite server. In prod, load index.html
    const isDev = process.env.NODE_ENV !== 'production';

    const loadFrontend = (retries = 3) => {
        const url = isDev ? 'http://localhost:5173' : null;
        const loadPromise = isDev
            ? mainWindow.loadURL(url)
            : mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

        loadPromise
            .then(() => {
                console.log('I have loaded the frontend loaded successfully!');
                windowWasShown = true;
                mainWindow.show();
                if (isDev && process.env.SHOW_DEVTOOLS === 'true') {
                    mainWindow.webContents.openDevTools();
                }
            })
            .catch((err) => {
                console.error(`Failed to load frontend: ${err.message}`);
                if (retries > 0) {
                    console.log(`Retrying in 1 second... (${retries} retries left)`);
                    setTimeout(() => loadFrontend(retries - 1), 1000);
                } else {
                    console.error('Failed to load frontend after all retries. Keeping window open.');
                    dialog.showErrorBox('Frontend Error', `Failed to load the frontend after multiple retries. Please check the logs.\n${err.message}`);
                    windowWasShown = true;
                    mainWindow.show(); // Show anyway so user sees something
                }
            });
    };

    loadFrontend();

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function resolvePythonCandidates() {
    const candidates = [];
    const envPython = process.env.MONIKAI_PYTHON;
    if (envPython) candidates.push(envPython);

    const condaPrefix = process.env.CONDA_PREFIX;
    if (condaPrefix) {
        const condaPy = process.platform === 'win32'
            ? path.join(condaPrefix, 'python.exe')
            : path.join(condaPrefix, 'bin', 'python');
        candidates.push(condaPy);
    }

    const home = process.env.USERPROFILE || process.env.HOME;
    const baseNames = ['miniconda3', 'anaconda3', 'Miniconda3', 'Anaconda3'];
    if (home) {
        baseNames.forEach(base => {
            const envPath = process.platform === 'win32'
                ? path.join(home, base, 'envs', 'monikai', 'python.exe')
                : path.join(home, base, 'envs', 'monikai', 'bin', 'python');
            candidates.push(envPath);
        });
    }

    candidates.push('python');
    candidates.push('python3');
    return candidates;
}

function startPythonBackend() {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, '../backend/server.py');
        console.log(`Starting Python backend: ${scriptPath}`);

        const candidates = resolvePythonCandidates();

        const trySpawn = (index = 0) => {
            if (index >= candidates.length) {
                reject(new Error('Could not find a working Python interpreter.'));
                return;
            }

            const command = candidates[index];
            const isPath = command.includes('\\') || command.includes('/') || command.endsWith('.exe');
            if (isPath && !fs.existsSync(command)) {
                return trySpawn(index + 1);
            }

            console.log(`Starting Python backend with: ${command}`);
            const backendProcess = spawn(command, ['-u', scriptPath], {
                cwd: path.join(__dirname, '../backend'),
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            });

            let backendStarted = false;

            backendProcess.stdout.on('data', (data) => {
                console.log(`[Python]: ${data}`);
                // Resolve the promise once the backend starts sending data
                if (!backendStarted) {
                    backendStarted = true;
                    resolve(backendProcess);
                }
            });

            backendProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                console.error(`[Python Error]: ${msg}`);
                // Uvicorn logs to stderr. Resolve if we see the startup message.
                if (!backendStarted && (msg.includes('Uvicorn running') || msg.includes('Application startup complete'))) {
                    backendStarted = true;
                    resolve(backendProcess);
                }
            });

            backendProcess.on('error', (err) => {
                console.error(`Failed to start ${command}.`, err);
                trySpawn(index + 1);
            });

            backendProcess.on('close', (code) => {
                if (!backendStarted) {
                    reject(new Error(`Python backend exited prematurely with code ${code}. Check logs for missing dependencies or errors.`));
                }
            });
        };

        trySpawn(0);
    });
}

app.whenReady().then(() => {
    ipcMain.on('window-minimize', () => {
        if (mainWindow) mainWindow.minimize();
    });

    ipcMain.on('window-maximize', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    });

    ipcMain.on('window-close', () => {
        if (mainWindow) mainWindow.close();
    });

    checkBackendPort(8000).then((isTaken) => {
        if (isTaken) {
            console.log('Port 8000 is taken. Assuming backend is already running manually.');
            waitForBackend().then(createWindow);
        } else {
            startPythonBackend()
                .then(process => {
                    pythonProcess = process;
                    return waitForBackend();
                })
                .then(createWindow)
                .catch(err => {
                    dialog.showErrorBox('Backend Error', `Failed to start the backend.\n${err.message}`);
                    app.quit();
                });
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

function checkBackendPort(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(false);
        });
        server.listen(port);
    });
}

function waitForBackend() {
    return new Promise((resolve) => {
        const check = () => {
            const http = require('http');
            http.get('http://127.0.0.1:8000/status', (res) => {
                if (res.statusCode === 200) {
                    console.log('Backend is ready!');
                    resolve();
                } else {
                    console.log('Backend not ready, retrying...');
                    setTimeout(check, 1000);
                }
            }).on('error', (err) => {
                console.log('Waiting for backend...');
                setTimeout(check, 1000);
            });
        };
        check();
    });
}

let windowWasShown = false;

app.on('window-all-closed', () => {
    // Only quit if the window was actually shown at least once
    // This prevents quitting during startup if window creation fails
    if (process.platform !== 'darwin' && windowWasShown) {
        app.quit();
    } else if (!windowWasShown) {
        console.log('Window was never shown - keeping app alive to allow retries');
    }
});

app.on('will-quit', () => {
    console.log('App closing... Killing Python backend.');
    if (pythonProcess) {
        if (process.platform === 'win32') {
            // Windows: Force kill the process tree synchronously
            try {
                const { execSync } = require('child_process');
                execSync(`taskkill /pid ${pythonProcess.pid} /f /t`);
            } catch (e) {
                console.error('Failed to kill python process:', e.message);
            }
        } else {
            // Unix: SIGKILL
            pythonProcess.kill('SIGKILL');
        }
        pythonProcess = null;
    }
});
