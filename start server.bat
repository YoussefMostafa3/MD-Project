@echo off
setlocal
cd /d "%~dp0mdstore-backend"
if errorlevel 1 (
    echo ERROR: Could not switch to the backend folder next to this script.
    echo Expected folder: "%~dp0mdstore-backend"
    pause
    exit /b 1
)
if not exist "requirements.txt" (
    echo ERROR: requirements.txt was not found in "%CD%".
    pause
    exit /b 1
)
echo Backend working directory: "%CD%"
if not defined MDSTORE_SHIPPING_FEES_JSON set "MDSTORE_SHIPPING_FEES_JSON={"Alexandria":{"fee":"50"}}"
rem This local launcher serves the storefront at http://127.0.0.1:5500.
rem Set an exact local origin so browser preflights are deterministic.
set "MDSTORE_CORS_ORIGINS=http://127.0.0.1:5500"

where uv >nul 2>&1
if errorlevel 1 (
    echo uv was not found. Install uv, then run this file again.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating the backend Python environment...
    uv venv .venv
    if errorlevel 1 (
        echo Could not create the backend Python environment.
        pause
        exit /b 1
    )
)

set "BACKEND_PYTHON=.venv\Scripts\python.exe"
if not exist "%BACKEND_PYTHON%" (
    echo ERROR: Python was not created at "%CD%\%BACKEND_PYTHON%".
    echo Create the environment with: uv venv .venv
    pause
    exit /b 1
)
"%BACKEND_PYTHON%" -c "import fastapi, uvicorn, sqlalchemy, multipart" >nul 2>&1
if errorlevel 1 (
    echo Installing backend dependencies from requirements.txt...
    uv pip install --python "%BACKEND_PYTHON%" -r requirements.txt
    if errorlevel 1 (
        echo Dependency installation failed. Check the network and requirements.txt, then retry.
        pause
        exit /b 1
    )
)

if not defined MDSTORE_AUTH_SECRET (
    for /f "usebackq delims=" %%i in (`.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"`) do set "MDSTORE_AUTH_SECRET=%%i"
)
if not defined MDSTORE_AUTH_SECRET (
    echo ERROR: Could not capture a local authentication secret from Python.
    echo Backend folder: "%CD%"
    echo Python executable: "%CD%\%BACKEND_PYTHON%"
    echo Checking whether the interpreter can import the secrets module:
    "%BACKEND_PYTHON%" -c "import secrets; print('Python interpreter and secrets module are available.')"
    if errorlevel 1 (
        echo Python failed. Repair the environment with: uv venv .venv
        echo Then install dependencies with: uv pip install --python .venv\Scripts\python.exe -r requirements.txt
    ) else (
        echo Python works; inspect CMD command capture syntax and retry this script.
    )
    pause
    exit /b 1
)
echo Starting backend at http://127.0.0.1:8000
"%BACKEND_PYTHON%" -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
