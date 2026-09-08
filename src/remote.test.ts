import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, fetchRemoteFile, isPrivateAddress } from "./remote.js";

test("private, loopback, link-local and metadata addresses are rejected", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("assertPublicUrl refuses non-http schemes, localhost and private IP literals", async () => {
  await assert.rejects(() => assertPublicUrl("ftp://example.com/a.png"), /Only http and https/);
  await assert.rejects(() => assertPublicUrl("http://localhost:8090/x"), /public host/);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /public host/);
  await assert.rejects(() => assertPublicUrl("http://[::1]/x"), /public host/);
  await assert.rejects(() => assertPublicUrl("not a url"), /Invalid URL/);
  const ok = await assertPublicUrl("https://93.184.216.34/logo.png");
  assert.equal(ok.hostname, "93.184.216.34");
});

test("fetchRemoteFile returns bytes, content type and the filename from the URL", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200, headers: { "content-type": "image/png; charset=binary", "content-length": "3" },
  })) as typeof fetch;
  try {
    const file = await fetchRemoteFile("https://93.184.216.34/assets/logo%20big.png");
    assert.equal(file.filename, "logo big.png");
    assert.equal(file.contentType, "image/png");
    assert.equal(file.bytes.byteLength, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchRemoteFile re-validates redirect targets and enforces the size limit", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })) as typeof fetch;
  try {
    await assert.rejects(() => fetchRemoteFile("https://93.184.216.34/a.png"), /public host/);
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = (async () => new Response(new Uint8Array(10), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(() => fetchRemoteFile("https://93.184.216.34/a.png", 5), /too large/);
  } finally {
    globalThis.fetch = original;
  }
});
