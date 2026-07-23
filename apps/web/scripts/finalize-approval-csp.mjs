import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const buildDir = resolve('build');
const htmlPath = resolve(buildDir, 'index.html');
const headersPath = resolve(buildDir, '_headers');
const marker = '__RBOX_SPA_BOOTSTRAP_HASH__';

const html = await readFile(htmlPath, 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
	.map((match) => match[1])
	.filter((script) => script.trim().length > 0);

if (inlineScripts.length !== 1) {
	throw new Error(`expected one inline SPA bootstrap script, found ${inlineScripts.length}`);
}

const hash = createHash('sha256').update(inlineScripts[0]).digest('base64');
const headers = await readFile(headersPath, 'utf8');
const markerCount = headers.split(marker).length - 1;
if (markerCount !== 1) {
	throw new Error(`expected one approval CSP hash marker, found ${markerCount}`);
}

await writeFile(headersPath, headers.replace(marker, `sha256-${hash}`));
