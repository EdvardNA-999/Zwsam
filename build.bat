@echo off
REM ============================================
REM Zeus WASM Build Script (Windows)
REM ============================================

echo.
echo ========================================
echo  Zeus WASM Core - Build Pipeline
echo ========================================
echo.

REM Step 1: Check prerequisites
echo [1/5] Checking prerequisites...

where rustc >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Rust is not installed.
    echo Install from: https://rustup.rs/
    exit /b 1
)

where wasm-pack >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: wasm-pack is not installed.
    echo Install with: cargo install wasm-pack
    exit /b 1
)

echo    Rust:    OK
echo    wasm-pack: OK
echo.

REM Step 2: Build WASM
echo [2/5] Building WASM core (release mode)...
cd wasm-core
wasm-pack build --target web --release --out-dir ../worker/wasm
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: WASM build failed!
    exit /b 1
)
cd ..
echo    WASM build: OK
echo.

REM Step 3: Optimize WASM size
echo [3/5] Optimizing WASM size...
where wasm-opt >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    wasm-opt -Oz --output worker/wasm/zeus_wasm_core_bg.wasm worker/wasm/zeus_wasm_core_bg.wasm
    echo    wasm-opt: OK
) else (
    echo    wasm-opt: not found (install via: cargo install binaryen)
    echo    Skipping optimization - WASM will work but be larger
)
echo.

REM Step 4: Install worker dependencies
echo [4/5] Installing worker dependencies...
cd worker
if not exist node_modules (
    call npm install
) else (
    echo    node_modules exists, skipping
)
cd ..
echo.

REM Step 5: Summary
echo [5/5] Build complete!
echo.
echo ========================================
echo  Output files:
echo    worker/wasm/zeus_wasm_core.js
echo    worker/wasm/zeus_wasm_core_bg.wasm
echo    worker/src/index.js
echo ========================================
echo.
echo Next steps:
echo   1. Edit worker/wrangler.toml with your D1 database ID
echo   2. Run: cd worker ^&^& npx wrangler secret put CF_API_TOKEN
echo   3. Run: cd worker ^&^& npx wrangler secret put CF_ACCOUNT_ID
echo   4. Run: cd worker ^&^& npx wrangler deploy
echo.
