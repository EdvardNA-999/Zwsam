//! VLESS Protocol Parser
//!
//! Handles parsing of VLESS protocol headers from raw bytes.
//!
//! VLESS Header Layout:
//! [0]      = version (usually 0)
//! [1-16]   = UUID (16 bytes, raw)
//! [17]     = option length (N)
//! [18..18+N-1] = options (skipped)
//! [18+N]   = command (1=TCP, 2=UDP)
//! [18+N+1..18+N+2] = port (big-endian uint16)
//! [18+N+3] = address type (1=IPv4, 2=domain, 3=IPv6)
//! [variable] = address (depends on type)
//! [remaining] = initial payload data

use serde::Serialize;

/// Minimum VLESS header size: version(1) + uuid(16) + optlen(1) + cmd(1) + port(2) + atype(1) = 22
const MIN_HEADER_SIZE: usize = 24;

#[derive(Serialize, Debug, Clone)]
pub struct VlessHeader {
    pub version: u8,
    pub uuid: String,
    pub command: u8,
    pub port: u16,
    pub addr_type: u8,
    pub addr: String,
    pub raw_data_offset: usize,
    pub option_length: u8,
}

/// Parse a VLESS header from raw bytes.
/// Returns Some(VlessHeader) if valid, None if invalid.
pub fn parse_header(data: &[u8]) -> Option<VlessHeader> {
    if data.len() < MIN_HEADER_SIZE {
        return None;
    }

    let version = data[0];

    // Extract UUID from bytes 1-16
    let uuid = super::uuid::extract_from_vless(data);
    if uuid.is_empty() {
        return None;
    }

    // Parse option length at offset 17
    let opt_len = data[17] as usize;

    // Ensure we have enough data beyond options
    let after_opts = 18 + opt_len;
    if data.len() < after_opts + 4 {
        return None;
    }

    // Command (TCP=1, UDP=2)
    let command = data[after_opts];

    // Port (big-endian uint16)
    let port = ((data[after_opts + 1] as u16) << 8) | (data[after_opts + 2] as u16);

    // Address type
    let addr_type = data[after_opts + 3];

    let (addr, addr_end) = match addr_type {
        // IPv4: 4 bytes
        1 => {
            let start = after_opts + 4;
            if data.len() < start + 4 {
                return None;
            }
            let ip = format!(
                "{}.{}.{}.{}",
                data[start],
                data[start + 1],
                data[start + 2],
                data[start + 3]
            );
            (ip, start + 4)
        }
        // Domain: length-prefixed string
        2 => {
            let start = after_opts + 4;
            if data.len() < start + 1 {
                return None;
            }
            let domain_len = data[start] as usize;
            if data.len() < start + 1 + domain_len {
                return None;
            }
            let domain = String::from_utf8_lossy(&data[start + 1..start + 1 + domain_len]).to_string();
            (domain, start + 1 + domain_len)
        }
        // IPv6: 16 bytes (we return as hex representation)
        3 => {
            let start = after_opts + 4;
            if data.len() < start + 16 {
                return None;
            }
            let ipv6 = format!(
                "{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}",
                data[start], data[start+1],
                data[start+2], data[start+3],
                data[start+4], data[start+5],
                data[start+6], data[start+7],
                data[start+8], data[start+9],
                data[start+10], data[start+11],
                data[start+12], data[start+13],
                data[start+14], data[start+15]
            );
            (ipv6, start + 16)
        }
        _ => return None,
    };

    Some(VlessHeader {
        version,
        uuid,
        command,
        port,
        addr_type,
        addr,
        raw_data_offset: addr_end,
        option_length: opt_len as u8,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_vless_tcp_ipv4() {
        let mut data = vec![0u8; 30];
        // Version
        data[0] = 0;
        // UUID bytes 1-16 (all zeros for test)
        for i in 1..=16 {
            data[i] = i as u8;
        }
        // Option length
        data[17] = 0;
        // Command: TCP
        data[18] = 1;
        // Port 443 (big-endian)
        data[19] = 0x01;
        data[20] = 0xBB;
        // Address type: IPv4
        data[21] = 1;
        // IP: 1.2.3.4
        data[22] = 1;
        data[23] = 2;
        data[24] = 3;
        data[25] = 4;
        // Some payload
        data[26] = 0xDE;
        data[27] = 0xAD;

        let header = parse_header(&data).expect("should parse");
        assert_eq!(header.version, 0);
        assert_eq!(header.command, 1); // TCP
        assert_eq!(header.port, 443);
        assert_eq!(header.addr_type, 1);
        assert_eq!(header.addr, "1.2.3.4");
        assert_eq!(header.raw_data_offset, 26);
    }

    #[test]
    fn test_parse_vless_tcp_domain() {
        let domain = b"example.com";
        let mut data = vec![0u8; 35 + domain.len()];
        data[0] = 0;
        for i in 1..=16 {
            data[i] = i as u8;
        }
        data[17] = 0; // no options
        data[18] = 1; // TCP
        data[19] = 0x01; // port high byte
        data[20] = 0xBB; // port low byte = 443
        data[21] = 2; // domain type
        data[22] = domain.len() as u8;
        data[23..23 + domain.len()].copy_from_slice(domain);

        let header = parse_header(&data).expect("should parse");
        assert_eq!(header.addr, "example.com");
        assert_eq!(header.raw_data_offset, 23 + domain.len());
    }

    #[test]
    fn test_parse_too_short() {
        assert!(parse_header(&[0u8; 10]).is_none());
    }
}
