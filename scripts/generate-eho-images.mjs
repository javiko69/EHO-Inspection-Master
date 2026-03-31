#!/usr/bin/env node
/**
 * generate-eho-images.mjs
 *
 * Generates EHO allergen mnemonic images using Google Imagen 4 API.
 * Reads prompts from images/prompts/ folder.
 *
 * Usage:
 *   node scripts/generate-eho-images.mjs
 *   node scripts/generate-eho-images.mjs --chunk=620
 *   node scripts/generate-eho-images.mjs --dry-run
 *
 * Requires:
 *   - GOOGLE_IMAGE_API_KEY (hardcoded from NexSpeak .env.local)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ─── Parse Args ───
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace('--', '').split('=');
    return [k, v ?? true];
  })
);

const DRY_RUN = args['dry-run'] === true;
const ONLY_CHUNK = args.chunk ? parseInt(args.chunk) : null;

// ─── API Key ───
function loadApiKey() {
  // Try local .env.local first, then NexSpeak's
  const localEnv = path.join(ROOT, '.env.local');
  const nexspeakEnv = path.join(process.env.HOME || '', 'Desktop/nexspeak-v2/.env.local');
  const envPath = fs.existsSync(localEnv) ? localEnv : nexspeakEnv;

  if (!fs.existsSync(envPath)) {
    console.error('ERROR: No .env.local found. Set GOOGLE_IMAGE_API_KEY.');
    process.exit(1);
  }
  const env = fs.readFileSync(envPath, 'utf-8');
  const match = env.match(/GOOGLE_IMAGE_API_KEY=(.+)/);
  if (!match) {
    console.error('ERROR: GOOGLE_IMAGE_API_KEY not found in', envPath);
    process.exit(1);
  }
  console.log(`   API key from: ${envPath}`);
  return match[1].trim();
}

const API_KEY = loadApiKey();

// ─── Paths ───
const PROMPTS_DIR = path.join(ROOT, 'images/prompts');
const ORIGINALS_DIR = path.join(ROOT, 'images/originals');
const OPTIMIZED_DIR = path.join(ROOT, 'images/optimized');

// ─── Ensure directories ───
fs.mkdirSync(ORIGINALS_DIR, { recursive: true });
fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });

// ─── Load Prompts ───
function loadPrompts() {
  const files = fs.readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.txt'));
  const prompts = [];

  for (const file of files) {
    const match = file.match(/chunk_(\d+)_(.+)\.txt/);
    if (!match) continue;

    const chunkId = parseInt(match[1]);
    if (ONLY_CHUNK && chunkId !== ONLY_CHUNK) continue;

    const content = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8');

    // Extract the PROMPT section
    const promptMatch = content.match(/PROMPT:\n([\s\S]*?)(?=\nCOVERAGE:|$)/);
    if (!promptMatch) {
      console.error(`  ⚠️  No PROMPT section found in ${file}`);
      continue;
    }

    const prompt = promptMatch[1].trim();
    const name = match[2];

    prompts.push({
      chunkId,
      name,
      file,
      prompt,
      outputName: `chunk_${chunkId}_${name}`
    });
  }

  return prompts.sort((a, b) => a.chunkId - b.chunkId);
}

// ─── Google Imagen 4 API ───
async function generateImage(prompt, outputPath, retries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1 },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText}`);
      }

      const data = await response.json();

      if (!data.predictions || !data.predictions[0]?.bytesBase64Encoded) {
        throw new Error('No image data in response (prompt may have been filtered)');
      }

      const base64 = data.predictions[0].bytesBase64Encoded;
      const buffer = Buffer.from(base64, 'base64');
      fs.writeFileSync(outputPath, buffer);
      return true;
    } catch (err) {
      console.error(`  ⚠️  Attempt ${attempt}/${retries}: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
}

// ─── Optimize to WebP ───
function optimizeToWebP(originalPath, outputName) {
  const webpPath = path.join(OPTIMIZED_DIR, `${outputName}.webp`);
  const jpgPath = path.join(OPTIMIZED_DIR, `${outputName}.jpg`);

  try {
    // Step 1: Resize to 600px wide using sips (macOS built-in)
    const resizedTmp = path.join(OPTIMIZED_DIR, `_tmp_${outputName}.png`);
    fs.copyFileSync(originalPath, resizedTmp);
    execSync(`sips --resampleWidth 600 "${resizedTmp}" --out "${resizedTmp}" > /dev/null 2>&1`);

    // Step 2: Convert to WebP (quality 80) using cwebp
    execSync(`cwebp -q 80 "${resizedTmp}" -o "${webpPath}" > /dev/null 2>&1`);

    // Step 3: Also create a JPEG fallback using sips
    execSync(`sips -s format jpeg -s formatOptions 80 "${resizedTmp}" --out "${jpgPath}" > /dev/null 2>&1`);

    // Cleanup temp
    fs.unlinkSync(resizedTmp);

    const webpSize = (fs.statSync(webpPath).size / 1024).toFixed(0);
    const jpgSize = (fs.statSync(jpgPath).size / 1024).toFixed(0);
    return { webpSize, jpgSize };
  } catch (err) {
    console.error(`  ⚠️  Optimize failed: ${err.message}`);
    return null;
  }
}

// ─── Main ───
async function main() {
  const prompts = loadPrompts();

  if (prompts.length === 0) {
    console.error('No prompt files found in', PROMPTS_DIR);
    process.exit(1);
  }

  console.log(`\n🎨  EHO Allergen Image Generator`);
  console.log(`   Chunks to generate: ${prompts.length}`);
  console.log(`   Originals: ${ORIGINALS_DIR}`);
  console.log(`   Optimized: ${OPTIMIZED_DIR}\n`);

  if (DRY_RUN) {
    for (const p of prompts) {
      console.log(`  [${p.chunkId}] ${p.name}`);
      console.log(`    File: ${p.outputName}.png`);
      console.log(`    Prompt: ${p.prompt.substring(0, 120)}...\n`);
    }
    process.exit(0);
  }

  let generated = 0;
  let failed = 0;

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const originalPath = path.join(ORIGINALS_DIR, `${p.outputName}.png`);

    // Skip if original already exists
    if (fs.existsSync(originalPath)) {
      console.log(`  [${i + 1}/${prompts.length}] ${p.name} → SKIP (exists)`);
      continue;
    }

    process.stdout.write(`  [${i + 1}/${prompts.length}] chunk_${p.chunkId} ${p.name} `);

    try {
      await generateImage(p.prompt, originalPath);
      const size = (fs.statSync(originalPath).size / 1024).toFixed(0);
      console.log(`✅ ${size}KB`);

      // Auto-optimize to WebP + JPEG
      process.stdout.write(`     → Optimizing... `);
      const opt = optimizeToWebP(originalPath, p.outputName);
      if (opt) {
        console.log(`WebP: ${opt.webpSize}KB | JPEG: ${opt.jpgSize}KB`);
      }

      generated++;
    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
    }

    // Rate limit: 10 seconds between calls
    if (i < prompts.length - 1) {
      process.stdout.write(`  ⏱  Waiting 10s (rate limit)...`);
      await new Promise(r => setTimeout(r, 10000));
      console.log(' GO');
    }
  }

  console.log(`\n🎉 Done! Generated: ${generated}, Failed: ${failed}`);
  console.log(`   Originals in: ${ORIGINALS_DIR}`);
  console.log(`   Optimized in: ${OPTIMIZED_DIR}`);
}

main().catch(err => {
  console.error(`\n💥 Fatal: ${err.message}`);
  process.exit(1);
});
