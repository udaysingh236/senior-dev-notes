// Key exchange without authentication: Diffie-Hellman with a man in the middle.
//
// Alice and the bank agree on a key over a network Mallory controls. Diffie-Hellman keeps the key
// secret from anyone who only listens, but Mallory does not only listen: she runs one exchange with
// Alice and another with the bank, and relays between them. Standard library only.
import { createHash, createHmac, getDiffieHellman, randomBytes, timingSafeEqual } from 'node:crypto';
import { decrypt, encrypt } from './bit-flip.mjs';

/** One side of a Diffie-Hellman exchange in RFC 3526 group 14 (2048-bit prime, generator 2). */
function party() {
  const dh = getDiffieHellman('modp14');
  const share = dh.generateKeys(); // G^secret mod P; the secret stays inside dh
  const keyWith = (theirShare) => createHash('sha256').update(dh.computeSecret(theirShare)).digest();
  return { share, keyWith };
}

function seal(key, plaintext) {
  const nonce = randomBytes(12);
  const body = encrypt(key, nonce, plaintext);
  return { nonce, body, tag: createHmac('sha256', key).update(Buffer.concat([nonce, body])).digest() };
}

function open(key, { nonce, body, tag }) {
  const expected = createHmac('sha256', key).update(Buffer.concat([nonce, body])).digest();
  if (!timingSafeEqual(tag, expected)) throw new Error('tag does not match');
  return decrypt(key, nonce, body);
}

const [alice, bank, mallory_a, mallory_b] = [party(), party(), party(), party()];

// Alice sends her share towards the bank. Mallory keeps it and sends her own instead.
// The bank replies with its share. Mallory keeps that too and sends Alice another of her own.
const aliceKey = alice.keyWith(mallory_a.share); // Alice believes this is the bank's share
const bankKey = bank.keyWith(mallory_b.share); // the bank believes this is Alice's share
const malloryKeyAlice = mallory_a.keyWith(alice.share);
const malloryKeyBank = mallory_b.keyWith(bank.share);

const fp = (k) => k.subarray(0, 8).toString('hex');
console.log('Key fingerprints (first 8 bytes of each key):');
console.log(`  Alice:   ${fp(aliceKey)}    Mallory's copy: ${fp(malloryKeyAlice)}`);
console.log(`  Bank:    ${fp(bankKey)}    Mallory's copy: ${fp(malloryKeyBank)}`);
console.log('  Alice and the bank hold different keys, and Mallory holds both.\n');

let packet = seal(aliceKey, Buffer.from('{"to": "ravi@okbank", "amount_inr": 100}'));
console.log('Alice sends an encrypted, integrity-protected payment.');

const seen = open(malloryKeyAlice, packet).toString(); // Mallory decrypts with Alice's side key...
console.log('  Mallory reads:  ', seen);
const forged = seen.replace('ravi@okbank', 'mallory@ok').replace('100', '900');
packet = seal(malloryKeyBank, Buffer.from(forged)); // ...and re-seals a new message for the bank

console.log('  Bank receives:  ', open(bankKey, packet).toString(), '(tag valid)');
console.log('\nEvery message was encrypted and every tag checked out. The bank just never');
console.log('learned who it was talking to. Comparing the fingerprints over a channel Mallory');
console.log('cannot touch would expose her; a certificate is how TLS makes that check automatic.');
