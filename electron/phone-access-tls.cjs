"use strict";

/**
 * Phone access TLS (mobile fork). The gateway serves HTTPS only, with a
 * self-signed certificate that this file makes once and keeps in userData.
 * The phone does not trust a CA: it pins the SHA-256 of the certificate's
 * public key (SPKI), which it gets from the pairing QR code.
 *
 * The certificate is made with node:crypto and a small DER writer, so the
 * packaged shell needs no extra dependency (see electron-builder.yml).
 *
 * Files in `dir`: key.pem (mode 0600) and cert.pem. A missing or damaged
 * pair makes a new key and certificate. A new key has a new pin, so every
 * paired phone must pair again.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KEY_FILE = "key.pem";
const CERT_FILE = "cert.pem";
const COMMON_NAME = "LearnHarness Phone Access";
const VALID_YEARS = 20;

// ---- Minimal DER writer (only what an X.509 v3 certificate needs) ----

function derLength(length) {
	if (length < 0x80) return Buffer.from([length]);
	const bytes = [];
	for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...contents) {
	const body = Buffer.concat(contents);
	return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...items) => tlv(0x30, ...items);
const set = (...items) => tlv(0x31, ...items);
const explicit = (n, item) => tlv(0xa0 + n, item);
const octetString = (bytes) => tlv(0x04, bytes);
const bitString = (bytes) => tlv(0x03, Buffer.from([0]), bytes);
const utf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0]));

/** A non-negative INTEGER from raw big-endian bytes. */
function integer(bytes) {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0 && bytes[start + 1] < 0x80) start++;
	const trimmed = bytes.subarray(start);
	return tlv(0x02, trimmed[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted) {
	const parts = dotted.split(".").map(Number);
	const out = [40 * parts[0] + parts[1]];
	for (const part of parts.slice(2)) {
		const bytes = [part & 0x7f];
		for (let n = part >> 7; n > 0; n >>= 7) bytes.unshift(0x80 | (n & 0x7f));
		out.push(...bytes);
	}
	return tlv(0x06, Buffer.from(out));
}

/** RFC 5280: UTCTime before 2050, GeneralizedTime from 2050. */
function time(date) {
	const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"; // YYYYMMDDHHMMSSZ
	return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), "ascii")) : tlv(0x18, Buffer.from(iso, "ascii"));
}

const ECDSA_WITH_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function extension(id, critical, value) {
	return critical ? seq(oid(id), bool(true), octetString(value)) : seq(oid(id), octetString(value));
}

/** Make a P-256 key and a self-signed certificate for it. Returns PEM text. */
function createCertificate({ now = new Date() } = {}) {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
	const name = seq(set(seq(oid("2.5.4.3"), utf8(COMMON_NAME))));
	const serial = crypto.randomBytes(16);
	serial[0] &= 0x7f;
	const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000); // allow for a slow clock
	const notAfter = new Date(now.getTime());
	notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALID_YEARS);
	const extensions = seq(
		extension("2.5.29.19", true, seq()), // basicConstraints: not a CA
		extension("2.5.29.15", true, tlv(0x03, Buffer.from([7, 0x80]))), // keyUsage: digitalSignature
		extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage: serverAuth
	);
	const tbs = seq(
		explicit(0, integer(Buffer.from([2]))), // v3
		integer(serial),
		ECDSA_WITH_SHA256,
		name,
		seq(time(notBefore), time(notAfter)),
		name,
		publicKey.export({ type: "spki", format: "der" }),
		explicit(3, extensions),
	);
	const signature = crypto.sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
	const der = seq(tbs, ECDSA_WITH_SHA256, bitString(signature));
	const body = der.toString("base64").match(/.{1,64}/g).join("\n");
	return {
		key: privateKey.export({ type: "pkcs8", format: "pem" }),
		cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
	};
}

/** The pin the phone checks: "sha256/" + base64 of SHA-256(SPKI DER). */
function spkiPin(cert) {
	const spki = new crypto.X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
	return `sha256/${crypto.createHash("sha256").update(spki).digest("base64")}`;
}

/** Throws when the pair cannot serve TLS (damaged file, other key, other key type). */
function checkPair(key, cert) {
	const x509 = new crypto.X509Certificate(cert);
	const privateKey = crypto.createPrivateKey(key);
	if (!x509.checkPrivateKey(privateKey)) throw new Error("the certificate does not match the key");
	if (x509.publicKey.asymmetricKeyType !== "ec" || x509.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("the key is not P-256");
	if (!x509.verify(x509.publicKey)) throw new Error("the certificate signature is not valid");
}

function writePrivate(file, text, mode) {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, text, { mode });
	fs.chmodSync(tmp, mode); // writeFileSync applies the umask
	fs.renameSync(tmp, file);
}

/**
 * Load the gateway certificate from `dir`, or make a new one.
 * @returns {{key: string, cert: string, pin: string, created: boolean}}
 */
function loadOrCreateCertificate(dir, { log = () => {} } = {}) {
	const keyFile = path.join(dir, KEY_FILE);
	const certFile = path.join(dir, CERT_FILE);
	try {
		const key = fs.readFileSync(keyFile, "utf8");
		const cert = fs.readFileSync(certFile, "utf8");
		checkPair(key, cert);
		if ((fs.statSync(keyFile).mode & 0o077) !== 0) fs.chmodSync(keyFile, 0o600);
		return { key, cert, pin: spkiPin(cert), created: false };
	} catch (err) {
		if (err.code !== "ENOENT") log(`phone access: certificate not usable (${err.message}); making a new one`);
	}
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const { key, cert } = createCertificate();
	writePrivate(keyFile, key, 0o600);
	writePrivate(certFile, cert, 0o644);
	return { key, cert, pin: spkiPin(cert), created: true };
}

module.exports = { createCertificate, loadOrCreateCertificate, spkiPin, checkPair };
