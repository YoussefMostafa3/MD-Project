@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%mdstore-backend"
set "FRONTEND_DIR=%ROOT%MD Store"
set "PYTHON=%BACKEND_DIR%\.venv\Scripts\python.exe"

if /i "%~1"=="--backend" goto run_backend
if /i "%~1"=="--frontend" goto run_frontend

if not exist "%PYTHON%" (
    echo ERROR: Backend virtual-environment Python was not found:
    echo "%PYTHON%"
    echo Run "start server.bat" once to create and prepare the environment.
    pause
    exit /b 1
)
if not exist "%BACKEND_DIR%\main.py" (
    echo ERROR: Backend application was not found in "%BACKEND_DIR%".
    pause
    exit /b 1
)
if not exist "%FRONTEND_DIR%\MD.html" (
    echo ERROR: Store page was not found at "%FRONTEND_DIR%\MD.html".
    pause
    exit /b 1
)

rem Keep the same local settings as the existing backend launcher.
if not defined MDSTORE_SHIPPING_FEES_JSON set "MDSTORE_SHIPPING_FEES_JSON={"Alexandria":{"fee":"50"}}"
set "MDSTORE_CORS_ORIGINS=http://127.0.0.1:5500"
if not defined MDSTORE_AUTH_SECRET (
    pushd "%BACKEND_DIR%"
    for /f "delims=" %%i in ('.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"') do set "MDSTORE_AUTH_SECRET=%%i"
    popd
)
if not defined MDSTORE_AUTH_SECRET (
    echo ERROR: Could not create the local backend authentication secret.
    pause
    exit /b 1
)

rem Reuse the service only when its expected HTTP endpoint responds.
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8000/openapi.json'; if ($r.StatusCode -eq 200 -and $r.Content -match 'MD Store API') { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.ConnectAsync('127.0.0.1',8000).Wait(500) | Out-Null; $busy=$c.Connected; $c.Close(); if ($busy) { exit 2 } } catch {}; exit 0" >nul 2>&1
    if errorlevel 1 (
        echo ERROR: Port 8000 is in use by a service that did not identify itself as the MD Store API.
        echo Close that service or inspect it, then run this launcher again.
        pause
        exit /b 1
    )
    echo Starting backend in a separate window...
    start "MD Store Backend" /D "%ROOT%" cmd.exe /k ""%~f0" --backend"
) else (
    echo Backend is already running.
)

echo Waiting for backend HTTP readiness...
powershell -NoProfile -Command "$until=(Get-Date).AddSeconds(30); do { try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8000/openapi.json'; if ($r.StatusCode -eq 200 -and $r.Content -match 'MD Store API') { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $until); exit 1" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Backend did not become ready at http://127.0.0.1:8000/openapi.json.
    echo Check the MD Store Backend window for startup errors.
    pause
    exit /b 1
)

rem A valid page response means the storefront is already being served there.
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:5500/MD.html'; if ($r.StatusCode -eq 200 -and $r.Content -match '<html') { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.ConnectAsync('127.0.0.1',5500).Wait(500) | Out-Null; $busy=$c.Connected; $c.Close(); if ($busy) { exit 2 } } catch {}; exit 0" >nul 2>&1
    if errorlevel 1 (
        echo ERROR: Port 5500 is in use by a service that did not serve the expected MD.html page.
        echo Close that service or inspect it, then run this launcher again.
        pause
        exit /b 1
    )
    echo Starting storefront server in a separate window...
    start "MD Store Frontend" /D "%FRONTEND_DIR%" "%PYTHON%" -m http.server 5500 --bind 127.0.0.1
) else (
    echo Storefront server is already running.
)

echo Waiting for storefront HTTP readiness...
powershell -NoProfile -Command "$until=(Get-Date).AddSeconds(30); do { try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:5500/MD.html'; if ($r.StatusCode -eq 200 -and $r.Content -match '<html') { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $until); exit 1" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Storefront did not become ready at http://127.0.0.1:5500/MD.html.
    echo Check the MD Store Frontend window for startup errors.
    pause
    exit /b 1
)

start "" "http://127.0.0.1:5500/MD.html"
echo Store and backend are ready. Store: http://127.0.0.1:5500/MD.html
exit /b 0


:run_backend
if not defined MDSTORE_AUTH_SECRET (
    pushd "%BACKEND_DIR%"
    for /f "delims=" %%i in ('.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"') do set "MDSTORE_AUTH_SECRET=%%i"
    popd
)
set "MDSTORE_CORS_ORIGINS=http://127.0.0.1:5500"
if not defined MDSTORE_SHIPPING_FEES_JSON set "MDSTORE_SHIPPING_FEES_JSON={"Alexandria":{"fee":"50"}}"
cd /d "%BACKEND_DIR%"
"%PYTHON%" -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
exit /b

:run_frontend
cd /d "%FRONTEND_DIR%"
"%PYTHON%" -m http.server 5500 --bind 127.0.0.1
pause
exit /b







