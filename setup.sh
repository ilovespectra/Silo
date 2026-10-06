#!/bin/bash

# solo: silo 2.0 Electron - Setup Script
# This script sets up the development environment

echo "🚀 solo: silo 2.0 Electron - Setup"
echo "=================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16+ from https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

if [ $? -eq 0 ]; then
    echo "✅ Dependencies installed successfully"
else
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Create necessary directories
echo ""
echo "📁 Creating project structure..."
mkdir -p src
mkdir -p public
mkdir -p dist
mkdir -p build

echo "✅ Project structure created"

echo ""
echo "=================================="
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Start development: npm run dev"
echo "2. Build for distribution: npm run dist"
echo "3. See README.md for more information"
