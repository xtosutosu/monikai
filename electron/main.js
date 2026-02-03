const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
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

function startPythonBackend() {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, '../backend/server.py');
        console.log(`Starting Python backend: ${scriptPath}`);

        const trySpawn = (command) => {
            const process = spawn(command, ['-u', scriptPath], {
                cwd: path.join(__dirname, '../backend'),
            });

            let backendStarted = false;

            process.stdout.on('data', (data) => {
                console.log(`[Python]: ${data}`);
                // Resolve the promise once the backend starts sending data
                if (!backendStarted) {
                    backendStarted = true;
                    resolve(process);
                }
            });

            process.stderr.on('data', (data) => {
                const msg = data.toString();
                console.error(`[Python Error]: ${msg}`);
                // Uvicorn logs to stderr. Resolve if we see the startup message.
                if (!backendStarted && (msg.includes('Uvicorn running') || msg.includes('Application startup complete'))) {
                    backendStarted = true;
                    resolve(process);
                }
            });

            process.on('error', (err) => {
                console.error(`Failed to start ${command}.`, err);
                if (command === 'python') {
                    console.log('Trying with python3...');
                    trySpawn('python3');
                } else {
                    reject(new Error('Could not find python or python3. Please make sure Python is installed and in your PATH.'));
                }
            });

            process.on('close', (code) => {
                if (!backendStarted) {
                    reject(new Error(`Python backend exited prematurely with code ${code}. Check logs for missing dependencies or errors.`));
                }
            });
        };

        trySpawn('python');
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
