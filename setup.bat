@echo off
REM solo: silo 2.0 Electron - Setup Script for Windows

echo.
echo 🚀 solo: silo 2.0 Electron - Setup
echo ==================================

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js 16+ from https://nodejs.org/
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do (echo ✅ Node.js version: %%i)
for /f "tokens=*" %%i in ('npm --version') do (echo ✅ npm version: %%i)

REM Install dependencies
echo.
echo 📦 Installing dependencies...
call npm install

if %errorlevel% equ 0 (
    echo ✅ Dependencies installed successfully
) else (
    echo ❌ Failed to install dependencies
    exit /b 1
)

REM Create necessary directories
echo.
echo 📁 Creating project structure...
if not exist src mkdir src
if not exist public mkdir public
if not exist dist mkdir dist
if not exist build mkdir build

echo ✅ Project structure created

echo.
echo ==================================
echo ✅ Setup complete!
echo.
echo Next steps:
echo 1. Start development: npm run dev
echo 2. Build for distribution: npm run dist
echo 3. See README.md for more information
echo.
pause
