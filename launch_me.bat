@echo off
cd /d "%~dp0"
call conda activate monikai
if %errorlevel% neq 0 (
    echo [WARNING] Could not activate 'monikai' environment. Using system Python...
)
npm run dev
pause
