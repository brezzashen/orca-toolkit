#!/usr/bin/env node
// Upload an image (from a local file, URL, or macOS clipboard) to Orca's HTTP receiver
// and attach or send it directly in Orca's Chat UI without switching to the Terminal view.
//
// Usage:
//   orca-chat-image <image-path-or-url> [--attach] [--send] [--prompt "text"] [--server <url> | --public | --lan]
//   orca-chat-image --clipboard [--attach] [--send] [--prompt "text"] [--public]

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_LOCAL_SERVER = 'http://127.0.0.1:6768';
// --lan and --public have no built-in target: set these to your own Orca receiver URLs.
const DEFAULT_LAN_SERVER = process.env.ORCA_CHAT_LAN_SERVER || '';
const DEFAULT_PUBLIC_SERVER = process.env.ORCA_CHAT_PUBLIC_SERVER || '';
function requireServer(url, variable) {
  if (!url) throw new Error(`Set ${variable} to your own Orca upload receiver URL first.`);
  return url;
}

function parseArgs(argv) {
  const opts = {
    input: '',
    clipboard: false,
    attach: true,
    send: false,
    noAttach: false,
    prompt: '',
    scopeKey: '',
    tabId: '',
    server: process.env.ORCA_CHAT_UPLOAD_SERVER || DEFAULT_LOCAL_SERVER,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clipboard' || a === '-c') {
      opts.clipboard = true;
    } else if (a === '--send' || a === '-s') {
      opts.send = true;
      opts.attach = true;
    } else if (a === '--attach' || a === '-a') {
      opts.attach = true;
    } else if (a === '--no-attach') {
      opts.noAttach = true;
      opts.attach = false;
    } else if (a === '--public') {
      opts.server = requireServer(DEFAULT_PUBLIC_SERVER, 'ORCA_CHAT_PUBLIC_SERVER');
    } else if (a === '--lan') {
      opts.server = requireServer(DEFAULT_LAN_SERVER, 'ORCA_CHAT_LAN_SERVER');
    } else if (a === '--local') {
      opts.server = DEFAULT_LOCAL_SERVER;
    } else if ((a === '--prompt' || a === '-p') && argv[i + 1] !== undefined) {
      opts.prompt = argv[++i];
    } else if (a.startsWith('--prompt=')) {
      opts.prompt = a.slice('--prompt='.length);
    } else if ((a === '--server' || a === '-u') && argv[i + 1] !== undefined) {
      opts.server = argv[++i];
    } else if (a.startsWith('--server=')) {
      opts.server = a.slice('--server='.length);
    } else if (a === '--scope-key' && argv[i + 1] !== undefined) {
      opts.scopeKey = argv[++i];
    } else if (a === '--tab-id' && argv[i + 1] !== undefined) {
      opts.tabId = argv[++i];
    } else if (!a.startsWith('-') && !opts.input) {
      opts.input = a;
    }
  }
  if (!opts.input) {
    opts.clipboard = true;
  }
  return opts;
}

function readClipboardPngBuffer() {
  const tmpFile = path.join(os.tmpdir(), `orca-clip-${Date.now()}-${randomUUID()}.png`);
  try {
    const jxa = `
      ObjC.import('AppKit');
      const pb = $.NSPasteboard.generalPasteboard;
      const img = $.NSImage.alloc.initWithPasteboard(pb);
      if (!img || img.isNil()) $.exit(2);
      const tiff = img.TIFFRepresentation;
      if (!tiff || tiff.isNil()) $.exit(2);
      const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
      const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      png.writeToFileAtomically(${JSON.stringify(tmpFile)}, true);
    `;
    execFileSync('osascript', ['-l', 'JavaScript', '-e', jxa], { stdio: 'ignore' });
    if (fs.existsSync(tmpFile)) {
      const buf = fs.readFileSync(tmpFile);
      fs.unlinkSync(tmpFile);
      return buf;
    }
  } catch {}
  try {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch {}
  throw new Error('Clipboard does not contain an image');
}

async function resolveInputBuffer(opts) {
  if (opts.input) {
    if (/^https?:\/\//i.test(opts.input)) {
      const res = await fetch(opts.input);
      if (!res.ok) throw new Error(`Failed to fetch URL (${res.status}): ${opts.input}`);
      const ab = await res.arrayBuffer();
      const urlPath = new URL(opts.input).pathname;
      const name = path.basename(urlPath) || 'remote-url.png';
      return { buffer: Buffer.from(ab), fileName: name };
    }
    const resolved = path.resolve(opts.input);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    return {
      buffer: fs.readFileSync(resolved),
      fileName: path.basename(resolved),
    };
  }
  return {
    buffer: readClipboardPngBuffer(),
    fileName: 'clipboard-image.png',
  };
}

async function uploadToOrcaServer(opts, buffer, fileName) {
  const baseUrl = opts.server.replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/orca-chat-upload')
    ? baseUrl
    : `${baseUrl}/orca-chat-upload`;

  const base64 = buffer.toString('base64');
  const uploadId = `cli-${Date.now()}-${randomUUID()}`;
  const chunkSize = 384 * 1024; // Safe under nginx 1MB client_max_body_size

  if (base64.length <= chunkSize) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentBase64: base64,
        fileName,
        mimeType: 'image/png',
        attach: !opts.noAttach && opts.attach,
        send: opts.send,
        prompt: opts.prompt,
        ...(opts.scopeKey ? { scopeKey: opts.scopeKey } : {}),
        ...(opts.tabId ? { tabId: opts.tabId } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Upload failed with HTTP ${res.status} at ${endpoint}`);
    }
    return res.json();
  }

  let lastResult = null;
  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    const isLast = offset + chunkSize >= base64.length;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        offset,
        chunkBase64: base64.slice(offset, offset + chunkSize),
        commit: isLast,
        fileName,
        mimeType: 'image/png',
        attach: isLast ? !opts.noAttach && opts.attach : false,
        send: isLast ? opts.send : false,
        prompt: isLast ? opts.prompt : '',
        ...(isLast && opts.scopeKey ? { scopeKey: opts.scopeKey } : {}),
        ...(isLast && opts.tabId ? { tabId: opts.tabId } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Chunk upload failed with HTTP ${res.status} at offset ${offset}`);
    }
    lastResult = await res.json();
  }
  return lastResult;
}

const opts = parseArgs(process.argv.slice(2));
const { buffer, fileName } = await resolveInputBuffer(opts);
const result = await uploadToOrcaServer(opts, buffer, fileName);
console.log(JSON.stringify(result, null, 2));
