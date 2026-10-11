// 테스트 localhost 서버의 계약 3 HPKE(RFC 9180) wrapping이다.
// DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305를 사용한다.
const crypto = require('node:crypto');

const KEM_ID = 0x0020, KDF_ID = 0x0001, AEAD_ID = 0x0003;
const u16 = (n) => Buffer.from([n >> 8, n & 0xff]);
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), u16(KEM_ID)]);
const HPKE_SUITE = Buffer.concat([Buffer.from('HPKE'), u16(KEM_ID), u16(KDF_ID), u16(AEAD_ID)]);
const EMPTY = Buffer.alloc(0);

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const extract = (salt, ikm) => hmac(salt.length ? salt : Buffer.alloc(32), ikm);
function expand(prk, info, length) {
  let out = EMPTY, block = EMPTY;
  for (let i = 1; out.length < length; i++) {
    block = hmac(prk, Buffer.concat([block, info, Buffer.from([i])]));
    out = Buffer.concat([out, block]);
  }
  return out.subarray(0, length);
}
const labeledExtract = (suite, salt, label, ikm) =>
  extract(salt, Buffer.concat([Buffer.from('HPKE-v1'), suite, Buffer.from(label), ikm]));
const labeledExpand = (suite, prk, label, info, length) =>
  expand(prk, Buffer.concat([u16(length), Buffer.from('HPKE-v1'), suite, Buffer.from(label), info]), length);

const x25519Private = (raw) => crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
const x25519Public = (raw) => crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]), format: 'der', type: 'spki' });
const rawPublic = (privateKey) => crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);

/** RFC 9180의 X25519 DeriveKeyPair를 재현한다. */
function deriveKeyPair(ikm) {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'dkp_prk', ikm);
  const privateRaw = labeledExpand(KEM_SUITE, prk, 'sk', EMPTY, 32);
  return { privateRaw, publicRaw: rawPublic(x25519Private(privateRaw)) };
}

/** native instance·모델 family·key ID를 HPKE info에 결합한다. */
function modelKeyInfo({ nativeInstanceId, modelId, keyId }) {
  const field = (text) => { const b = Buffer.from(text, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); };
  return Buffer.concat([Buffer.from('tellus-model-key-v1'), field(nativeInstanceId), field(modelId), field(keyId)]);
}

/** enc32·ciphertext32·tag16을 반환한다. ephemeralIkm은 고정 테스트 벡터 재현용이다. */
function wrapContentKey({ recipientPublicKey, contentKey, binding, ephemeralIkm = crypto.randomBytes(32) }) {
  const ephemeral = deriveKeyPair(ephemeralIkm);
  const dh = crypto.diffieHellman({ privateKey: x25519Private(ephemeral.privateRaw), publicKey: x25519Public(recipientPublicKey) });
  const enc = ephemeral.publicRaw;
  const kemContext = Buffer.concat([enc, recipientPublicKey]);
  const sharedSecret = labeledExpand(KEM_SUITE, labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh), 'shared_secret', kemContext, 32);

  const info = modelKeyInfo(binding);
  const context = Buffer.concat([
    Buffer.from([0x00]),
    labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY),
    labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info),
  ]);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', EMPTY);
  const key = labeledExpand(HPKE_SUITE, secret, 'key', context, 32);
  const nonce = labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, 12);

  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(contentKey), cipher.final()]);
  return Buffer.concat([enc, ciphertext, cipher.getAuthTag()]);
}

module.exports = { wrapContentKey };
