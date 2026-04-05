/**
 * encrypt.js - Encrypt a video file with AES-256-GCM
 *
 * Usage: node encrypt.js <input-video> [output-file]
 * Example: node encrypt.js video.mp4 video.enc
 *
 * Generates:
 *   - <output>.enc  — encrypted video file
 *   - <output>.key  — JSON with key + IV (keep this SECRET on server)
 */

import { createCipheriv, randomBytes } from "crypto";
import { createReadStream, writeFileSync, statSync } from "fs";
import { basename } from "path";

async function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3] || inputFile?.replace(/\.\w+$/, ".enc");

  if (!inputFile) {
    console.error("Usage: node encrypt.js <input-video> [output-file]");
    console.error("Example: node encrypt.js video.mp4 video.enc");
    process.exit(1);
  }

  const key = randomBytes(32);
  const iv = randomBytes(12);

  console.log(`Encrypting: ${inputFile}`);
  console.log(`Output: ${outputFile}`);

  const inputSize = statSync(inputFile).size;
  console.log(`Input size: ${(inputSize / 1024 / 1024).toFixed(1)} MB`);

  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const chunks = [];

  await new Promise((resolve, reject) => {
    cipher.on("data", (chunk) => chunks.push(chunk));
    cipher.on("end", resolve);
    cipher.on("error", reject);

    const input = createReadStream(inputFile);
    input.on("data", (chunk) => cipher.write(chunk));
    input.on("end", () => cipher.end());
    input.on("error", reject);
  });

  const authTag = cipher.getAuthTag();
  const encryptedData = Buffer.concat(chunks);
  const finalOutput = Buffer.concat([authTag, encryptedData]);
  writeFileSync(outputFile, finalOutput);

  const keyFile = outputFile.replace(/\.enc$/, ".key");
  const keyInfo = {
    key: key.toString("base64"),
    iv: iv.toString("base64"),
    authTagLength: 16,
    algorithm: "aes-256-gcm",
    originalSize: inputSize,
    encryptedSize: finalOutput.length,
    originalFile: basename(inputFile),
  };

  writeFileSync(keyFile, JSON.stringify(keyInfo, null, 2));

  console.log(`\nEncrypted: ${outputFile} (${(finalOutput.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Key file: ${keyFile} (KEEP THIS SECRET)`);
  console.log("\nDone! Run the server:");
  console.log(`  npm start`);
}

main().catch((e) => { console.error(e); process.exit(1); });
