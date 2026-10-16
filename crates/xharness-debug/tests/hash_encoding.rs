//! Persisted SHA-256 identifiers must survive the digest-array API migration.
use sha2::Digest;
use sha2_legacy::Digest as _;

#[test]
fn hexadecimal_output_preserves_leading_zeroes_and_case() {
    let bytes = [0x00, 0x01, 0x0f, 0x10, 0xa5, 0xff];
    assert_eq!(hex::encode(bytes), "00010f10a5ff");
    assert_eq!(hex::encode_upper(bytes), "00010F10A5FF");
}

#[test]
fn sha256_identifiers_match_the_previous_library_byte_for_byte() {
    for length in [0, 1, 7, 31, 32, 55, 56, 63, 64, 65, 127, 128, 1024, 65536] {
        let input: Vec<_> = (0..length).map(|n| (n * 37 + 11) as u8).collect();
        let digest = sha2::Sha256::digest(&input);
        let legacy = sha2_legacy::Sha256::digest(&input);
        assert_eq!(
            hex::encode(digest),
            format!("{legacy:x}"),
            "length={length}"
        );
        assert_eq!(
            hex::encode_upper(digest),
            format!("{legacy:X}"),
            "length={length}"
        );
    }
    assert_eq!(
        hex::encode(sha2::Sha256::digest(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}
