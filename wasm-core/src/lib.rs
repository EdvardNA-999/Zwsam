//! Zeus WASM Core - High-performance VLESS protocol engine
//!
//! This module provides the core proxy logic compiled to WebAssembly
//! for use in Cloudflare Workers. It handles:
//! - VLESS protocol parsing and validation
//! - UUID extraction and validation
//! - DNS-over-HTTPS query encoding/decoding
//! - Byte manipulation utilities
//! - Traffic accounting

mod vless;
mod uuid;
mod dns;
mod bytes;

use wasm_bindgen::prelude::*;

/// Initialize panic hook for better error messages in WASM
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

// Re-export all public functions at the crate level

// === VLESS Protocol ===

/// Parse a VLESS header from raw bytes.
/// Returns a JSON string with: { version, uuid, command, port, addrType, addr, rawDataOffset }
/// Returns null/undefined if the header is invalid.
#[wasm_bindgen]
pub fn parse_vless_header(data: &[u8]) -> JsValue {
    match vless::parse_header(data) {
        Some(header) => serde_wasm_bindgen::to_value(&header).unwrap_or(JsValue::NULL),
        None => JsValue::NULL,
    }
}

/// Build a VLESS response header (2 bytes: version + status)
#[wasm_bindgen]
pub fn build_vless_response(version: u8, status: u8) -> Vec<u8> {
    vec![version, status]
}

// === UUID ===

/// Extract UUID from VLESS header bytes (positions 1-16)
/// Returns UUID string in standard format or empty string if invalid
#[wasm_bindgen]
pub fn extract_uuid(data: &[u8]) -> String {
    uuid::extract_from_vless(data)
}

/// Validate if a string is a valid UUID v4
#[wasm_bindgen]
pub fn validate_uuid(uuid_str: &str) -> bool {
    uuid::is_valid(uuid_str)
}

// === DNS ===

/// Encode a DNS query for the given domain and record type.
/// record_type: 1 = A, 28 = AAAA
/// Returns raw DNS query bytes.
#[wasm_bindgen]
pub fn encode_dns_query(domain: &str, record_type: u16) -> Vec<u8> {
    dns::encode_query(domain, record_type)
}

/// Parse a DNS response and extract IP addresses.
/// Returns a JSON array of IP strings: ["1.2.3.4", "::1"]
#[wasm_bindgen]
pub fn parse_dns_response(response: &[u8], record_type: u16) -> String {
    let ips = dns::parse_response(response, record_type);
    serde_json::to_string(&ips).unwrap_or_else(|_| "[]".to_string())
}

// === Byte Utilities ===

/// Concatenate multiple Uint8Arrays into one.
/// Takes a flat array of alternating offset/length pairs referencing a shared buffer.
#[wasm_bindgen]
pub fn concat_byte_arrays(arrays: &js_sys::Array) -> Vec<u8> {
    bytes::concat_from_js_array(arrays)
}

/// Convert ArrayBuffer/Uint8Array to hex string
#[wasm_bindgen]
pub fn bytes_to_hex(data: &[u8]) -> String {
    bytes::to_hex(data)
}

/// Convert hex string to bytes
#[wasm_bindgen]
pub fn hex_to_bytes(hex: &str) -> Vec<u8> {
    bytes::from_hex(hex)
}

// === Traffic Accounting ===

/// A lightweight traffic counter that can be used from WASM side.
/// Returns JSON: { username: bytes, ... }
#[wasm_bindgen]
pub struct TrafficCounter {
    counters: std::collections::HashMap<String, u64>,
}

#[wasm_bindgen]
impl TrafficCounter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TrafficCounter {
        TrafficCounter {
            counters: std::collections::HashMap::new(),
        }
    }

    /// Add bytes for a user. Returns the new total.
    pub fn add(&mut self, username: &str, bytes: u64) -> u64 {
        let entry = self.counters.entry(username.to_string()).or_insert(0);
        *entry += bytes;
        *entry
    }

    /// Get accumulated bytes for a user.
    pub fn get(&self, username: &str) -> u64 {
        self.counters.get(username).copied().unwrap_or(0)
    }

    /// Reset a user's counter and return the value that was reset.
    pub fn take(&mut self, username: &str) -> u64 {
        self.counters.remove(username).unwrap_or(0)
    }

    /// Get total bytes across all users.
    pub fn total(&self) -> u64 {
        self.counters.values().sum()
    }

    /// Export all counters as JSON string.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.counters).unwrap_or_else(|_| "{}".to_string())
    }
}

// === VLESS Config Generation ===

/// Generate a VLESS share link
#[wasm_bindgen]
pub fn generate_vless_link(
    uuid: &str,
    address: &str,
    port: u16,
    host: &str,
    path: &str,
    security: &str,
    fingerprint: &str,
    remark: &str,
) -> String {
    let security_param = if security == "tls" {
        format!("security=tls&sni={}&fp={}&alpn=http/1.1&allowInsecure=0", host, fingerprint)
    } else {
        "security=none".to_string()
    };

    format!(
        "vless://{}@{}:{}?encryption=none&{}&type=ws&host={}&path={}#{}",
        uuid,
        address,
        port,
        security_param,
        host,
        urlencoding::encode(path),
        urlencoding::encode(remark)
    )
}

/// Generate subscription userinfo header value
#[wasm_bindgen]
pub fn generate_sub_userinfo(used_gb: f64, limit_gb: f64, expiry_days: u32, created_at: &str) -> String {
    let download_bytes = (used_gb * 1073741824.0) as u64;
    let total_bytes = if limit_gb > 0.0 {
        (limit_gb * 1073741824.0) as u64
    } else {
        0
    };

    let expire_timestamp = if expiry_days > 0 && !created_at.is_empty() {
        // Parse ISO timestamp and add expiry days
        // Simplified: return 0 if parsing fails
        0u64
    } else {
        0
    };

    format!(
        "upload=0; download={}; total={}; expire={}",
        download_bytes, total_bytes, expire_timestamp
    )
}
