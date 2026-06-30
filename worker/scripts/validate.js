// ============================================================
// Pre-deploy validation script
// ============================================================
// Run before `wrangler deploy` to catch issues early
// Usage: node scripts/validate.js
// ============================================================

const fs = require("fs");
const path = require("path");

let errors = 0;
let warnings = 0;

function error(msg) {
  console.error(`  ✗ ERROR: ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`  ⚠ WARN: ${msg}`);
  warnings++;
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

console.log("\n╔══════════════════════════════════════╗");
console.log("║   Zeus WASM — Pre-Deploy Validation  ║");
console.log("╚══════════════════════════════════════╝\n");

// ── 1. Check WASM artifacts ──────────────────────────────────
console.log("1. WASM Artifacts");

const wasmDir = path.resolve(__dirname, "../wasm");
const requiredFiles = [
  "zeus_wasm_core.js",
  "zeus_wasm_core_bg.wasm",
];

for (const file of requiredFiles) {
  const filePath = path.join(wasmDir, file);
  if (!fs.existsSync(filePath)) {
    error(`Missing: wasm/${file}`);
  } else {
    const stat = fs.statSync(filePath);
    const sizeKB = (stat.size / 1024).toFixed(1);
    ok(`wasm/${file} (${sizeKB} KB)`);

    // Validate WASM magic bytes
    if (file.endsWith(".wasm")) {
      const buf = fs.readFileSync(filePath);
      if (buf.length < 4) {
        error(`WASM file is too small (${buf.length} bytes)`);
      } else {
        const magic = buf.toString("hex", 0, 4);
        if (magic !== "0061736d") {
          error(`Invalid WASM magic bytes: ${magic} (expected 0061736d)`);
        } else {
          ok("WASM magic bytes valid");
        }
      }

      // Size check
      if (stat.size < 1000) {
        error(`WASM binary suspiciously small (${stat.size} bytes)`);
      } else if (stat.size > 1_048_576) {
        warn(`WASM binary is ${(stat.size / 1_048_576).toFixed(1)}MB — consider optimizing`);
      }
    }
  }
}

// ── 2. Check Worker source ───────────────────────────────────
console.log("\n2. Worker Source");

const indexJs = path.resolve(__dirname, "../src/index.js");
if (!fs.existsSync(indexJs)) {
  error("Missing: src/index.js");
} else {
  const content = fs.readFileSync(indexJs, "utf-8");

  // Check WASM import exists
  if (content.includes("zeus_wasm_core")) {
    ok("WASM import found in index.js");
  } else {
    warn("No WASM import found — worker may not use WASM");
  }

  // Check for hardcoded secrets
  const secretPatterns = [
    { pattern: /api[_-]?token\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/gi, name: "API token" },
    { pattern: /password\s*[:=]\s*["'][^\s]{8,}/gi, name: "Password" },
  ];
  for (const { pattern, name } of secretPatterns) {
    if (pattern.test(content)) {
      warn(`Possible hardcoded ${name} found in src/index.js`);
    }
  }

  // Check fetch handler exists
  if (content.includes("export default")) {
    ok("Export default handler found");
  } else {
    error("No `export default` found — Worker needs a fetch handler");
  }

  // Check D1 binding reference
  if (content.includes("env.DB")) {
    ok("D1 binding (env.DB) referenced");
  } else {
    warn("No D1 binding reference found");
  }
}

// ── 3. Check wrangler.toml ───────────────────────────────────
console.log("\n3. Wrangler Configuration");

const wranglerPath = path.resolve(__dirname, "../wrangler.toml");
if (!fs.existsSync(wranglerPath)) {
  error("Missing: wrangler.toml");
} else {
  const config = fs.readFileSync(wranglerPath, "utf-8");

  if (config.includes("main =")) {
    ok("Entry point defined");
  } else {
    error("No `main` entry point in wrangler.toml");
  }

  if (config.includes("d1_databases")) {
    ok("D1 database binding found");
  } else {
    error("No D1 database binding");
  }

  if (config.includes("CompiledWasm")) {
    ok("WASM rule defined");
  } else {
    warn("No CompiledWasm rule — WASM may not load correctly");
  }

  if (config.includes("YOUR_D1_DATABASE_ID")) {
    warn("Placeholder database ID detected — replace before deploying");
  }

  if (config.includes("compatibility_date")) {
    ok("Compatibility date set");
  } else {
    warn("No compatibility_date — Wrangler will use latest");
  }
}

// ── 4. Check for lock file ───────────────────────────────────
console.log("\n4. Lock Files");

const cargoLock = path.resolve(__dirname, "../../wasm-core/Cargo.lock");
if (fs.existsSync(cargoLock)) {
  ok("Cargo.lock present");
} else {
  warn("No Cargo.lock — builds may not be reproducible");
}

const packageLock = path.resolve(__dirname, "../package-lock.json");
if (fs.existsSync(packageLock)) {
  ok("package-lock.json present");
} else {
  warn("No package-lock.json — run `npm install` to generate");
}

// ── Summary ──────────────────────────────────────────────────
console.log("\n" + "─".repeat(40));
if (errors > 0) {
  console.error(`\n✗ FAILED: ${errors} error(s), ${warnings} warning(s)\n`);
  process.exit(1);
} else if (warnings > 0) {
  console.warn(`\n⚠ PASSED with ${warnings} warning(s)\n`);
} else {
  console.log("\n✓ All checks passed\n");
}
