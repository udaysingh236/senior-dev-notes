// Encryption without integrity: an attacker who cannot read a message can still change it.
//
// The cipher here is a toy stream cipher built from SHA-256, the same as the Python twin. Real TLS
// uses AES-GCM or ChaCha20-Poly1305. The attack works on any stream cipher (and on AES-CTR or
// AES-CBC) used without an integrity check. Teaching code: never use this cipher.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** SHA-256(key | nonce | counter), block after block: unpredictable without the key. */
function keystream(key, nonce, length) {
  const blocks = [];
  for (let counter = 0n; blocks.length * 32 < length; counter++) {
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(counter);
    blocks.push(createHash('sha256').update(Buffer.concat([key, nonce, c])).digest());
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const xor = (data, stream) => Buffer.from(data.map((b, i) => b ^ stream[i]));
export const encrypt = (key, nonce, plaintext) => xor(plaintext, keystream(key, nonce, plaintext.length));
export const decrypt = encrypt; // XOR with the same keystream undoes itself

/** No key needed. ciphertext = plaintext XOR stream, so XOR in (known XOR wanted). */
function attackerRewrite(ciphertext, offset, known, wanted) {
  const edited = Buffer.from(ciphertext);
  for (let i = 0; i < known.length; i++) edited[offset + i] ^= known[i] ^ wanted[i];
  return edited;
}

function main() {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const message = Buffer.from('{"to": "ravi@okbank", "amount_inr": 100}');
  const offset = message.indexOf('100'); // the API format is public, so the attacker knows where the amount sits
  const [known, wanted] = [Buffer.from('100'), Buffer.from('900')];

  console.log('1. Encryption only');
  const ciphertext = encrypt(key, nonce, message);
  console.log('   on the wire:   ', ciphertext.toString('hex').slice(0, 48) + '...');
  const tampered = attackerRewrite(ciphertext, offset, known, wanted);
  console.log('   bank decrypts: ', decrypt(key, nonce, tampered).toString());
  console.log('   The attacker never had the key, and nothing looked wrong.\n');

  console.log('2. Encryption plus an integrity tag (encrypt-then-MAC)');
  const macKey = randomBytes(32);
  const mac = (body) => createHmac('sha256', macKey).update(Buffer.concat([nonce, body])).digest();
  const tag = mac(ciphertext);
  for (const [label, body] of [['original', ciphertext], ['tampered', tampered]]) {
    const ok = timingSafeEqual(tag, mac(body)); // constant-time comparison
    console.log(`   ${label}: ${ok ? decrypt(key, nonce, body).toString() : 'REJECTED: tag does not match'}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(); // run only when executed, not imported
