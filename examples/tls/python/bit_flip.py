"""Encryption without integrity: an attacker who cannot read a message can still change it.

The cipher here is a toy stream cipher built from SHA-256 so the example needs only the standard
library. Real TLS uses AES-GCM or ChaCha20-Poly1305. The attack works on any stream cipher (and on
AES-CTR or AES-CBC) used without an integrity check. Teaching code: never use this cipher.
"""

import hashlib
import hmac
import secrets


def keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    """SHA-256(key | nonce | counter), block after block: unpredictable without the key."""
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(key + nonce + counter.to_bytes(8, "big")).digest()
        counter += 1
    return bytes(out[:length])


def xor(data: bytes, stream: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(data, stream))


def encrypt(key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
    return xor(plaintext, keystream(key, nonce, len(plaintext)))


decrypt = encrypt  # XOR with the same keystream undoes itself


def attacker_rewrite(ciphertext: bytes, offset: int, known: bytes, wanted: bytes) -> bytes:
    """No key needed. ciphertext = plaintext XOR stream, so XOR in (known XOR wanted)."""
    patch = xor(known, wanted)
    edited = bytearray(ciphertext)
    for i, p in enumerate(patch):
        edited[offset + i] ^= p
    return bytes(edited)


def main() -> None:
    key, nonce = secrets.token_bytes(32), secrets.token_bytes(12)
    message = b'{"to": "ravi@okbank", "amount_inr": 100}'
    offset = message.index(b"100")  # the API format is public, so the attacker knows where the amount sits

    print("1. Encryption only")
    ciphertext = encrypt(key, nonce, message)
    print("   on the wire:   ", ciphertext.hex()[:48] + "...")
    tampered = attacker_rewrite(ciphertext, offset, b"100", b"900")
    print("   bank decrypts: ", decrypt(key, nonce, tampered).decode())
    print("   The attacker never had the key, and nothing looked wrong.\n")

    print("2. Encryption plus an integrity tag (encrypt-then-MAC)")
    mac_key = secrets.token_bytes(32)
    tag = hmac.new(mac_key, nonce + ciphertext, hashlib.sha256).digest()
    tampered = attacker_rewrite(ciphertext, offset, b"100", b"900")
    for label, body in (("original", ciphertext), ("tampered", tampered)):
        expected = hmac.new(mac_key, nonce + body, hashlib.sha256).digest()
        ok = hmac.compare_digest(tag, expected)  # constant-time comparison
        verdict = decrypt(key, nonce, body).decode() if ok else "REJECTED: tag does not match"
        print(f"   {label}: {verdict}")


if __name__ == "__main__":
    main()
