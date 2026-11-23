import { describe, expect, it } from "vitest";
import { ConnectorAuthError, ConnectorValidationError } from "@dsh-connector/core";
import {
  WeComMsgCrypt,
  computeWeComSignature,
  decodeWeComEncodingAesKey,
  extractEncryptedCallbackEnvelope,
  parseWeComXmlFields,
  pkcs7Pad32,
  pkcs7Unpad32,
  verifyWeComSignature,
} from "../src/crypto";

const TEST_TOKEN = "wecom_callback_token_2026";
// Valid 43-char Base64 alphanumeric EncodingAESKey (decodes with '=' to 32 bytes)
const TEST_ENCODING_AES_KEY = "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C";
const TEST_CORP_ID = "ww5823bf96d3bd56c7";

describe("Stage 2: WeCom SHA1 signature & AES-256-CBC 32-byte PKCS#7 cryptography", () => {
  it("validates and decodes 43-char EncodingAESKey into 32-byte key and 16-byte IV", () => {
    const { aesKey, iv } = decodeWeComEncodingAesKey(TEST_ENCODING_AES_KEY);
    expect(aesKey.byteLength).toBe(32);
    expect(iv.byteLength).toBe(16);
    expect(iv.equals(aesKey.subarray(0, 16))).toBe(true);

    expect(() => decodeWeComEncodingAesKey("short")).toThrow(ConnectorValidationError);
    expect(() => decodeWeComEncodingAesKey("invalid-chars-!!!!!!!!!!!!!!!!!!!!!!!!!!!!!")).toThrow(
      ConnectorValidationError,
    );
  });

  it("pads and unpads buffers to 32-byte PKCS#7 blocks and rejects malformed padding", () => {
    for (const size of [0, 1, 15, 16, 31, 32, 33, 64]) {
      const original = Buffer.alloc(size, 0x61);
      const padded = pkcs7Pad32(original);
      expect(padded.byteLength % 32).toBe(0);
      expect(padded.byteLength).toBeGreaterThan(original.byteLength);
      expect(pkcs7Unpad32(padded).equals(original)).toBe(true);
    }

    expect(() => pkcs7Unpad32(Buffer.alloc(0))).toThrow(ConnectorAuthError);
    const badZeroPad = Buffer.alloc(32, 0);
    expect(() => pkcs7Unpad32(badZeroPad)).toThrow(ConnectorAuthError);
    const badOverflowPad = Buffer.alloc(32, 33);
    expect(() => pkcs7Unpad32(badOverflowPad)).toThrow(ConnectorAuthError);
    const inconsistentPad = Buffer.alloc(32, 4);
    inconsistentPad[30] = 5;
    expect(() => pkcs7Unpad32(inconsistentPad)).toThrow(ConnectorAuthError);
  });

  it("computes and verifies SHA1 msg_signature using constant-time comparison", () => {
    const sig = computeWeComSignature(TEST_TOKEN, "1700000000", "nonce_abc", "cipher_payload");
    expect(sig).toMatch(/^[0-9a-f]{40}$/);
    expect(verifyWeComSignature(sig, TEST_TOKEN, "1700000000", "nonce_abc", "cipher_payload")).toBe(
      true,
    );
    expect(verifyWeComSignature(sig, TEST_TOKEN, "1700000001", "nonce_abc", "cipher_payload")).toBe(
      false,
    );
    expect(verifyWeComSignature("short", TEST_TOKEN, "1700000000", "nonce_abc", "x")).toBe(false);
  });

  it("round-trips GET echostr URL verification and POST XML/JSON encryption & decryption", () => {
    const appCrypt = new WeComMsgCrypt({
      token: TEST_TOKEN,
      encodingAesKey: TEST_ENCODING_AES_KEY,
      receiveId: TEST_CORP_ID,
    });

    const echoCipher = appCrypt.encrypt("echo_plain_987654");
    const timestamp = "1700000123";
    const nonce = "nonce_xyz";
    const echoSig = appCrypt.sign(timestamp, nonce, echoCipher);

    const verifiedEcho = appCrypt.verifyUrl({
      msgSignature: echoSig,
      timestamp,
      nonce,
      echostr: echoCipher,
    });
    expect(verifiedEcho).toEqual({
      message: "echo_plain_987654",
      receiveId: TEST_CORP_ID,
    });

    // Rejects tampered signature
    expect(() =>
      appCrypt.verifyUrl({
        msgSignature: "0".repeat(40),
        timestamp,
        nonce,
        echostr: echoCipher,
      }),
    ).toThrow(ConnectorAuthError);

    // Rejects mismatched receiveId
    const wrongCorpCrypt = new WeComMsgCrypt({
      token: TEST_TOKEN,
      encodingAesKey: TEST_ENCODING_AES_KEY,
      receiveId: "ww_other_corp",
    });
    expect(() =>
      wrongCorpCrypt.verifyUrl({
        msgSignature: echoSig,
        timestamp,
        nonce,
        echostr: echoCipher,
      }),
    ).toThrow(ConnectorAuthError);

    // Intelligent Bot mode uses empty receiveId ("") and JSON envelope
    const aibotCrypt = new WeComMsgCrypt({
      token: TEST_TOKEN,
      encodingAesKey: TEST_ENCODING_AES_KEY,
      receiveId: "",
    });
    const plainJson = JSON.stringify({
      msgid: "msg_1",
      aibotid: "bot_1",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "你好企业微信智能机器人 🚀" },
    });
    const encryptedJsonEnvelope = aibotCrypt.encryptReply({
      plaintext: plainJson,
      timestamp,
      nonce,
      format: "json",
    });
    const extractedJson = extractEncryptedCallbackEnvelope(encryptedJsonEnvelope);
    expect(extractedJson?.format).toBe("json");
    const decryptedJson = aibotCrypt.decryptCallback({
      msgSignature: extractedJson!.msgSignature!,
      timestamp: extractedJson!.timestamp!,
      nonce: extractedJson!.nonce!,
      encrypt: extractedJson!.encrypt,
    });
    expect(decryptedJson.receiveId).toBe("");
    expect(JSON.parse(decryptedJson.message)).toMatchObject({
      msgid: "msg_1",
      text: { content: "你好企业微信智能机器人 🚀" },
    });

    // Self-built app XML envelope round-trip
    const plainXml = `<xml><ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName><FromUserName><![CDATA[lisi]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[测试XML加解密]]></Content><MsgId>42</MsgId></xml>`;
    const encryptedXmlEnvelope = appCrypt.encryptReply({
      plaintext: plainXml,
      timestamp,
      nonce,
      format: "xml",
    });
    const extractedXml = extractEncryptedCallbackEnvelope(encryptedXmlEnvelope);
    expect(extractedXml?.format).toBe("xml");
    const decryptedXml = appCrypt.decryptCallback({
      msgSignature: extractedXml!.msgSignature!,
      timestamp: extractedXml!.timestamp!,
      nonce: extractedXml!.nonce!,
      encrypt: extractedXml!.encrypt,
    });
    expect(parseWeComXmlFields(decryptedXml.message)).toMatchObject({
      ToUserName: TEST_CORP_ID,
      FromUserName: "lisi",
      MsgType: "text",
      Content: "测试XML加解密",
      MsgId: "42",
    });
  });

  it("rejects corrupted ciphertexts and invalid envelopes cleanly", () => {
    const crypt = new WeComMsgCrypt({
      token: TEST_TOKEN,
      encodingAesKey: TEST_ENCODING_AES_KEY,
      receiveId: "",
    });
    expect(() => crypt.decrypt("")).toThrow(ConnectorAuthError);
    expect(() => crypt.decrypt("YWJj")).toThrow(ConnectorAuthError);
    expect(extractEncryptedCallbackEnvelope("not-xml-or-json")).toBeUndefined();
    expect(extractEncryptedCallbackEnvelope("   ")).toBeUndefined();
    expect(extractEncryptedCallbackEnvelope("[1,2,3]")).toBeUndefined();
    expect(extractEncryptedCallbackEnvelope("{}")).toBeUndefined();
    expect(extractEncryptedCallbackEnvelope("<xml><Foo>bar</Foo></xml>")).toBeUndefined();
    expect(
      () => new WeComMsgCrypt({ token: "   ", encodingAesKey: TEST_ENCODING_AES_KEY }),
    ).toThrow(ConnectorValidationError);
    // Corrupted AES block triggers decipher error -> ConnectorAuthError
    expect(() => crypt.decrypt(Buffer.alloc(32, 0xff).toString("base64"))).toThrow(
      ConnectorAuthError,
    );
    // Post callback signature mismatch
    expect(() =>
      crypt.decryptCallback({
        msgSignature: "0".repeat(40),
        timestamp: "1",
        nonce: "2",
        encrypt: crypt.encrypt("hi"),
      }),
    ).toThrow(ConnectorAuthError);
  });
});
