//! DNS-over-HTTPS query encoding and response parsing

/// Encode a DNS query for the given domain and record type.
/// record_type: 1 = A, 28 = AAAA
pub fn encode_query(domain: &str, record_type: u16) -> Vec<u8> {
    let mut query = Vec::new();

    // Transaction ID (random)
    let tx_id: u16 = 0x1234; // Static for WASM; JS side can override
    query.extend_from_slice(&tx_id.to_be_bytes());

    // Flags: standard query, recursion desired
    query.extend_from_slice(&0x0100u16.to_be_bytes());

    // QDCOUNT = 1
    query.extend_from_slice(&1u16.to_be_bytes());

    // ANCOUNT, NSCOUNT, ARCOUNT = 0
    query.extend_from_slice(&0u16.to_be_bytes());
    query.extend_from_slice(&0u16.to_be_bytes());
    query.extend_from_slice(&0u16.to_be_bytes());

    // QNAME
    for label in domain.split('.') {
        let label = label.trim_end_matches('.');
        if label.is_empty() {
            continue;
        }
        query.push(label.len() as u8);
        query.extend_from_slice(label.as_bytes());
    }
    query.push(0); // Root label

    // QTYPE
    query.extend_from_slice(&record_type.to_be_bytes());

    // QCLASS = IN (1)
    query.extend_from_slice(&1u16.to_be_bytes());

    query
}

/// Parse a DNS response and extract IP addresses.
/// Returns a vector of IP address strings.
pub fn parse_response(response: &[u8], record_type: u16) -> Vec<String> {
    if response.len() < 12 {
        return Vec::new();
    }

    let qdcount = u16::from_be_bytes([response[4], response[5]]) as usize;
    let ancount = u16::from_be_bytes([response[6], response[7]]) as usize;

    // Skip header
    let mut offset = 12usize;

    // Skip questions
    for _ in 0..qdcount {
        if !skip_name(response, &mut offset) {
            return Vec::new();
        }
        offset += 4; // QTYPE + QCLASS
    }

    // Parse answers
    let mut ips = Vec::new();
    for _ in 0..ancount {
        if offset >= response.len() {
            break;
        }

        // Skip name (may be compressed)
        if !skip_name(response, &mut offset) {
            break;
        }

        if offset + 10 > response.len() {
            break;
        }

        let rtype = u16::from_be_bytes([response[offset], response[offset + 1]]);
        offset += 2; // TYPE
        offset += 2; // CLASS
        offset += 4; // TTL
        let rdlen = u16::from_be_bytes([response[offset], response[offset + 1]]) as usize;
        offset += 2; // RDLENGTH

        if offset + rdlen > response.len() {
            break;
        }

        if rtype == record_type {
            match record_type {
                1 if rdlen == 4 => {
                    // A record
                    ips.push(format!(
                        "{}.{}.{}.{}",
                        response[offset],
                        response[offset + 1],
                        response[offset + 2],
                        response[offset + 3]
                    ));
                }
                28 if rdlen == 16 => {
                    // AAAA record
                    let mut segments = Vec::with_capacity(8);
                    for i in 0..8 {
                        let seg = u16::from_be_bytes([
                            response[offset + i * 2],
                            response[offset + i * 2 + 1],
                        ]);
                        segments.push(format!("{:x}", seg));
                    }
                    ips.push(segments.join(":"));
                }
                _ => {}
            }
        }

        offset += rdlen;
    }

    ips
}

/// Skip a DNS name (handles label compression with pointer bytes)
fn skip_name(data: &[u8], offset: &mut usize) -> bool {
    let mut jumped = false;
    let mut iterations = 0;

    loop {
        if iterations > 128 || *offset >= data.len() {
            return false;
        }
        iterations += 1;

        let len = data[*offset];
        if len == 0 {
            if !jumped {
                *offset += 1;
            }
            return true;
        }
        if (len & 0xC0) == 0xC0 {
            // Pointer — skip 2 bytes and stop advancing
            if !jumped {
                *offset += 2;
            }
            return true;
        }
        *offset += 1 + len as usize;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_query_a() {
        let q = encode_query("example.com", 1);
        // Should start with tx id, flags, qdcount=1
        assert_eq!(q[4], 0); // QDCOUNT high
        assert_eq!(q[5], 1); // QDCOUNT low
        // Domain encoding: 7example3com0
        assert_eq!(q[12], 7); // "example" length
        assert_eq!(&q[13..20], b"example");
        assert_eq!(q[20], 3); // "com" length
        assert_eq!(&q[21..24], b"com");
        assert_eq!(q[24], 0); // root label
    }

    #[test]
    fn test_encode_query_aaaa() {
        let q = encode_query("test.org", 28);
        // QTYPE should be 28 (AAAA) at the end
        let qlen = q.len();
        assert_eq!(q[qlen - 4], 0);
        assert_eq!(q[qlen - 3], 28);
    }
}
