"""Key exchange without authentication: Diffie-Hellman with a man in the middle.

Alice and the bank agree on a key over a network Mallory controls. Diffie-Hellman keeps the key
secret from anyone who only listens, but Mallory does not only listen: she runs one exchange with
Alice and another with the bank, and relays between them. Standard library only.
"""

import hashlib
import hmac
import secrets


def keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    """A toy stream cipher, SHA-256(key | nonce | counter), so the demo needs only the standard
    library. Real TLS uses AES-GCM or ChaCha20-Poly1305. Teaching code: never use this cipher."""
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(key + nonce + counter.to_bytes(8, "big")).digest()
        counter += 1
    return bytes(out[:length])


def encrypt(key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(plaintext, keystream(key, nonce, len(plaintext))))


decrypt = encrypt  # XOR with the same keystream undoes itself

# RFC 3526 group 14: a 2048-bit prime p and generator g = 2. Everyone knows these.
P = int(
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD"
    "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F"
    "83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B"
    "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510"
    "15728E5A8AACAA68FFFFFFFFFFFFFFFF",
    16,
)
G = 2


class Party:
    """One side of a Diffie-Hellman exchange: a secret number, and a public share G^secret mod P."""

    def __init__(self) -> None:
        self.secret = secrets.randbelow(P - 3) + 2
        self.share = pow(G, self.secret, P)

    def key_with(self, their_share: int) -> bytes:
        shared = pow(their_share, self.secret, P)  # both sides reach the same number
        return hashlib.sha256(shared.to_bytes(256, "big")).digest()


def seal(key: bytes, plaintext: bytes) -> tuple[bytes, bytes, bytes]:
    nonce = secrets.token_bytes(12)
    body = encrypt(key, nonce, plaintext)
    return nonce, body, hmac.new(key, nonce + body, hashlib.sha256).digest()


def open_sealed(key: bytes, nonce: bytes, body: bytes, tag: bytes) -> bytes:
    if not hmac.compare_digest(tag, hmac.new(key, nonce + body, hashlib.sha256).digest()):
        raise ValueError("tag does not match")
    return decrypt(key, nonce, body)


def main() -> None:
    alice, bank, mallory_a, mallory_b = Party(), Party(), Party(), Party()

    # Alice sends her share towards the bank. Mallory keeps it and sends her own instead.
    # The bank replies with its share. Mallory keeps that too and sends Alice another of her own.
    alice_key = alice.key_with(mallory_a.share)  # Alice believes this is the bank's share
    bank_key = bank.key_with(mallory_b.share)  # the bank believes this is Alice's share
    mallory_key_alice = mallory_a.key_with(alice.share)
    mallory_key_bank = mallory_b.key_with(bank.share)

    print("Key fingerprints (first 8 bytes of each key):")
    print(f"  Alice:   {alice_key[:8].hex()}    Mallory's copy: {mallory_key_alice[:8].hex()}")
    print(f"  Bank:    {bank_key[:8].hex()}    Mallory's copy: {mallory_key_bank[:8].hex()}")
    print("  Alice and the bank hold different keys, and Mallory holds both.\n")

    packet = seal(alice_key, b'{"to": "ravi@okbank", "amount_inr": 100}')
    print("Alice sends an encrypted, integrity-protected payment.")

    seen = open_sealed(mallory_key_alice, *packet)  # Mallory decrypts with Alice's side key...
    print("  Mallory reads:  ", seen.decode())
    forged = seen.replace(b"ravi@okbank", b"mallory@ok").replace(b"100", b"900")
    packet = seal(mallory_key_bank, forged)  # ...and re-seals a new message for the bank

    print("  Bank receives:  ", open_sealed(bank_key, *packet).decode(), "(tag valid)")
    print("\nEvery message was encrypted and every tag checked out. The bank just never")
    print("learned who it was talking to. Comparing the fingerprints over a channel Mallory")
    print("cannot touch would expose her; a certificate is how TLS makes that check automatic.")


if __name__ == "__main__":
    main()
