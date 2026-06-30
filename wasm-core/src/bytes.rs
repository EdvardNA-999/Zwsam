//! Byte manipulation utilities for WASM ↔ JS interop

use js_sys::Array;
use wasm_bindgen::JsValue;

/// Concatenate multiple Uint8Arrays from a JS Array into a single Vec<u8>.
/// Each element should be a Uint8Array or ArrayBuffer.
pub fn concat_from_js_array(arrays: &Array) -> Vec<u8> {
    let mut total_len = 0usize;
    let mut buffers: Vec<Vec<u8>> = Vec::with_capacity(arrays.length() as usize);

    for i in 0..arrays.length() {
        let val = arrays.get(i);
        let bytes = js_value_to_bytes(&val);
        total_len += bytes.len();
        buffers.push(bytes);
    }

    let mut result = Vec::with_capacity(total_len);
    for buf in buffers {
        result.extend_from_slice(&buf);
    }
    result
}

/// Convert a JsValue (Uint8Array/ArrayBuffer) to Vec<u8>
fn js_value_to_bytes(val: &JsValue) -> Vec<u8> {
    if let Some(arr) = val.dyn_ref::<js_sys::Uint8Array>() {
        arr.to_vec()
    } else if let Some(buf) = val.dyn_ref::<js_sys::ArrayBuffer>() {
        js_sys::Uint8Array::new(buf).to_vec()
    } else {
        Vec::new()
    }
}

/// Convert bytes to hex string
pub fn to_hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Convert hex string to bytes
pub fn from_hex(hex: &str) -> Vec<u8> {
    let clean: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.len() % 2 != 0 {
        return Vec::new();
    }
    (0..clean.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&clean[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_hex() {
        assert_eq!(to_hex(&[0x01, 0x02, 0xFF]), "0102ff");
        assert_eq!(to_hex(&[]), "");
    }

    #[test]
    fn test_from_hex() {
        assert_eq!(from_hex("0102ff"), vec![0x01, 0x02, 0xFF]);
        assert_eq!(from_hex(""), Vec::<u8>::new());
        assert_eq!(from_hex("01 02 ff"), vec![0x01, 0x02, 0xFF]); // handles whitespace
    }

    #[test]
    fn test_from_hex_invalid() {
        assert!(from_hex("0").is_empty()); // odd length
    }
}
