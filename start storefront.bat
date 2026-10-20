@echo off
setlocal
set "STOREFRONT_DIR=%~dp0MD Store"
set "BACKEND_PYTHON=%~dp0mdstore-backend\.venv\Scripts\python.exe"

if not exist "%STOREFRONT_DIR%\MD.html" (
    echo ERROR: MD.html was not found in "%STOREFRONT_DIR%".
    pause
    exit /b 1
)
if not exist "%BACKEND_PYTHON%" (
    echo ERROR: Backend Python was not found at "%BACKEND_PYTHON%".
    echo Start the backend once with "start server.bat" to create its environment.
    pause
    exit /b 1
)

cd /d "%STOREFRONT_DIR%"
if errorlevel 1 (
    echo ERROR: Could not switch to "%STOREFRONT_DIR%".
    pause
    exit /b 1
)

echo Storefront: http://127.0.0.1:5500/MD.html
echo Keep this window open while using the storefront.
"%BACKEND_PYTHON%" -m http.server 5500 --bind 127.0.0.1
pause
