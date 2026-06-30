#!/bin/bash
# ============================================
# Zeus WASM Build Script (Linux/macOS)
# ============================================

set -e

echo ""
echo "========================================"
echo " Zeus WASM Core - Build Pipeline"
echo "========================================"
echo ""

# Step 1: Check prerequisites
echo "[1/5] Checking prerequisites..."
command -v rustc >/dev/null 2>&1 || { echo "ERROR: Rust not installed. Visit https://rustup.rs/"; exit 1; }
command -v wasm-pack >/dev/null 2>&1 || { echo "ERROR: wasm-pack not installed. Run: cargo install wasm-pack"; exit 1; }
echo "   Rust:     OK"
echo "   wasm-pack: OK"
echo ""

# Step 2: Build WASM
echo "[2/5] Building WASM core (release mode)..."
cd wasm-core
wasm-pack build --target web --release --out-dir ../worker/wasm
cd ..
echo "   WASM build: OK"
echo ""

# Step 3: Optimize
echo "[3/5] Optimizing WASM size..."
if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz --output worker/wasm/zeus_wasm_core_bg.wasm worker/wasm/zeus_wasm_core_bg.wasm
    echo "   wasm-opt: OK"
else
    echo "   wasm-opt: not found (install via: cargo install binaryen)"
    echo "   Skipping optimization"
fi
echo ""

# Step 4: Install worker dependencies
echo "[4/5] Installing worker dependencies..."
cd worker
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "   node_modules exists, skipping"
fi
cd ..
echo ""

# Step 5: Summary
echo "[5/5] Build complete!"
echo ""
echo "========================================"
echo " Output files:"
echo "   worker/wasm/zeus_wasm_core.js"
echo "   worker/wasm/zeus_wasm_core_bg.wasm"
echo "   worker/src/index.js"
echo "========================================"
echo ""
echo "Next steps:"
echo "  1. Edit worker/wrangler.toml with your D1 database ID"
echo "  2. cd worker && npx wrangler secret put CF_API_TOKEN"
echo "  3. cd worker && npx wrangler secret put CF_ACCOUNT_ID"
echo "  4. cd worker && npx wrangler deploy"
echo ""
