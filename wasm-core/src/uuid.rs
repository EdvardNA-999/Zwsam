//! UUID extraction and validation for VLESS protocol

/// Extract UUID from VLESS header bytes (positions 1-16)
/// Returns UUID string in standard format (8-4-4-4-12)
pub fn extract_from_vless(data: &[u8]) -> String {
    if data.len() < 17 {
        return String::new();
    }
    let hex: String = data[1..17]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Validate if a string is a valid UUID v4 format
pub fn is_valid(uuid_str: &str) -> bool {
    let clean: String = uuid_str.chars().filter(|c| *c != '-').collect();
    if clean.len() != 32 {
        return false;
    }
    clean.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_uuid() {
        let mut data = vec![0u8; 17];
        // UUID: 01020304-0506-0708-090a-0b0c0d0e0f10
        for i in 1..=16 {
            data[i] = i as u8;
        }
        let uuid = extract_from_vless(&data);
        assert_eq!(uuid, "01020304-0506-0708-090a-0b0c0d0e0f10");
    }

    #[test]
    fn test_extract_too_short() {
        assert!(extract_from_vless(&[0u8; 10]).is_empty());
    }

    #[test]
    fn test_validate_valid() {
        assert!(is_valid("01020304-0506-0708-090a-0b0c0d0e0f10"));
        assert!(is_valid("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn test_validate_invalid() {
        assert!(!is_valid("not-a-uuid"));
        assert!(!is_valid("01020304-0506-0708-090a"));
        assert!(!is_valid(""));
    }
}
